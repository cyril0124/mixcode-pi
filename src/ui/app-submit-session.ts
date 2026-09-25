import * as path from "node:path";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { RuntimeTab } from "../agent/runtime.js";
import { type LocalCommand, FOLLOW_UP_BATCH_FLAG, parseInput } from "../core/commands.js";
import { createSessionId, createTab, uniqueTabTitle } from "../core/defaults.js";
import { assertModelEnabled } from "../core/models.js";
import {
  assertConfiguredOpenTabsReadable,
  noteTabClosed,
  noteTabOpened,
  noteTabsReplaced,
} from "../core/open-tabs-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { isTabColorName, TAB_COLOR_NAMES } from "../core/tab-colors.js";
import { activateTab, groupTabsByColor, renameAgentTab, setAgentTabColor } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import {
  closeExistingAgentTab,
  completeAgentTabClear,
  createAgentTab,
  deleteAgentTab,
  type PreparedAgentTabClear,
  prepareAgentTabClear,
  resetAgentTab,
} from "./agent-tab-actions.js";
import {
  appendActiveSystemMessage,
  openCloseAllSessionsConfirm,
  openDeleteAllSessionsConfirm,
  openSessionActionConfirm,
} from "./app-actions.js";
import { showErrorOverlay } from "./app-overlays.js";
import {
  type LocalCommandHandler,
  type MixCodeKeyRuntime,
  type OverlayTui,
  SKIP_FINALIZE,
} from "./app-types.js";
import { renderSessionInfoText as formatSessionInfoText } from "./components/session-info.js";
import { openTreeSelector, type TreeSelectorRuntime } from "./components/tree-selector.js";
import { runCommandConfirmation } from "./queued-command-completion.js";
import {
  openSessionSelector,
  resumeSelectedSession,
  type SessionSelectorRuntime,
} from "./session-resume.js";
import { listTrash, restoreFromTrash } from "../core/session-trash.js";
import { listSessionsForCwd, listAllSessionsGlobal } from "../agent/runtime-session.js";
import { trashDir } from "../core/paths.js";
import { invalidateSessionCatalog } from "../core/session-catalog.js";

const handleFollowUp: LocalCommandHandler = async ({
  active,
  rawArgs,
  runtime,
  submitQueuedInput,
}) => {
  const { batch, message } = parseFollowUpArgs(rawArgs);
  if (batch && !message) {
    throw new Error(`Error: Usage: /follow-up [${FOLLOW_UP_BATCH_FLAG}] <message>`);
  }
  // Queued local commands run through their own validation, so they never need
  // an enabled model and never enter the model queue.
  if (message && parseInput(message).kind === "local-command") {
    if (!submitQueuedInput) throw new Error("Error: Queued commands require an input host");
    await runtime.queueFollowUpCommand(
      active!.sessionId,
      message,
      () => submitQueuedInput(message),
      batch ? "batch" : "next",
    );
    return undefined;
  }
  assertModelEnabled(active!.model);
  if (!message) {
    await runtime.resumeFollowUps(active!.sessionId);
    return undefined;
  }
  await runtime.prompt(active!.sessionId, message, {
    streamingBehavior: "followUp",
    followUpNext: !batch,
  });
  return undefined;
};

/**
 * Split a leading `--batch` flag from the follow-up payload. Only the first
 * token counts: a later occurrence stays in the message, and the flag must be
 * followed by whitespace so `--batchfile` remains message text.
 */
function parseFollowUpArgs(rawArgs: string): { batch: boolean; message: string } {
  const trimmed = rawArgs.trim();
  if (trimmed === FOLLOW_UP_BATCH_FLAG) return { batch: true, message: "" };
  if (!trimmed.startsWith(FOLLOW_UP_BATCH_FLAG)) return { batch: false, message: trimmed };
  const remainder = trimmed.slice(FOLLOW_UP_BATCH_FLAG.length);
  if (!/^\s/.test(remainder)) return { batch: false, message: trimmed };
  return { batch: true, message: remainder.trim() };
}

