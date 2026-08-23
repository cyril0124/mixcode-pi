import * as fs from "node:fs";
import * as path from "node:path";
import {
  applyBatchRequests,
  contextFromState,
  formatBatchPlan,
  loadBatchRequests,
  validateBatchRequests,
} from "../core/batch-lua.js";
import { createInitialState } from "../core/defaults.js";
import {
  buildAvailableModelRefs,
  findModelRef,
  modelToRef,
  registerModels,
} from "../core/models.js";
import { createPiModelRegistryBundle } from "../core/pi-models.js";
import {
  cleanupInstanceRegistry,
  removeInstanceSnapshotSync,
  writeCurrentInstanceSnapshot,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
} from "../core/instance-registry.js";
import {
  configureOpenTabsPath,
  noteTabOpened,
  openTabsFile,
} from "../core/open-tabs-store.js";
import { startInstanceCtlServer, type InstanceCtlServer } from "../core/instance-ctl-server.js";
import { startPeerTabSync } from "../core/peer-tab-sync.js";
import { loadStateFile, saveStateFile, scopedStateDir, stateFileForPort } from "../core/state-store.js";
import type { MixCodeState } from "../core/types.js";
import { createMixCodeTui } from "../ui/app.js";
import { hasCapturingAppOverlay, renderAppOverlay } from "../ui/app-overlays.js";
import { handleSubmittedInput } from "../ui/app-submit.js";
import { closeExistingAgentTab, openExistingAgentTab } from "../ui/agent-tab-actions.js";
import { createBatchExecutorHost } from "./batch-host.js";
import {
  bootstrapMixCode,
  DEFAULT_STATE_PORT,
  defaultStateDir,
} from "./bootstrap.js";
import { ensurePackageExtensions } from "../core/ensure-package-extensions.js";
import { installConsoleTuiBridge, wireConsoleSink } from "./console-tui-bridge.js";
import { showNoticeTextOverlay } from "../ui/app-overlays.js";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { MainArgs } from "./main.js";
import { isBuiltinExtensionsOnlyEnabled, resolveMixcodePackageRoot } from "./main.js";

/**
 * Validate and print a batch plan without booting TUI/runtime or writing state.
 * Reads existing state only if present; never creates session files.
 */
