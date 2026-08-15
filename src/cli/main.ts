#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
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
  formatInstanceStatusTable,
  loadLiveInstanceStatus,
  removeInstanceSnapshotSync,
  writeCurrentInstanceSnapshot,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
} from "../core/instance-registry.js";
import {
  configureOpenTabsPath,
  noteTabOpened,
  openTabsFile,
} from "../core/open-tabs-store.js";
import { runSessionCatalogWorkerCommand } from "../core/session-catalog.js";
import { startPeerTabSync } from "../core/peer-tab-sync.js";
import { loadStateFile, saveStateFile, scopedStateDir, stateFileForPort } from "../core/state-store.js";
import type { MixCodeState } from "../core/types.js";
import { createMixCodeTui } from "../ui/app.js";
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
import { configureHttpDispatcher, getAgentDir } from "@earendil-works/pi-coding-agent";

/**
 * Root that contains built-in packages (`pi-packages/` in dev, `packages/` in
 * binary runtime). Prefer this install's tree when it has packages; only then
 * fall back to PI_PACKAGE_DIR (binary materialize path).
 */
export function resolveMixcodePackageRoot(selfRoot: string, env = process.env): string {
  // Directory existence: Bun.file().exists() is file-only.
  if (
    fs.existsSync(path.join(selfRoot, "pi-packages")) ||
    fs.existsSync(path.join(selfRoot, "packages"))
  ) {
    return selfRoot;
  }
  const fromEnv = env.PI_PACKAGE_DIR?.trim();
  if (
    fromEnv &&
    (fs.existsSync(path.join(fromEnv, "pi-packages")) ||
      fs.existsSync(path.join(fromEnv, "packages")))
  ) {
    return fromEnv;
  }
  return selfRoot;
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  if (await runSessionCatalogWorkerCommand(rawArgs)) return;
  // Configure undici's global dispatcher before provider SDKs issue requests.
  // Runtime settings are applied once SettingsManager has loaded global/project settings.
  configureHttpDispatcher();
  exposeLocalPiCli();
  // Built-in package install root is MixCode's own tree (pi-packages/ or packages/),
  // not Pi's PI_PACKAGE_DIR. Host shells often still export PI_PACKAGE_DIR from a
  // previous mixcode binary runtime; using it here would overwrite agent extensions
  // with that stale tree and also break Pi theme paths if forced to the git root.
  const selfRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const packageRoot = resolveMixcodePackageRoot(selfRoot);
  if (shouldDelegateToRealPiCli(rawArgs, Boolean(process.stdin.isTTY))) {
    process.exitCode = await delegateToRealPiCli(rawArgs);
    return;
  }
  process.env.MIXCODE ??= "1";
  const args = parseMainArgs(rawArgs, cwd());
  if (args.command === "status") {
    await runStatusCommand(args);
    return;
  }
  // dry-run never boots the TUI/runtime — only load models + existing state snapshot.
  if (args.batchDryRun) {
    await runBatchDryRun(args);
    return;
  }
  // Relocate console.{log,warn,error,...} onto the TUI before any extension can
  // log. Installed after the status early-return so plain CLI subcommands keep
  // printing to the real stdout; the sink is wired once the TUI exists below.
  installConsoleTuiBridge();
  // Install built-in packages under the same effective agent dir Pi's
  // ResourceLoader scans, so discovery and installation share one root.
  const agentDir = getAgentDir();
  const builtinExtensionPaths = ensurePackageExtensions(packageRoot, {
    copy: true,
    agentDir,
  });
  const {
    state,
    runtime,
    stateFile,
    workspaceFile,
    rootStateDir,
    completionSources,
    packageUpdateCheck,
    tabsReady,
    historyReady,
    settingsDeps,
  } = await bootstrapMixCode({
    workdir: args.workdir,
    ...(args.builtinExtensionsOnly
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
  const writeRegistrySnapshot = async () => {
    try {
      await writeCurrentInstanceSnapshot(stateRoot, state);
    } catch (error) {
      reportRegistryWriteError(error);
    }
  };
  const heartbeat = setInterval(writeRegistrySnapshot, INSTANCE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  let scheduledRegistrySnapshot: NodeJS.Timeout | undefined;
  const scheduleRegistrySnapshot = () => {
    if (scheduledRegistrySnapshot) return;
    scheduledRegistrySnapshot = setTimeout(() => {
      scheduledRegistrySnapshot = undefined;
      void writeRegistrySnapshot();
    }, 1_000);
    scheduledRegistrySnapshot.unref?.();
  };
  const removeRegistrySnapshot = () => {
    clearInterval(heartbeat);
    if (scheduledRegistrySnapshot) clearTimeout(scheduledRegistrySnapshot);
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
      await writeRegistrySnapshot();
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
    void writeRegistrySnapshot();
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
      await writeRegistrySnapshot();
      tui.requestRender();
    },
    closeTab: async (sessionId) => {
      // publishClose:false — open_tabs already dropped this id (we are reconciling).
      await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      await writeRegistrySnapshot();
      tui.requestRender();
    },
    syncTabTitles: (titles) => {
      let changed = false;
      for (const { sessionId, title } of titles) {
        const tab = state.tabs.find((candidate) => candidate.sessionId === sessionId);
        if (!tab || tab.title === title) continue;
        tab.title = title;
        changed = true;
      }
      if (changed) tui.requestRender();
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
      await writeRegistrySnapshot();
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
  const originalStop = tui.stop.bind(tui);
  tui.stop = () => {
    peerTabSync.dispose();
    removeRegistrySnapshot();
    originalStop();
  };
  tui.start();
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
  void writeRegistrySnapshot();
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
  // Conversation history backfill / session-index rebuild scans every persisted
  // session file, so it runs in the background after the first frame. Surface
  // any warnings into the first tab once it completes.
  void historyReady
    .then(({ warnings }) => {
      if (warnings.length === 0) return;
      state.tabs[0]?.previewMessages.push({
        role: "system",
        text: `History warning: ${warnings.join("; ")}`,
      });
      tui.requestRender();
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      showNoticeTextOverlay(tui, `History backfill failed: ${msg}`);
      tui.requestRender();
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

export type MainCommand = "tui" | "status";

async function runStatusCommand(args: MainArgs): Promise<void> {
  const report = await loadLiveInstanceStatus(defaultStateDir(), { workdir: args.statusWorkdir });
  const output = args.json ? JSON.stringify(report, null, 2) : formatInstanceStatusTable(report);
  process.stdout.write(`${output}\n`);
}

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

export interface MainArgs {
  command: MainCommand;
  workdir: string;
  batch?: string;
  batchArgs?: string[];
  batchDryRun?: boolean;
  builtinExtensionsOnly?: boolean;
  json?: boolean;
  statusWorkdir?: string;
}

const HELP_TEXT = `Usage: mpi [options] [-- <script-args...>]
       mpi status [--json] [--workdir <path>]

Options:
  --workdir <path>           Set working directory (default: cwd)
  --batch <file>             Execute a Lua batch script after TUI startup
  --batch-dry-run            Load/validate batch script and print plan (no TUI, no session writes)
  --builtin-extensions-only  Load MixCode built-in extensions without discovering third-party extensions
  --help, -h                 Show this help message

  Arguments after -- are passed to the batch script as mixcode.args().

Commands:
  status             Show live mpi instances and tabs
`;

export function parseMainArgs(args: string[], fallbackWorkdir: string): MainArgs {
  const baseWorkdir = path.resolve(fallbackWorkdir);
  if (args[0] === "status") return parseStatusArgs(args.slice(1), baseWorkdir);

  let workdir = baseWorkdir;
  let batchPath: string | undefined;
  let batchDryRun = false;
  let builtinExtensionsOnly = false;
  let batchArgs: string[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (arg === "--") {
      batchArgs = args.slice(index + 1);
      break;
    }
    if (arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error("--workdir requires a path");
      workdir = path.resolve(baseWorkdir, value);
      continue;
    }
    if (arg?.startsWith("--workdir=")) {
      const value = arg.slice("--workdir=".length);
      if (!value) throw new Error("--workdir requires a path");
      workdir = path.resolve(baseWorkdir, value);
      continue;
    }
    if (arg === "--batch") {
      const value = args[++index];
      if (!value) throw new Error("--batch requires a file path");
      batchPath = value;
      continue;
    }
    if (arg?.startsWith("--batch=")) {
      const value = arg.slice("--batch=".length);
      if (!value) throw new Error("--batch requires a file path");
      batchPath = value;
      continue;
    }
    if (arg === "--batch-dry-run") {
      batchDryRun = true;
      continue;
    }
    if (arg === "--builtin-extensions-only") {
      builtinExtensionsOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (batchDryRun && !batchPath) {
    throw new Error("--batch-dry-run requires --batch <file>");
  }
  return {
    command: "tui",
    workdir,
    batch: batchPath ? path.resolve(workdir, batchPath) : undefined,
    batchArgs,
    batchDryRun: batchDryRun || undefined,
    builtinExtensionsOnly: builtinExtensionsOnly || undefined,
  };
}

function parseStatusArgs(args: string[], baseWorkdir: string): MainArgs {
  let json = false;
  let statusWorkdir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error("--workdir requires a path");
      statusWorkdir = path.resolve(baseWorkdir, value);
      continue;
    }
    if (arg?.startsWith("--workdir=")) {
      const value = arg.slice("--workdir=".length);
      if (!value) throw new Error("--workdir requires a path");
      statusWorkdir = path.resolve(baseWorkdir, value);
      continue;
    }
    throw new Error(`Unknown status argument: ${arg}`);
  }
  return { command: "status", workdir: baseWorkdir, json, statusWorkdir };
}

export function exposeLocalPiCli(
  env: NodeJS.ProcessEnv = process.env,
  entryUrl = import.meta.url,
): string {
  const repoDir = path.resolve(path.dirname(fileURLToPath(entryUrl)), "..", "..");
  const binDir = path.resolve(repoDir, "node_modules", ".bin");
  // In bun compiled binary, import.meta.url is a virtual path; skip if dir doesn't exist.
  if (!fs.existsSync(binDir)) return binDir;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!parts.includes(binDir)) {
    env.PATH = [binDir, ...parts].join(delimiter);
  }
  return binDir;
}

/**
 * True when argv explicitly requests pi-coding-agent's own public non-interactive
 * contract: --print/-p, documented as "process prompt and exit" (see `pi --help`).
 * mixcode-pi has no equivalent flag, so this is the one stable, upstream-owned
 * signal that an argv was built for pi's headless contract rather than a human
 * typo or mixcode-pi's own grammar — not a private convention of any one caller.
 *
 * This gate is safety-critical, not just a compatibility nicety: real pi does not
 * actually require --print to run a turn to completion — given non-TTY stdin it
 * will execute a full agentic turn (default tools include write/edit/bash) and
 * exit even without --print. Delegating on "argv merely looks foreign" (e.g. any
 * argv mixcode-pi's own parser rejects) was tried and reverted after confirming it
 * lets an unattended, non-interactive invocation with no special flags at all
 * (`mixcode-pi "some instruction"`, redirected stdin) silently escalate into a
 * live, fully-tooled agent turn. Requiring the explicit --print/-p contract closes
 * that hole: without it, unrecognized argv still surfaces mixcode-pi's own
 * "Unknown argument" error instead of ever reaching a live agent.
 *
 * The isTTY check additionally ensures a human's own typo at an interactive
 * terminal still surfaces mixcode-pi's own error instead of being redirected.
 */
export function shouldDelegateToRealPiCli(args: string[], isTTY: boolean): boolean {
  if (isTTY) return false;
  return args.includes("--print") || args.includes("-p");
}

/**
 * Runs the real pi-coding-agent CLI with the given argv, inheriting stdio so the
 * caller sees the same output/exit-code semantics as spawning upstream `pi`
 * directly. `options.command` defaults to "pi" (resolved via PATH); it is
 * overridable for testing without a real pi installation.
 */
export async function delegateToRealPiCli(
  args: string[],
  options: { command?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const { command = "pi", env = process.env } = options;
  // Binary materialize sets PI_PACKAGE_DIR for in-process Pi assets. Real `pi`
  // must use its own package root so help/identity stay upstream (not mixcode).
  const childEnv = { ...env };
  delete childEnv.PI_PACKAGE_DIR;
  try {
    const child = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv,
    });
    return await child.exited;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");

if (isDirectCliEntry()) {
  main().catch((error) => {
    // Bypass the console bridge here: a startup crash can happen after the bridge
    // is installed but before the TUI sink is wired, which would queue this fatal
    // error into a buffer that never flushes. Write straight to the real stderr.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function isDirectCliEntry(entryUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  if ((globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG]) return false;
  if (!argv1) return false;
  try {
    return fileURLToPath(entryUrl) === fs.realpathSync(argv1);
  } catch {
    return entryUrl === `file://${argv1}`;
  }
}
