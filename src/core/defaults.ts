import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
export { createSessionId, UUIDV7_SESSION_ID_PATTERN } from "./session-ids.js";
import { createSessionSelectorState } from "./session-selector.js";
import { createForkSelectorState } from "./fork-selector.js";
import { createTreeSelectorState } from "./tree-selector.js";
import { createWorkspaceOverlayState } from "./workspace-ui.js";
import {
  DEFAULT_ICON_MODE,
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
} from "./mixcode-settings.js";
import { HOME_TAB_ID, type MixCodeModelRef, type MixCodeState, type MixCodeTabInfo } from "./types.js";

export const DEFAULT_THEME_ID = "claude-warm";

export const DEFAULT_MODEL_REF: MixCodeModelRef = {
  provider: "faux",
  modelId: "faux-1",
  displayName: "faux/faux-1",
  contextWindow: 200_000,
  reasoning: true,
};

export function createInitialState(workdir: string, defaultThinkingLevel?: ThinkingLevel): MixCodeState {
  return {
    workdir,
    tabs: [],
    ui: {
      oversizedAssistantMessage: { ...DEFAULT_OVERSIZED_ASSISTANT_MESSAGE },
      icons: { mode: DEFAULT_ICON_MODE },
      inlineWidgets: false,
    },
    activeTabId: HOME_TAB_ID,
    recentAgentTabIds: [],
    packageUpdates: [],
    quitConfirmOpen: false,
    deleteAllSessionsConfirmOpen: false,
    closeAllSessionsConfirmOpen: false,
    sessionActionConfirm: null,
    commandPaletteOpen: false,
    commandPalette: { query: "", selectedIndex: 0 },
    settingsPanel: {
      open: false,
      selectedIndex: 0,
      filterQuery: "",
      editMode: false,
      editText: "",
      editError: undefined,
      enumOpen: false,
      enumIndex: 0,
      mixcodeRaw: {},
      mixcodeFile: "",
      piSettingsFile: "",
    },
    extensionManager: {
      open: false,
      selectedIndex: 0,
      detailScrollOffset: 0,
      searchActive: false,
      searchQuery: "",
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
    tabJumpNonIdleOnly: false,
    picker: undefined,
    model: { ...DEFAULT_MODEL_REF },
    thinkingLevel: defaultThinkingLevel ?? "medium",
    theme: DEFAULT_THEME_ID,
    availableModels: [{ ...DEFAULT_MODEL_REF }],
    disabledProviders: [],
    disabledModels: [],
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
    pendingFollowUps: [],
    promptHistory: [],
    draftInput: "",
    chatScrollOffset: 0,
    previewMessages: [],
    previewIndex: 0,
    vimMode: false,
    vimTranscriptSearch: undefined,
    vimPendingEscapeAt: undefined,
    vimPendingHome: false,
    vimEnterArmedAt: undefined,
    zenMode: false,
    inlineWidgets: false,
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
      waitingForInputs: [],
      workingVisible: true,
    },
    chatSurfaceBounds: undefined,
    chatSelection: undefined,
    lastRenderedChatLines: [],
    panelOpen: false,
    panelScrollOffset: 0,
    floatingPanel: undefined,
    ...overrides,
  };
}

/** Smallest free `Agent-NN` title among open tabs (1-based, zero-padded). */
export function nextAvailableAgentTitle(tabs: ReadonlyArray<{ title: string }>): string {
  const used = new Set(tabs.map((tab) => tab.title));
  for (let n = 1; n < 10_000; n++) {
    const title = `Agent-${String(n).padStart(2, "0")}`;
    if (!used.has(title)) return title;
  }
  return `Agent-${String(tabs.length + 1).padStart(2, "0")}`;
}