const handleReset: LocalCommandHandler = ({ state, active, runtime, tui }) => {
  try {
    const result = resetAgentTab(state, runtime, active!.sessionId);
    if (result.noop) {
      appendActiveSystemMessage(state, runtime, "Already at session root (nothing to reset).");
    } else {
      appendActiveSystemMessage(
        state,
        runtime,
        "Reset to session root. Earlier branches are in /tree.",
      );
    }
  } catch (error: unknown) {
    appendActiveSystemMessage(
      state,
      runtime,
      `Reset failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleClear: LocalCommandHandler = async ({ state, active, runtime, tui }) => {
  // Home send keeps activeTabId=home while overriding the target tab; stay there
  // after clear instead of following completeAgentTabClear's activateTab(next).
  const stayOnHome = state.activeTabId === HOME_TAB_ID;
  try {
    if (runtime.canClearTab && !(await runtime.canClearTab(active!.sessionId)))
      return SKIP_FINALIZE;
  } catch (error: unknown) {
    appendActiveSystemMessage(
      state,
      runtime,
      `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  let prepared: PreparedAgentTabClear;
  try {
    prepared = prepareAgentTabClear(state, runtime, active!.sessionId);
  } catch (error: unknown) {
    appendActiveSystemMessage(
      state,
      runtime,
      `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  tui.requestRender();
  // Session replacement loads extensions synchronously. Delay it until the TUI
  // has painted the empty conversation, otherwise the clear appears frozen.
  setTimeout(() => {
    completeAgentTabClear(state, runtime, prepared)
      .then(() => {
        if (stayOnHome) activateTab(state, HOME_TAB_ID);
        tui.requestRender();
      })
      .catch((error: unknown) => {
        // Identity was rolled back; restore wiped chat from the surviving session.
        // Best-effort only: requireTab throws if the map lost the id mid-clear.
        try {
          if (runtime.getTab(prepared.tab.sessionId)) {
            runtime.rebuildChatFromSession(prepared.tab.sessionId);
          }
        } catch {
          // Always surface the clear failure below even if restore fails.
        }
        appendActiveSystemMessage(
          state,
          runtime,
          `Clear failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        tui.requestRender();
      });
  }, 32);
};

const NEW_SESSION_USAGE = "Error: Usage: /new-session [--focus|--no-focus] [title]";

function parseNewSessionArgs(args: string): { focus: boolean; title?: string } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let focus: boolean | undefined;
  const titleParts: string[] = [];
  for (const part of parts) {
    if (part === "--focus") {
      if (focus === false) throw new Error(NEW_SESSION_USAGE);
      focus = true;
      continue;
    }
    if (part === "--no-focus") {
      if (focus === true) throw new Error(NEW_SESSION_USAGE);
      focus = false;
      continue;
    }
    if (part.startsWith("--")) throw new Error(NEW_SESSION_USAGE);
    titleParts.push(part);
  }
  const requested = titleParts.join(" ");
  return { focus: focus ?? true, ...(requested ? { title: requested } : {}) };
}

const handleNewSession: LocalCommandHandler = async ({ state, args, runtime, tui }) => {
  // Paint Not Ready immediately; createAgentTab still awaits full runtime startup.
  // Do not reuse services here — independent SettingsManager isolation.
  // `--no-focus` keeps the current tab; remaining tokens are the title (`-N` on collision).
  const parsed = parseNewSessionArgs(args);
  const title = parsed.title ? uniqueTabTitle(parsed.title, state.tabs) : undefined;
  const tab = await createAgentTab(state, runtime, {
    onQueued: () => tui.requestRender(),
    focus: parsed.focus,
    ...(title ? { title } : {}),
  });
  if (title) {
    // createAgentTab already set tab.title; persist the uniquified name.
    runtime.renameSession(tab.sessionId, title);
  }
  return undefined;
};

type ResumeTarget = Pick<SessionInfo, "path" | "id" | "name"> & { cwd?: string };

