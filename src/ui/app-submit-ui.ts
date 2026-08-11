import type { RuntimeTab } from "../agent/runtime.js";
import { MIXCODE_EXTENSION_KEYBINDINGS } from "../agent/runtime-extension-theme.js";
import type { LocalCommand } from "../core/commands.js";
import { pushToast } from "../core/toast.js";
import type { MixCodeState, PendingEscapeAction } from "../core/types.js";
import { appendActiveSystemMessage } from "./app-actions.js";
import { editTextWithTuiPaused, showTextOverlay } from "./app-overlays.js";
import {
  type LocalCommandHandler,
  type MixCodeSubmitRuntime,
  type RuntimeShortcutInfo,
  type RuntimeToolInfo,
  SKIP_FINALIZE,
} from "./app-types.js";
import { userMessageEntryIdsInBranch } from "./chat-scroll-target.js";
import { renderHotkeysText } from "./hotkeys.js";
import { getConfiguredQuitOptions, quitMixCode } from "./quit.js";
import { clearConversationCache } from "./rendering.js";
import { renderSystemToolsText } from "./system-tools.js";
import { openTreeSelector, type TreeSelectorRuntime } from "./tree-selector.js";

const handleMarkDone: LocalCommandHandler = ({ active }) => {
  // Intentional: unlike agent_end (unread only until the tab is viewed),
  // /mark-done forces a sticky "!" on the current tab so the user can flag
  // work as done while still looking at it. activateTab() clears the badge
  // when focus leaves and returns (see core/tabs.ts).
  active!.unreadDone = true;
  active!.status = "done";
  // Ring terminal bell after 5s so the user gets an audible notification
  // even if they have switched away from the terminal window.
  setTimeout(() => process.stdout.write("\x07"), 5_000);
  return undefined;
};

const handleVim: LocalCommandHandler = ({ active }) => {
  active!.vimMode = true;
  active!.vimPendingEscapeAt = undefined;
  active!.vimPendingHome = false;
  return undefined;
};

const handleToggleZenMode: LocalCommandHandler = ({ active }) => {
  active!.zenMode = !active!.zenMode;
  return undefined;
};

const handleToggleHiddenMessages: LocalCommandHandler = ({ active, runtime, tui }) => {
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) {
    pushToast(active!, {
      type: "warning",
      message: "Toggling hidden messages requires an active agent chat",
    });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  runtimeTab.showHiddenMessages = !runtimeTab.showHiddenMessages;
  // Rebuild via host so projection stays behind the multi-tab seam.
  runtime.rebuildChatFromSession(active!.sessionId);
  clearConversationCache(active!.sessionId);
  pushToast(active!, {
    type: "info",
    message: runtimeTab.showHiddenMessages
      ? "Hidden extension messages shown"
      : "Hidden extension messages hidden",
  });
  tui.requestRender();
};