export async function runBatchDryRun(args: MainArgs): Promise<void> {
  if (!args.batch) throw new Error("--batch-dry-run requires --batch <file>");

  const agentDir = getAgentDir();
  const rootStateDir = defaultStateDir();
  const stateDir = scopedStateDir(rootStateDir, args.workdir);
  const stateFile = stateFileForPort(stateDir, DEFAULT_STATE_PORT);

  let state: MixCodeState;
  try {
    state = await loadStateFile(stateFile, args.workdir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    // In-memory only — dry-run must not create first-tab sessions or save state.
    state = createInitialState(args.workdir);
  }

  const modelBundle = await createPiModelRegistryBundle(
    path.join(agentDir, "models.json"),
    path.join(agentDir, "auth.json"),
    { allowModelNetwork: false },
  );
  registerModels(modelBundle.sources.map((source) => source.model));
  const configuredModels = modelBundle.sources
    .filter((source) => source.authStatus.configured)
    .map((source) => modelToRef(source.model));
  state.availableModels = buildAvailableModelRefs(configuredModels);
  const fallbackModel = configuredModels.at(-1) ?? state.model;

  const plan = await loadBatchRequests(args.batch, {
    ...contextFromState(state),
    args: args.batchArgs ?? [],
  });
  validateBatchRequests(
    plan.requests,
    (query) => findModelRef(state.availableModels, query),
    (request) =>
      request.mode === "delete"
        ? fallbackModel
        : (state.tabs.find((tab) => tab.title === request.name)?.model ?? fallbackModel),
  );
  process.stdout.write(`${formatBatchPlan(plan)}\n`);
}

/**
 * Runs the interactive TUI application or batch script execution.
 */
export async function runInteractiveApp(args: MainArgs, selfRoot: string): Promise<void> {
  // dry-run never boots the TUI/runtime — only load models + existing state snapshot.
  if (args.batchDryRun) {
    await runBatchDryRun(args);
    return;
  }

  // Relocate console.{log,warn,error,...} onto the TUI before any extension can
  // log. Installed after the status early-return so plain CLI subcommands keep
  // printing to the real stdout; the sink is wired once the TUI exists below.
  installConsoleTuiBridge();

  const packageRoot = resolveMixcodePackageRoot(selfRoot);
  // Install built-in packages under the same effective agent dir Pi's
  // ResourceLoader scans, so discovery and installation share one root.
  const agentDir = getAgentDir();
  const builtinExtensionPaths = ensurePackageExtensions(packageRoot, {
    agentDir,
  });
  const builtinExtensionsOnly = isBuiltinExtensionsOnlyEnabled(args.builtinExtensionsOnly);
  const {
    state,
    runtime,
    stateFile,
    workspaceFile,
    rootStateDir,
    completionSources,
    packageUpdateCheck,
    tabsReady,
    settingsDeps,
  } = await bootstrapMixCode({
    workdir: args.workdir,
    ...(builtinExtensionsOnly
      ? {
          additionalExtensionPaths: builtinExtensionPaths,
          resourceLoaderOptions: { noExtensions: true },
        }
      : {}),
  });
  const batchPlan = args.batch
    ? await loadBatchRequests(args.batch, {
        ...contextFromState(state),
        args: args.batchArgs ?? [],
      })
    : undefined;
  if (batchPlan) {
    validateBatchRequests(
      batchPlan.requests,
      (query) => findModelRef(state.availableModels, query),
      (request) =>
        request.mode === "delete"
          ? state.model
          : (state.tabs.find((tab) => tab.title === request.name)?.model ?? state.model),
    );
  }
  const stateRoot = defaultStateDir();
  let registryWriteErrorReported = false;
  // Assigned after the TUI exists so registry failures render as a notice
  // instead of corrupting the frame via raw stderr.
  let reportRegistryWriteError = (error: unknown) => {
    if (registryWriteErrorReported) return;
    registryWriteErrorReported = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mpi instance registry update failed: ${message}\n`);
  };
  /** Coalescing window for instance-registry snapshot writes (see scheduleRegistrySnapshot). */
  const REGISTRY_SNAPSHOT_COALESCE_MS = 500;
  let registrySnapshotTimer: NodeJS.Timeout | undefined;
  const scheduleRegistrySnapshot = (): void => {
    // Registry writes are NFS temp+rename (~100ms each, measured under boot
    // load). Runtime/UI change events fire hundreds of times during tab
    // restore; an un-coalesced write per event serializes the whole boot on
    // NFS. Coalesce to one trailing write per window — the write always
    // serializes current state, and the 5s heartbeat keeps updatedAt well
    // inside the 15s liveness threshold. Awaiters resolve after scheduling;
    // saveStateFile remains the awaited persistence path for state changes.
    if (registrySnapshotTimer) return;
    registrySnapshotTimer = setTimeout(() => {
      registrySnapshotTimer = undefined;
      void flushRegistrySnapshot();
    }, REGISTRY_SNAPSHOT_COALESCE_MS);
    registrySnapshotTimer.unref?.();
  };
  const flushRegistrySnapshot = async (): Promise<void> => {
    try {
      await writeCurrentInstanceSnapshot(stateRoot, state);
    } catch (error) {
      reportRegistryWriteError(error);
    }
  };
  // Assigned once the ctl server wiring exists; piggybacks on the heartbeat so
  // a ctl socket lost to a transient NFS bind failure or external deletion is
  // rebound within one interval instead of staying dead for the process life.
  let ensureCtlServer: () => void = () => {};
  // Set once the ctl server and peer tab sync exist. Mutable binding: exit
  // teardown can fire before those consts initialize (early bootstrap
  // failure), so it must not capture them directly.
  let disposeInstanceServices: () => void = () => {};
  const heartbeat = setInterval(() => {
    void scheduleRegistrySnapshot();
    ensureCtlServer();
  }, INSTANCE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  // Process-lifetime teardown, reachable only from exit/SIGINT/SIGTERM. Never
  // attach it to tui.stop(): upstream pi treats stop()/start() as a reversible
  // renderer handoff (external editor from an extension editor overlay,
  // over-width render abort), and start() restores neither the heartbeat, the
  // ctl socket, nor peer sync.
  const removeRegistrySnapshot = () => {
    disposeInstanceServices();
    clearInterval(heartbeat);
    if (registrySnapshotTimer) clearTimeout(registrySnapshotTimer);
    removeInstanceSnapshotSync(stateRoot);
  };
  process.once("exit", (code) => {
    if (code === 0 || code === 130 || code === 143) removeRegistrySnapshot();
  });
  process.once("SIGINT", () => {
    removeRegistrySnapshot();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    removeRegistrySnapshot();
    process.exit(143);
  });

  const tui = createMixCodeTui(state, runtime, {
    completionSources,
    workspaceFile,
    rootStateDir,
    exitProcessOnQuit: true,
    settingsDeps,
    onStateChanged: async (nextState) => {
      await saveStateFile(stateFile, nextState);
      await scheduleRegistrySnapshot();
    },
  });
  // Wire the console bridge to the TUI now that it exists: console output renders
  // as a dismissible Notice panel (Home and agent tabs both safe) and any backlog
  // queued during extension loading flushes here. requestRender is required
  // because scheduler-style logging fires off the input loop.
  wireConsoleSink((text) => {
    showNoticeTextOverlay(tui, text);
    tui.requestRender();
  });
  // From here on, background failures go through the notice panel — raw stderr
  // would corrupt the TUI frame the same way unbridged console.* did.
  reportRegistryWriteError = (error: unknown) => {
    if (registryWriteErrorReported) return;
    registryWriteErrorReported = true;
    const message = error instanceof Error ? error.message : String(error);
    showNoticeTextOverlay(tui, `mpi instance registry update failed: ${message}`);
    tui.requestRender();
  };
  const originalRequestRender = tui.requestRender.bind(tui);
  tui.requestRender = (force?: boolean) => {
    scheduleRegistrySnapshot();
    originalRequestRender(force);
  };
  runtime.onChange(() => {
    void scheduleRegistrySnapshot();
  });
  // Enable cross-process session sync for the interactive TUI: watch this
  // workdir's sessionsRoot for appends by other instances and serialize this
  // instance's session writes with a turn lock. (Batch runs never reach here.)
  runtime.enableSessionSync();
  // Shared open-tab set for this workdir: create/close mutate open_tabs.json;
  // peers reconcile local tabs to match (open missing, close removed).
  const openTabsPath = openTabsFile(path.dirname(stateFile));
  configureOpenTabsPath(openTabsPath);
  for (const tab of state.tabs) noteTabOpened(tab.sessionId);
  let peerTabSyncErrorReported = false;
  const peerTabSync = startPeerTabSync({
    openTabsPath,
    rootStateDir: stateRoot,
    workdir: state.workdir,
    getLocalSessionIds: () => state.tabs.map((tab) => tab.sessionId),
    openTab: async (candidate) => {
      await openExistingAgentTab(state, runtime, {
        sessionId: candidate.sessionId,
        ...(candidate.title ? { title: candidate.title } : {}),
        workdir: candidate.workdir,
      });
      await scheduleRegistrySnapshot();
      tui.requestRender();
    },
    closeTab: async (sessionId) => {
      // publishClose:false — open_tabs already dropped this id (we are reconciling).
      await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      await scheduleRegistrySnapshot();
      tui.requestRender();
    },
    reorderTabs: async (orderedSessionIds) => {
      const currentIds = state.tabs.map((tab) => tab.sessionId);
      const desired = new Set(orderedSessionIds);
      const nextTabs = [
        ...orderedSessionIds.flatMap((id) => {
          const tab = state.tabs.find((candidate) => candidate.sessionId === id);
          return tab ? [tab] : [];
        }),
        // Keep a locally-created tab visible during the short publish window.
        ...state.tabs.filter((tab) => !desired.has(tab.sessionId)),
      ];
      const nextIds = nextTabs.map((tab) => tab.sessionId);
      if (
        currentIds.length === nextIds.length &&
        currentIds.every((id, index) => id === nextIds[index])
      ) {
        return;
      }
      const homeSelectedId = state.tabs[state.homeSelectedTabIndex]?.sessionId;
      state.tabs = nextTabs;
      state.tabs.forEach((tab, index) => {
        tab.index = index + 1;
      });
      if (homeSelectedId) {
        const nextHomeIndex = state.tabs.findIndex((tab) => tab.sessionId === homeSelectedId);
        if (nextHomeIndex >= 0) state.homeSelectedTabIndex = nextHomeIndex;
      }
      await scheduleRegistrySnapshot();
      tui.requestRender();
    },
    onError: (error) => {
      // Missing session files are expected briefly after a peer creates a tab;
      // only surface other errors once so the notice is not spammy.
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith("Peer session not on disk yet:")) return;
      if (peerTabSyncErrorReported) return;
      peerTabSyncErrorReported = true;
      // Route through the TUI notice panel — raw stderr corrupts the frame.
      showNoticeTextOverlay(tui, `mpi peer tab sync error: ${message}`);
      tui.requestRender();
    },
  });
  let ctlServer: InstanceCtlServer | undefined;
  disposeInstanceServices = () => {
    peerTabSync.dispose();
    ctlServer?.dispose();
  };
  tui.start();
  // Ctl server failures (transient NFS errors in the sync fs prep, async bind
  // errors) must neither crash the TUI nor degrade it silently: without this
  // guard a sync throw here unwinds past tui.start() into main().catch, which
  // leaves a working TUI running with no ctl socket and no visible diagnostic.
  // Reported once per outage: ensureCtlServer retries every heartbeat and
  // resets the gate when the socket is confirmed back on disk.
  let ctlServerErrorReported = false;
  const reportCtlServerError = (error: unknown) => {
    if (ctlServerErrorReported) return;
    ctlServerErrorReported = true;
    const message = error instanceof Error ? error.message : String(error);
    showNoticeTextOverlay(tui, `mpi ctl server unavailable: ${message}`);
    tui.requestRender();
  };
  const startCtlServer = () =>
    startInstanceCtlServer({
      rootStateDir: stateRoot,
      state,
      runtime,
      onError: reportCtlServerError,
      injectInput: (data) => tui.injectInput(data),
      submitToTab: (tab, text) =>
        handleSubmittedInput(
          state,
          runtime,
          text,
          tui,
          async (nextState) => {
            await saveStateFile(stateFile, nextState);
          },
          undefined,
          workspaceFile,
          tab,
          settingsDeps,
        ),
      requestRender: () => tui.requestRender(),
      screenWidth: () => tui.terminal.columns,
      renderTui: (width) => tui.render(width),
      hasAppOverlay: () => hasCapturingAppOverlay(tui),
      renderAppOverlay: (width) => renderAppOverlay(tui, width),
    });
  ensureCtlServer = () => {
    // A live server whose socket is still on disk is healthy. The socket file
    // appears asynchronously (listen callback), so right after a start this
    // stays false for one tick and simply re-checks on the next heartbeat.
    if (ctlServer && fs.existsSync(ctlServer.socketPath)) {
      ctlServerErrorReported = false;
      return;
    }
    ctlServer?.dispose();
    ctlServer = undefined;
    try {
      ctlServer = startCtlServer();
    } catch (error) {
      reportCtlServerError(error);
    }
  };
  ensureCtlServer();
  // Registry cleanup and initial snapshot are deferred to after the first frame.
  // They are cheap on their own (~10ms), but their `await` yields the event loop
  // to the deferred background extension loading (CPU-heavy jiti compilation that
  // yields via setImmediate). When awaited before tui.start(), those yields let
  // every tab finish loading before the first frame renders, so the "Not Ready"
  // spinner never shows. Firing them after tui.start() keeps them off the
  // first-frame critical path.
  void cleanupInstanceRegistry(stateRoot).catch((err: unknown) => {
    reportRegistryWriteError(err);
  });
  void scheduleRegistrySnapshot();
  // Stagger package update checks until after tab extension cold-load (tabsReady).
  // Parallel jiti + npm view contends for CPU/network; finally keeps the check
  // even when extension loading fails. Still fire-and-forget for the first frame.
  void tabsReady
    .then(() => {
      tui.requestRender(true);
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      showNoticeTextOverlay(tui, `Extension loading failed: ${msg}`);
      tui.requestRender();
    })
    .finally(() => {
      void packageUpdateCheck()
        .then((packages) => {
          state.packageUpdates = packages;
          tui.requestRender();
        })
        .catch(() => undefined);
    });
  // Execute batch script after TUI is ready
  if (args.batch && batchPlan) {
    const batchHost = createBatchExecutorHost({ state, runtime, tui });
    void tabsReady
      .then(() => applyBatchRequests(batchPlan.requests, batchHost))
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        showNoticeTextOverlay(tui, `Batch error: ${msg}`);
        tui.requestRender();
        process.exitCode = 1;
      })
      .finally(() => saveStateFile(stateFile, state));
  }
}
