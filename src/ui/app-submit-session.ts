import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { RuntimeTab } from "../agent/runtime.js";
import type { LocalCommand } from "../core/commands.js";
import { createSessionId, createTab, uniqueTabTitle } from "../core/defaults.js";
import { assertModelEnabled } from "../core/models.js";
import {
  assertConfiguredOpenTabsReadable,
  noteTabClosed,
  noteTabOpened,
} from "../core/open-tabs-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab, renameAgentTab } from "../core/tabs.js";
import { pushToast } from "../core/toast.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import {
  closeExistingAgentTab,
  completeAgentTabClear,
  createAgentTab,
  deleteAgentTab,
  prepareAgentTabClear,
  type PreparedAgentTabClear,
} from "./agent-tab-actions.js";
import { showErrorOverlay } from "./app-overlays.js";
import {
  appendActiveSystemMessage,
  openCloseAllSessionsConfirm,
  openDeleteAllSessionsConfirm,
  openSessionActionConfirm,
} from "./app-actions.js";
import {
  type LocalCommandHandler,
  type MixCodeKeyRuntime,
  type OverlayTui,
  SKIP_FINALIZE,
} from "./app-types.js";
import { renderSessionInfoText as formatSessionInfoText } from "./components/session-info.js";
import {
  openSessionSelector,
  resumeSelectedSession,
  type SessionSelectorRuntime,
} from "./session-resume.js";
import { openTreeSelector, type TreeSelectorRuntime } from "./components/tree-selector.js";

const handleFollowUp: LocalCommandHandler = async ({ active, args, runtime, tui }) => {
  // Queue as followUp (wait until idle). Do not send "/follow-up ..." as model text.
  const message = args.trim();
  if (!message) {
    pushToast(active!, {
      type: "warning",
      message: "Error: Usage: /follow-up <message>",
    });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  assertModelEnabled(active!.model);
  await runtime.prompt(active!.sessionId, message, { streamingBehavior: "followUp" });
};

const handleReset: LocalCommandHandler = ({ state, active, runtime, tui }) => {
  try {
    const result = runtime.resetTabToRoot(active!.sessionId);
    // Same-file reset: keep title/sessionId; only drop ephemeral view state.
    active!.chatScrollOffset = 0;
    active!.chatScrollAnchorEntryId = undefined;
    active!.chatScrollAnchorIndex = undefined;
    active!.chatScrollAnchorText = undefined;
    if (result.noop) {
      appendActiveSystemMessage(state, runtime, "Already at session root (nothing to reset).");
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

const handleClear: LocalCommandHandler = ({ state, active, runtime, tui }) => {
  // Home send keeps activeTabId=home while overriding the target tab; stay there
  // after clear instead of following completeAgentTabClear's activateTab(next).
  const stayOnHome = state.activeTabId === HOME_TAB_ID;
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
      target.id,
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
    active?.sessionId ?? state.activeTabId,
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
}): Promise<typeof SKIP_FINALIZE> => {
  if (!sessionActionSkipsConfirm(args, "close-session")) {
    openSessionActionConfirm(state, tui, "close", active!);
    await onStateChanged?.(state);
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
}): Promise<typeof SKIP_FINALIZE> => {
  if (!sessionActionSkipsConfirm(args, "delete-session")) {
    openSessionActionConfirm(state, tui, "delete", active!);
    await onStateChanged?.(state);
    return SKIP_FINALIZE;
  }
  await deleteAgentTab(state, runtime, active!.sessionId);
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleDeleteAllSessions: LocalCommandHandler = async ({
  state,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  // Destructive (closes every tab and deletes every session file): gate
  // behind a Y/N confirmation instead of running immediately. The actual
  // deletion happens in handleDeleteAllSessionsConfirmKey once confirmed.
  openDeleteAllSessionsConfirm(state, tui);
  await onStateChanged?.(state);
  return SKIP_FINALIZE;
};

const handleCloseAllSessions: LocalCommandHandler = async ({
  state,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  // Same Y/N gate as delete-all-sessions; the confirmed close happens in
  // handleCloseAllSessionsConfirmKey (keeps session files, unlike delete).
  openCloseAllSessionsConfirm(state, tui);
  await onStateChanged?.(state);
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
    pushToast(active!, {
      type: "warning",
      message: error instanceof Error ? error.message : String(error),
    });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  runtime.renameSession(active!.sessionId, active!.title);
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
  await runtime.compactSession(active!.sessionId, args);
  return undefined;
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
  rename: handleRename,
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

export function renderSessionInfoText(
  runtimeTab: RuntimeTab,
  info: SessionStatsInfo = runtimeTab.agentSession.getSessionStats(),
  identity: { tabTitle: string; workdir: string },
): string {
  // Pi handleSessionCommand: permanent stats dump with prompt-volume Input,
  // Cached/Uncached split, $cost, optional multi-model and cache re-bill lines.
  // Context usage is footer-only (syncTabContextUsage), not part of this dump.
  const entries =
    typeof runtimeTab.session.getEntries === "function" ? runtimeTab.session.getEntries() : [];
  const models = runtimeTab.agentSession.modelRuntime;
  return formatSessionInfoText(runtimeTab.session, info, { entries, models, ...identity });
}
