import type { AutocompleteProvider, TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { MixCodeState } from "../core/types.js";

export type MixCodeKeyRuntime = Partial<
  Pick<
    MixCodeRuntime,
    | "abortTab"
    | "abortAllTabs"
    | "beginShutdown"
    | "appendSystemMessage"
    | "closeTab"
    | "createTab"
    | "closeAllTabs"
    | "deleteTab"
    | "deleteAllTabs"
    | "dispatchExtensionShortcut"
    | "dispatchTerminalInput"
    | "extensionSwitchSession"
    | "extensionFork"
    | "flushPendingMessage"
    | "focusExtensionCustomOverlay"
    | "getAllExtensionCommands"
    | "getExtensionCommands"
    | "getExtensionManagerEntries"
    | "getExtensionTools"
    | "getTab"
    | "getPromptHistory"
    | "getDoubleEscapeAction"
    | "getForkableUserMessages"
    | "hasExtensionCustomOverlay"
    | "listAllSessions"
    | "prompt"
    | "popPendingMessage"
    | "retractCurrentTurn"
    | "reloadExtensionManagerTab"
    | "reloadExtensionManagerWorkdir"
    | "resolveExtensionDialog"
    | "resolveModel"
    | "setExtensionEnabled"
    | "updateTabModel"
    | "updateTabThinkingLevel"
    | "updateTabWorkdir"
  >
>;

type OptionalSubmitRuntime = Partial<
  Pick<
    MixCodeRuntime,
    | "clearTab"
    | "extensionNavigateTree"
    | "getExtensionCommands"
    | "getExtensionManagerEntries"
    | "getExtensionTools"
    | "importFromJsonl"
    | "executeShellCommand"
    | "extensionReload"
    | "extensionSwitchSession"
    | "getSharedModelRuntime"
    | "listSessions"
    | "listAllSessions"
    | "reloadExtensionManagerTab"
    | "reloadExtensionManagerWorkdir"
    | "reloadModelConfig"
    | "renameSession"
    | "resolveModel"
    | "setHideThinkingBlock"
    | "updateTabModel"
    | "updateTabThinkingLevel"
    | "updateTabWorkdir"
  >
>;

export type MixCodeSubmitRuntime = Pick<
  MixCodeRuntime,
  | "appendSystemMessage"
  | "prompt"
  | "getTab"
  | "createTab"
  | "forkSession"
  | "closeTab"
  | "closeAllTabs"
  | "deleteTab"
  | "deleteAllTabs"
  | "executeShellCommand"
  | "extensionReload"
  | "compactSession"
  | "setExtensionEnabled"
> &
  OptionalSubmitRuntime;

export type RuntimeChangeSource = Pick<MixCodeRuntime, "onChange">;
export interface WorkspaceKeyOptions {
  workspaceFile?: string;
  /** Agent-dir state root; when set, Home sends also append conversation history. */
  rootStateDir?: string;
  /** Settings dependencies required by config-scoped commands entered from Home. */
  settingsDeps?: {
    settingsManager: import("@earendil-works/pi-coding-agent").SettingsManager;
    mixcodeFile: string;
    piSettingsFile: string;
  };
}

export interface TreeSelectorDisplayHost {
  open: (
    sessionId: string,
    runtime?: unknown,
    onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  ) => void;
  refresh: () => void;
  close: (sessionId?: string) => void;
  getEditorRows?: (sessionId?: string) => number | undefined;
}

export type OverlayTui = Pick<TuiType, "requestRender" | "showOverlay"> &
  Partial<Pick<TuiType, "hideOverlay" | "hasOverlay" | "setFocus" | "start" | "stop">> & {
    treeSelectorDisplay?: TreeSelectorDisplayHost;
  };

export interface MixCodeEditorActions {
  getText: () => string;
  /** Full buffer with paste markers expanded (Pi Editor submit semantics). */
  getExpandedText?: () => string;
  setText: (text: string) => void;
  addToHistory?: (text: string, sessionId?: string) => void;
  insertTextAtCursor?: (text: string) => void;
  submitCurrentText?: () => void;
  browsePromptHistory?: (data: string) => boolean;
  /**
   * True when an extension custom component currently owns the editor slot
   * for the active tab. Input heuristics that protect the default editor's
   * submit behavior (e.g. paste-newline) must not intercept keys then.
   */
  hasEditorReplacement?: () => boolean;
  /**
   * True when a non-editor input component (e.g. the /login provider selector
   * or login dialog) currently owns the input area. When true, all keys must
   * be forwarded to it verbatim, bypassing global key handling — mirroring
   * Pi agent's editorContainer takeover during login.
   */
  hasInputComponent?: () => boolean;
  /** Forward a raw key to the active input component. */
  forwardToInputComponent?: (data: string) => void;
  /** Replace the editor slot with a Component (Pi showSelector / login parity). */
  setInputComponent?: (component: import("@earendil-works/pi-tui").Component, sessionId?: string) => void;
  /** Clear editor-slot input component for the given session (or active). */
  clearInputComponent?: (sessionId?: string) => void;
}

export interface CommandPaletteActions {
  executeCommand: (command: string) => void | Promise<void>;
  extensionCommands?: () => Array<{ name: string; description?: string }>;
}

export type RuntimeToolInfo = {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  sourceInfo?: { path?: unknown; source?: unknown; scope?: unknown; origin?: unknown };
};

export type RuntimeShortcutInfo = {
  key: string;
  description?: string;
  source?: string;
};

export type MixCodeAutocompleteProvider = AutocompleteProvider;
export type MixCodeTab = MixCodeState["tabs"][number];
