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
    | "dispatchExtensionShortcut"
    | "dispatchTerminalInput"
    | "extensionSwitchSession"
    | "flushPendingMessage"
    | "focusExtensionCustomOverlay"
    | "getAllExtensionCommands"
    | "getExtensionCommands"
    | "getExtensionManagerEntries"
    | "getExtensionTools"
    | "getTab"
    | "getPromptHistory"
    | "hasExtensionCustomOverlay"
    | "listAllSessions"
    | "prompt"
    | "popPendingMessage"
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
    | "listSessions"
    | "listAllSessions"
    | "reloadExtensionManagerTab"
    | "reloadExtensionManagerWorkdir"
    | "reloadModelConfig"
    | "renameSession"
    | "resolveModel"
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
}

export interface TreeSelectorDisplayHost {
  open: (
    sessionId: string,
    runtime?: unknown,
    onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  ) => void;
  refresh: () => void;
  close: (sessionId?: string) => void;
}

export type OverlayTui = Pick<TuiType, "requestRender" | "showOverlay"> &
  Partial<Pick<TuiType, "hideOverlay" | "hasOverlay" | "setFocus" | "start" | "stop">> & {
    treeSelectorDisplay?: TreeSelectorDisplayHost;
  };

export interface MixCodeEditorActions {
  getText: () => string;
  setText: (text: string) => void;
  addToHistory?: (text: string, sessionId?: string) => void;
  insertTextAtCursor?: (text: string) => void;
  submitCurrentText?: () => void;
}

export interface CommandPaletteActions {
  executeCommand: (command: string) => void | Promise<void>;
  extensionCommands?: () => Array<{ name: string; description?: string }>;
}

export interface ExportChooserActions {
  editor?: string;
}

export interface ExportRequest {
  target: string;
  editor?: string;
  editorDisabled?: boolean;
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
