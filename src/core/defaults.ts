export { createSessionId, UUIDV7_SESSION_ID_PATTERN } from "./session-ids.js";
import { createSessionSelectorState } from "./session-selector.js";
import { createForkSelectorState } from "../ui/fork-selector.js";
import { createTreeSelectorState } from "./tree-selector.js";
import { createWorkspaceOverlayState } from "./workspace-ui.js";
import type { MixCodeModelRef, MixCodeState, MixCodeTabInfo } from "./types.js";

export const DEFAULT_THEME_ID = "claude-warm";

export const DEFAULT_MODEL_REF: MixCodeModelRef = {
  provider: "faux",
  modelId: "faux-1",
  displayName: "faux/faux-1",
  contextWindow: 200_000,
};

export function createInitialState(workdir: string): MixCodeState {
  return {
    workdir,
    tabs: [],
    activeTabId: "config",
    packageUpdates: [],
    quitConfirmOpen: false,
    deleteAllSessionsConfirmOpen: false,
    closeAllSessionsConfirmOpen: false,
    commandPaletteOpen: false,
    commandPalette: { query: "", selectedIndex: 0 },
    extensionManager: {
      open: false,
      selectedIndex: 0,
      entries: [],
      selectedKeys: [],
      message: "",
      error: "",
      working: false,
    },
    sessionSelector: createSessionSelectorState(),
    forkSelector: createForkSelectorState(),
    treeSelector: createTreeSelectorState(),
    workspaceOverlay: createWorkspaceOverlayState(),
    tabJumpOpen: false,
    tabJumpQuery: "",
    tabJumpIndex: 0,
    picker: undefined,
    model: { ...DEFAULT_MODEL_REF },
    thinkingLevel: "medium",
    theme: DEFAULT_THEME_ID,
    availableModels: [{ ...DEFAULT_MODEL_REF }],
    homeSelectedTabIndex: 0,
  };
}

export function createTab(
  index: number,
  sessionId: string,
  workdir: string,
  overrides: Partial<MixCodeTabInfo> = {},
): MixCodeTabInfo {
  return {
    index,
    sessionId,
    title: `Agent-${String(index).padStart(2, "0")}`,
    status: "idle",
    tokenInput: 0,
    tokenOutput: 0,
    contextLimit: DEFAULT_MODEL_REF.contextWindow,
    model: { ...DEFAULT_MODEL_REF },
    thinkingLevel: "medium",
    workdir,
    alias: "",
    pendingDialogs: [],
    pendingMessages: [],
    promptHistory: [],
    draftInput: "",
    chatScrollOffset: 0,
    previewOpen: false,
    previewMessages: [],
    previewIndex: 0,
    previewScrollOffset: 0,
    previewHint: "",
    previewPendingHome: false,
    vimMode: false,
    vimPendingEscapeAt: undefined,
    vimPendingHome: false,
    pendingEscapeAction: undefined,
    pendingEscapeArmedAt: undefined,
    lastEscapeTime: undefined,
    unreadDone: false,
    workingStartedAt: undefined,
    lastWorkedDurationSeconds: undefined,
    lastWorkedAt: undefined,
    extensionUi: {
      statuses: [],
      widgets: [],
      toolsExpanded: false,
      pendingUserInteractions: [],
      workingVisible: true,
    },
    chatSurfaceBounds: undefined,
    chatSelection: undefined,
    lastRenderedChatLines: [],
    panelOpen: false,
    panelScrollOffset: 0,
    ...overrides,
  };
}