const handleNavigate: LocalCommandHandler = async ({
  state,
  active,
  runtime,
  tui,
  onStateChanged,
}): Promise<typeof SKIP_FINALIZE> => {
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (
    !runtimeTab?.session.getTree ||
    !runtimeTab.session.getLeafId ||
    !runtimeTab.session.getBranch
  ) {
    pushToast(active!, { type: "warning", message: "Navigate requires an active agent chat" });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  const userEntryIds = userMessageEntryIdsInBranch(runtimeTab.session.getBranch());
  if (userEntryIds.length === 0) {
    pushToast(active!, { type: "warning", message: "No user messages in current chat" });
    tui.requestRender();
    return SKIP_FINALIZE;
  }
  openTreeSelector(
    state,
    runtime as unknown as TreeSelectorRuntime,
    tui,
    active!.sessionId,
    undefined,
    "user-only",
    "navigate",
    new Set(userEntryIds),
  );
  await onStateChanged?.(state);
  tui.requestRender();
  return SKIP_FINALIZE;
};

const handleHotkeys: LocalCommandHandler = ({ state, active, runtime }) => {
  // Agent-tab only: Home has no chat surface for permanent shortcut dumps.
  if (state.activeTabId === "config") return SKIP_FINALIZE;
  const shortcuts = active ? getExtensionShortcuts(runtime, active.sessionId) : [];
  // Pi handleHotkeysCommand permanently appends Markdown (not showStatus).
  appendActiveSystemMessage(state, runtime, renderHotkeysText(shortcuts), "block");
};

const handleSystemPrompt: LocalCommandHandler = async ({ active, args, runtime, tui }) => {
  if (args.trim()) throw new Error("Usage: /system-prompt");
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  await editTextWithTuiPaused(tui, runtimeTab.agent.state.systemPrompt);
  return undefined;
};

const handleSystemTools: LocalCommandHandler = async ({ active, args, runtime, tui }) => {
  const runtimeTab = runtime.getTab(active!.sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${active!.sessionId}`);
  const request = parseEditorFlag(args);
  const text = renderSystemToolsText(getRuntimeTools(runtime, active!.sessionId, runtimeTab));
  if (request.editorDisabled) {
    showTextOverlay(tui, text);
  } else {
    await editTextWithTuiPaused(tui, text, request.editor);
  }
  return undefined;
};

const handleTuiState: LocalCommandHandler = async ({ state, args, tui }) => {
  const request = parseEditorFlag(args);
  const text = JSON.stringify(createTuiDebugState(state), null, 2);
  if (request.editorDisabled) {
    showTextOverlay(tui, text);
  } else {
    await editTextWithTuiPaused(tui, text, request.editor);
  }
  return undefined;
};

const handleQuit: LocalCommandHandler = async ({ runtime, tui }) => {
  await quitMixCode(runtime, tui, getConfiguredQuitOptions(tui));
  return undefined;
};

export const UI_COMMAND_HANDLERS = {
  "system-prompt": handleSystemPrompt,
  "system-tools": handleSystemTools,
  "toggle-hidden-messages": handleToggleHiddenMessages,
  "mark-done": handleMarkDone,
  vim: handleVim,
  "toggle-zen-mode": handleToggleZenMode,
  navigate: handleNavigate,
  help: handleHotkeys,
  hotkeys: handleHotkeys,
  "tui-state": handleTuiState,
  quit: handleQuit,
  exit: handleQuit,
} satisfies Partial<Record<LocalCommand, LocalCommandHandler>>;

function getRuntimeTools(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
  runtimeTab: RuntimeTab,
): RuntimeToolInfo[] {
  const tools = runtime.getExtensionTools(sessionId) ?? runtimeTab.agentSession.getAllTools();
  return Array.isArray(tools) ? tools : [];
}

function getExtensionShortcuts(
  runtime: MixCodeSubmitRuntime,
  sessionId: string,
): RuntimeShortcutInfo[] {
  const runtimeTab = runtime.getTab(sessionId);
  if (!runtimeTab) throw new Error(`Unknown tab session: ${sessionId}`);
  const runner = runtimeTab.agentSession?.extensionRunner;
  if (!runner) return [];
  return [...runner.getShortcuts(MIXCODE_EXTENSION_KEYBINDINGS).entries()].map(
    ([key, shortcut]) => ({
      key,
      description: shortcut.description,
      source: shortcut.extensionPath,
    }),
  );
}

function parseEditorFlag(args: string): {
  remaining: string;
  editor?: string;
  editorDisabled?: boolean;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let editor: string | undefined;
  let editorDisabled = false;
  const remaining: string[] = [];
  for (const part of parts) {
    if (part === "--editor") {
      editor = "";
      editorDisabled = false;
      continue;
    }
    if (part.startsWith("--editor=")) {
      const value = part.slice("--editor=".length);
      editorDisabled = value === "false";
      editor = editorDisabled ? undefined : value;
      continue;
    }
    remaining.push(part);
  }
  return { remaining: remaining.join(" "), editor, editorDisabled };
}

interface MixCodeTuiDebugState {
  version: 1;
  workdir: string;
  activeTabId: string;
  theme: string;
  overlays: {
    quitConfirmOpen: boolean;
    deleteAllSessionsConfirmOpen: boolean;
    closeAllSessionsConfirmOpen: boolean;
    sessionActionConfirm: MixCodeState["sessionActionConfirm"];
    commandPaletteOpen: boolean;
    commandPalette: MixCodeState["commandPalette"];
    tabJumpOpen: boolean;
    tabJumpQuery: string;
    tabJumpIndex: number;
    tabJumpNonIdleOnly: boolean;
    picker?: Omit<NonNullable<MixCodeState["picker"]>, "items"> & { itemCount: number };
  };
  tabs: Array<{
    index: number;
    sessionId: string;
    title: string;
    status: string;
    active: boolean;
    workdir: string;
    alias: string;
    thinkingLevel: string;
    pendingDialogCount: number;
    chatScrollOffset: number;
    previewOpen: boolean;
    previewIndex: number;
    previewScrollOffset: number;
    previewHint: string;
    unreadDone: boolean;
    pendingEscapeAction?: PendingEscapeAction;
    workingStartedAt?: string;
    lastWorkedDurationSeconds?: number;
    extensionUi: {
      statusCount: number;
      widgetCount: number;
      toolsExpanded: boolean;
      workingVisible: boolean;
      hasWorkingIndicatorFrames: boolean;
      workingIndicatorIntervalMs?: number;
      hasWorkingMessage: boolean;
      hasTitle: boolean;
      headerLineCount: number;
      footerLineCount: number;
    };
    inputMetaHitRegions?: MixCodeState["tabs"][number]["inputMetaHitRegions"];
  }>;
}

/** Snapshot used by /tui-state — only consumed in this module. */
function createTuiDebugState(state: MixCodeState): MixCodeTuiDebugState {
  return {
    version: 1,
    workdir: state.workdir,
    activeTabId: state.activeTabId,
    theme: state.theme,
    overlays: {
      quitConfirmOpen: state.quitConfirmOpen,
      deleteAllSessionsConfirmOpen: state.deleteAllSessionsConfirmOpen,
      closeAllSessionsConfirmOpen: state.closeAllSessionsConfirmOpen,
      sessionActionConfirm: state.sessionActionConfirm,
      commandPaletteOpen: state.commandPaletteOpen,
      commandPalette: state.commandPalette,
      tabJumpOpen: state.tabJumpOpen,
      tabJumpQuery: state.tabJumpQuery,
      tabJumpIndex: state.tabJumpIndex,
      tabJumpNonIdleOnly: state.tabJumpNonIdleOnly,
      picker: state.picker
        ? {
            kind: state.picker.kind,
            title: state.picker.title,
            query: state.picker.query,
            selectedIndex: state.picker.selectedIndex,
            workdirBase: state.picker.workdirBase,
            itemCount: state.picker.items.length,
          }
        : undefined,
    },
    tabs: state.tabs.map((tab) => ({
      index: tab.index,
      sessionId: tab.sessionId,
      title: tab.title,
      status: tab.status,
      active: tab.sessionId === state.activeTabId,
      workdir: tab.workdir,
      alias: tab.alias,
      thinkingLevel: tab.thinkingLevel,
      pendingDialogCount: tab.pendingDialogs.length,
      chatScrollOffset: tab.chatScrollOffset,
      previewOpen: tab.previewOpen,
      previewIndex: tab.previewIndex,
      previewScrollOffset: tab.previewScrollOffset,
      previewHint: tab.previewHint,
      unreadDone: tab.unreadDone,
      pendingEscapeAction: tab.pendingEscapeAction,
      workingStartedAt: tab.workingStartedAt,
      lastWorkedDurationSeconds: tab.lastWorkedDurationSeconds,
      extensionUi: {
        statusCount: tab.extensionUi.statuses.length,
        widgetCount: tab.extensionUi.widgets.length,
        toolsExpanded: tab.extensionUi.toolsExpanded,
        workingVisible: tab.extensionUi.workingVisible,
        hasWorkingIndicatorFrames: Boolean(tab.extensionUi.workingIndicatorFrames?.length),
        workingIndicatorIntervalMs: tab.extensionUi.workingIndicatorIntervalMs,
        hasWorkingMessage: Boolean(tab.extensionUi.workingMessage),
        hasTitle: Boolean(tab.extensionUi.title),
        headerLineCount: tab.extensionUi.header?.lines.length ?? 0,
        footerLineCount: tab.extensionUi.footer?.lines.length ?? 0,
      },
      inputMetaHitRegions: tab.inputMetaHitRegions,
    })),
  };
}