const handleResume: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
  authInputHost,
  args,
}): Promise<typeof SKIP_FINALIZE> => {
  const cwd = active?.workdir ?? state.workdir;
  const runtimeTab = active ? runtime.getTab(active.sessionId) : undefined;
  const currentSessionPath =
    (
      runtimeTab as { session?: { getSessionFile?: () => string | null } } | undefined
    )?.session?.getSessionFile?.() ?? null;
  const selectorRuntime = runtime as unknown as SessionSelectorRuntime;
  const token = args.trim();
  if (token) {
    let target: ResumeTarget | undefined;
    if (token.startsWith("N:")) {
      const name = token.slice(2);
      if (!name) {
        reportResumeFailure(active, runtime, tui, "Session name cannot be empty");
        return SKIP_FINALIZE;
      }
      const openMatches = uniqueSessionsByPath(
        state.tabs.flatMap((tab) => {
          if (tab.title !== name) return [];
          const runtimeTab = runtime.getTab(tab.sessionId);
          const sessionPath = runtimeTab?.session.getSessionFile();
          const sessionId = runtimeTab?.session.getSessionId();
          return sessionPath && sessionId
            ? [{ path: sessionPath, id: sessionId, name, cwd: tab.workdir }]
            : [];
        }),
      );
      let matches = openMatches;
      if (matches.length === 0) {
        const currentMatches = uniqueSessionsByPath(
          (await selectorRuntime.listSessions(cwd)).filter((session) => session.name === name),
        );
        matches =
          currentMatches.length > 0
            ? currentMatches
            : uniqueSessionsByPath(
                (await selectorRuntime.listAllSessions()).filter(
                  (session) => session.name === name,
                ),
              );
      }
      if (matches.length > 1) {
        reportResumeFailure(
          active,
          runtime,
          tui,
          [
            `Multiple sessions named "${name}":`,
            ...matches.map(
              (session) => `  ${session.name} (${session.id}, ${session.cwd || "unknown cwd"})`,
            ),
          ].join("\n"),
        );
        return SKIP_FINALIZE;
      }
      target = matches[0];
      if (!target) {
        reportResumeFailure(active, runtime, tui, `No session found for name: ${name}`);
        return SKIP_FINALIZE;
      }
    } else {
      // `/resume <session-id>` — upstream `pi --resume <id>` resolution order:
      // exact id then id prefix, current folder before all roots.
      const byId = (sessions: SessionInfo[]) =>
        sessions.find((s) => s.id === token) ?? sessions.find((s) => s.id.startsWith(token));
      target =
        byId(await selectorRuntime.listSessions(cwd)) ??
        byId(await selectorRuntime.listAllSessions());
      if (!target) {
        reportResumeFailure(active, runtime, tui, `No session found for id: ${token}`);
        return SKIP_FINALIZE;
      }
    }
    resumeSelectedSession(
      state,
      tui,
      target.path,
      target.name,
      currentSessionPath,
      runtime as unknown as MixCodeKeyRuntime,
      onStateChanged,
    );
    return SKIP_FINALIZE;
  }
  await openSessionSelector(
    state,
    selectorRuntime,
    tui,
    cwd,
    currentSessionPath,
    onStateChanged,
    authInputHost,
    // Home selects an agent for previews, but owns its own editor-slot selector.
    state.activeTabId,
  );
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

function uniqueSessionsByPath(sessions: ResumeTarget[]): ResumeTarget[] {
  const seen = new Set<string>();
  return sessions.filter((session) => {
    if (seen.has(session.path)) return false;
    seen.add(session.path);
    return true;
  });
}

function reportResumeFailure(
  active: MixCodeState["tabs"][number] | undefined,
  runtime: MixCodeKeyRuntime,
  tui: OverlayTui,
  message: string,
): void {
  const text = `Resume failed: ${message}`;
  if (active) {
    runtime.appendSystemMessage(active.sessionId, text, "error");
    pushToast(active, { type: "warning", message: text });
  } else {
    showErrorOverlay(tui, new Error(text));
  }
  tui.requestRender();
}

function sessionActionSkipsConfirm(
  args: string,
  command: "close-session" | "delete-session",
): boolean {
  const token = args.trim().toLowerCase();
  if (!token) return false;
  if (token === "yes" || token === "y") return true;
  throw new Error(`Error: Usage: /${command} [yes]`);
}

const handleCloseSession: LocalCommandHandler = async ({
  state,
  runtime,
  active,
  args,
  tui,
  onStateChanged,
  queuedCommand,
}): Promise<typeof SKIP_FINALIZE> => {
  if (!sessionActionSkipsConfirm(args, "close-session")) {
    await runCommandConfirmation(
      state,
      queuedCommand,
      async () => {
        openSessionActionConfirm(state, tui, "close", active!);
        await onStateChanged?.(state);
      },
      active!.sessionId,
    );
    return SKIP_FINALIZE;
  }
  await closeExistingAgentTab(state, runtime, active!.sessionId);
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleDeleteSession: LocalCommandHandler = async ({
  state,
  runtime,
  active,
  args,
  tui,
  onStateChanged,
  queuedCommand,
}): Promise<typeof SKIP_FINALIZE> => {
  if (!sessionActionSkipsConfirm(args, "delete-session")) {
    await runCommandConfirmation(
      state,
      queuedCommand,
      async () => {
        openSessionActionConfirm(state, tui, "delete", active!);
        await onStateChanged?.(state);
      },
      active!.sessionId,
    );
    return SKIP_FINALIZE;
  }
  await deleteAgentTab(state, runtime, active!.sessionId);
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleDeleteAllSessions: LocalCommandHandler = async ({
  state,
  active,
  tui,
  onStateChanged,
  queuedCommand,
}): Promise<typeof SKIP_FINALIZE> => {
  // Destructive (closes every tab and deletes every session file): gate
  // behind a Y/N confirmation instead of running immediately. The actual
  // deletion happens in handleDeleteAllSessionsConfirmKey once confirmed.
  await runCommandConfirmation(
    state,
    queuedCommand,
    async () => {
      openDeleteAllSessionsConfirm(state, tui);
      await onStateChanged?.(state);
    },
    active?.sessionId,
    false,
  );
  return SKIP_FINALIZE;
};

const handleCloseAllSessions: LocalCommandHandler = async ({
  state,
  active,
  tui,
  onStateChanged,
  queuedCommand,
}): Promise<typeof SKIP_FINALIZE> => {
  // Same Y/N gate as delete-all-sessions; the confirmed close happens in
  // handleCloseAllSessionsConfirmKey (keeps session files, unlike delete).
  await runCommandConfirmation(
    state,
    queuedCommand,
    async () => {
      openCloseAllSessionsConfirm(state, tui);
      await onStateChanged?.(state);
    },
    active?.sessionId,
    false,
  );
  return SKIP_FINALIZE;
};

const handleFork: LocalCommandHandler = async ({ state, active, runtime }) => {
  assertConfiguredOpenTabsReadable();
  const sessionId = createSessionId();
  await runtime.forkSession(active!.sessionId, sessionId);
  // The fork file now exists. Publish its ordered position before runtime tab
  // startup so the local reconciler cannot treat the in-progress tab as extra.
  noteTabOpened(sessionId, active!.sessionId);
  // Use the source tab, not activeTabId — on Home the latter is "home" (-1 → insert at 0).
  const activeIndex = state.tabs.findIndex((tab) => tab.sessionId === active!.sessionId);
  const tab = createTab(state.tabs.length + 1, sessionId, active!.workdir, {
    model: { ...active!.model },
    thinkingLevel: active!.thinkingLevel,
    title: uniqueTabTitle(`${active!.title}-fork`, state.tabs),
    inlineWidgets: state.ui?.inlineWidgets === true,
  });
  state.tabs.splice(activeIndex + 1, 0, tab);
  state.tabs.forEach((item, index) => {
    item.index = index + 1;
  });
  activateTab(state, sessionId);
  try {
    await runtime.createTab(tab, {
      systemPrompt: MIXCODE_SYSTEM_PROMPT,
      thinkingLevel: tab.thinkingLevel,
      workdir: tab.workdir,
      // The forked tab runs alongside its source, so it needs its own services:
      // one services object carries one extension EventBus (cross-session
      // extension events) and one SettingsManager (/context-limit budgets).
      preserveCallerTitle: true,
    });
  } catch (error) {
    // Always restore local state, even if publishing the rollback fails.
    let publicationFailed = false;
    let publicationError: unknown;
    try {
      noteTabClosed(sessionId);
    } catch (rollbackError) {
      publicationFailed = true;
      publicationError = rollbackError;
    }
    const index = state.tabs.findIndex((item) => item.sessionId === sessionId);
    if (index >= 0) state.tabs.splice(index, 1);
    activateTab(state, active!.sessionId);
    if (publicationFailed) {
      throw new AggregateError(
        [error, publicationError],
        "Forking the tab failed and open_tabs rollback also failed",
      );
    }
    throw error;
  }
  // Persist the fork title into the session file so it survives restarts.
  runtime.renameSession(sessionId, tab.title);
  return undefined;
};

const handleTree: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  openTreeSelector(state, runtime as unknown as TreeSelectorRuntime, tui, active!.sessionId);
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleRename: LocalCommandHandler = ({ state, active, args, runtime, tui }) => {
  try {
    renameAgentTab(state, active!.sessionId, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    appendActiveSystemMessage(
      state,
      runtime,
      message.startsWith("Error:") ? message : `Error: ${message}`,
    );
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  runtime.renameSession(active!.sessionId, active!.title);
  return undefined;
};

const handleColor: LocalCommandHandler = ({ state, active, args, runtime, tui }) => {
  const input = args.trim().toLowerCase();
  const color = input === "" || input === "clear" ? undefined : input;
  if (color !== undefined && !isTabColorName(color)) {
    runtime.appendSystemMessage(
      active!.sessionId,
      `Error: Unknown color: ${input} (valid: ${TAB_COLOR_NAMES.join(", ")}, clear)`,
      "error",
    );
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  // No argument or "clear" removes the color; persistence rides on the normal
  // state save after the command returns (see handleSubmittedInput).
  setAgentTabColor(state, active!.sessionId, color);
  return undefined;
};

const handleGroupTabs: LocalCommandHandler = ({ state }) => {
  // Publish the new order so peer instances do not revert it on the next poll;
  // the normal state save after this handler persists it to mixcode_state.json.
  noteTabsReplaced(groupTabsByColor(state));
  return undefined;
};

const handleSession: LocalCommandHandler = ({ state, active, runtime }) => {
  // Agent-tab only: session stats dump into the active chat.
  if (state.activeTabId === HOME_TAB_ID) return SKIP_FINALIZE;
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  const info = runtimeTab.agentSession.getSessionStats();
  syncTabContextUsage(active!, info.contextUsage);
  // Pi handleSessionCommand adds a permanent plain Text child (not showStatus).
  runtime.appendSystemMessage(
    active!.sessionId,
    renderSessionInfoText(runtimeTab, info, {
      tabTitle: active!.title,
      workdir: active!.workdir,
    }),
    "plain",
  );
};

const handleCompact: LocalCommandHandler = async ({ active, args, runtime }) => {
  const sessionId = active!.sessionId;
  // First token matching "provider/modelId" is treated as a model ref;
  // the remainder is passed as custom compaction instructions.
  const firstToken = args.trimStart().split(/\s/)[0] ?? "";
  const isModelRef = /^[^/\s]+\/[^/\s]+$/.test(firstToken);
  const modelRef = isModelRef ? firstToken : undefined;
  const customInstructions = isModelRef
    ? args.trimStart().slice(firstToken.length).trimStart()
    : args;

  if (!modelRef) {
    await runtime.compactSession(sessionId, customInstructions);
    return undefined;
  }

  const [provider, modelId] = modelRef.split("/") as [string, string];
  const targetModel = runtime.resolveModel(provider, modelId);
  if (!targetModel) {
    throw new Error(`Error: Unknown model: ${modelRef}`);
  }

  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${sessionId}`);
  const previousModel = runtimeTab.agentSession.model;

  await runtime.updateTabModel(sessionId, targetModel);
  try {
    await runtime.compactSession(sessionId, customInstructions);
  } finally {
    // Restore the original model whether compact succeeds, throws, or is cancelled.
    if (previousModel) {
      await runtime.updateTabModel(sessionId, previousModel).catch(() => undefined);
    }
  }
  return undefined;
};

const handleResumeTrash: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
  authInputHost,
}): Promise<typeof SKIP_FINALIZE> => {
  const selectorRuntime = runtime as unknown as SessionSelectorRuntime;
  const trashRoot = trashDir();

  // Build a trashPath → sessionId map so extensionSwitchSession can restore
  // the session before the runtime opens it.
  const trashEntries = await listTrash();
  const sessionIdByTrashPath = new Map(trashEntries.map((e) => [e.trashPath, e.sessionId]));

  // Wrap the runtime so listSessions/listAllSessions scan the trash directory
  // instead of the sessions root, and extensionSwitchSession restores the file
  // before opening it.
  const wrappedRuntime: SessionSelectorRuntime = {
    createTab: (tab, config) => selectorRuntime.createTab(tab, config),
    getTab: (sessionId) => selectorRuntime.getTab(sessionId),
    closeTab: (sessionId) => selectorRuntime.closeTab(sessionId),
    listSessions: async (cwd, signal, onProgress) =>
      listSessionsForCwd(cwd, trashRoot, signal, onProgress),
    listAllSessions: async (signal, onProgress) =>
      listAllSessionsGlobal(trashRoot, signal, onProgress),
    extensionSwitchSession: async (sessionId, trashPath) => {
      const originalSessionId = sessionIdByTrashPath.get(trashPath) ?? sessionId;
      let originalPath: string;
      try {
        const restored = await restoreFromTrash(originalSessionId);
        originalPath = restored.originalPath;
        invalidateSessionCatalog(path.dirname(originalPath));
      } catch {
        // Not in the trash index (e.g. a file placed manually); open in place.
        originalPath = trashPath;
      }
      return selectorRuntime.extensionSwitchSession(sessionId, originalPath);
    },
  };

  const runtimeTab = active ? runtime.getTab(active.sessionId) : undefined;
  const currentSessionPath =
    (
      runtimeTab as { session?: { getSessionFile?: () => string | null } } | undefined
    )?.session?.getSessionFile?.() ?? null;

  await openSessionSelector(
    state,
    wrappedRuntime,
    tui,
    active?.workdir ?? state.workdir,
    currentSessionPath,
    onStateChanged,
    authInputHost,
    active?.sessionId,
  );

  return SKIP_FINALIZE;
};

export const SESSION_COMMAND_HANDLERS = {
  fork: handleFork,
  "follow-up": handleFollowUp,
  tree: handleTree,
  "close-session": handleCloseSession,
  "delete-session": handleDeleteSession,
  "close-all-sessions": handleCloseAllSessions,
  "delete-all-sessions": handleDeleteAllSessions,
  session: handleSession,
  compact: handleCompact,
  clear: handleClear,
  reset: handleReset,
  "new-session": handleNewSession,
  resume: handleResume,
  "resume-trash": handleResumeTrash,
  rename: handleRename,
  color: handleColor,
  "group-colored-tabs": handleGroupTabs,
} satisfies Partial<Record<LocalCommand, LocalCommandHandler>>;

type SessionStatsInfo = ReturnType<RuntimeTab["agentSession"]["getSessionStats"]>;

function syncTabContextUsage(
  tab: MixCodeState["tabs"][number],
  contextUsage: SessionStatsInfo["contextUsage"],
): void {
  if (!contextUsage) return;
  // Only sync contextLimit from the runtime if the user hasn't overridden it.
  if (!tab.contextLimitOverridden) {
    tab.contextLimit = contextUsage.contextWindow;
  }
  tab.currentContextTokens = contextUsage.tokens === null ? undefined : contextUsage.tokens;
}

function renderSessionInfoText(
  runtimeTab: RuntimeTab,
  info: SessionStatsInfo,
  identity: { tabTitle: string; workdir: string },
): string {
  // Pi handleSessionCommand: permanent stats dump with prompt-volume Input,
  // Cached/Uncached split, $cost, optional multi-model and cache re-bill lines.
  // Context usage is footer-only (syncTabContextUsage), not part of this dump.
  const entries =
    typeof runtimeTab.session.getEntries === "function" ? runtimeTab.session.getEntries() : [];
  const session = runtimeTab.agentSession;
  const models = session.modelRuntime;
  const cacheWarming = session.settingsManager?.getCacheWarmingMode
    ? {
        mode: session.settingsManager.getCacheWarmingMode(),
        status: session.cacheWarmingStatus,
      }
    : undefined;
  return formatSessionInfoText(runtimeTab.session, info, {
    entries,
    models,
    cacheWarming,
    ...identity,
  });
}
