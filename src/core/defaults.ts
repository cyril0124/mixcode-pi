import { type ThinkingLevel, uuidv7 } from "@earendil-works/pi-agent-core";
import { createTreeSelectorState } from "./tree-selector.js";
import {
  DEFAULT_ICON_MODE,
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
} from "./mixcode-settings.js";
import {
  HOME_TAB_ID,
  type MixCodeModelRef,
  type MixCodeState,
  type MixCodeTabInfo,
  type SessionSelectorState,
  type WorkspaceOverlayState,
} from "./types.js";

export function createSessionSelectorState(): SessionSelectorState {
  return { open: false };
}

export function createWorkspaceOverlayState(): WorkspaceOverlayState {
  return { open: false };
}

export const DEFAULT_THEME_ID = "claude-warm";

export const DEFAULT_MODEL_REF: MixCodeModelRef = {
  provider: "faux",
  modelId: "faux-1",
  displayName: "faux/faux-1",
  contextWindow: 200_000,
  reasoning: true,
};

export function createSessionId(): string {
  return uuidv7();
}

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
    settingsPanel: { open: false },
    extensionManager: { open: false },
    sessionSelector: createSessionSelectorState(),
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
    homeNonIdleOnly: false,
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

/**
 * First unused title among `tabs`: `desired` itself, else `desired-1`, `desired-2`, …
 * Does not parse an existing numeric suffix on `desired`; always appends `-n`.
 */
export function uniqueTabTitle(desired: string, tabs: ReadonlyArray<{ title: string }>): string {
  const used = new Set(tabs.map((tab) => tab.title));
  if (!used.has(desired)) return desired;
  for (let n = 1; n < 10_000; n++) {
    const title = `${desired}-${n}`;
    if (!used.has(title)) return title;
  }
  return `${desired}-${tabs.length + 1}`;
}
