import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Component, TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime } from "../agent/runtime.js";
import type { MixCodeState, MixCodeTabInfo } from "../core/types.js";

// UI host surface is the real runtime. Do not reintroduce Partial/Pick kitchen
// sinks here — narrow at the call site only when a helper truly needs 1–2 methods.
// Tests mock with `as MixCodeRuntime` / `as unknown as MixCodeRuntime`.
export type MixCodeKeyRuntime = MixCodeRuntime;
export type MixCodeSubmitRuntime = MixCodeRuntime;

export interface AuthInputHost {
  setInputComponent: (component: Component, sessionId?: string) => void;
  clearInputComponent: (sessionId?: string) => void;
  requestRender: () => void;
}

export interface SettingsPanelDependencies {
  settingsManager: SettingsManager;
  mixcodeFile: string;
  piSettingsFile: string;
}

export const SKIP_FINALIZE = Symbol("skip-finalize");

export interface LocalCommandContext {
  state: MixCodeState;
  runtime: MixCodeSubmitRuntime;
  active: MixCodeTabInfo | undefined;
  args: string;
  tui: OverlayTui;
  onStateChanged?: (state: MixCodeState) => void | Promise<void>;
  authInputHost?: AuthInputHost;
  workspaceFile?: string;
  settingsDeps?: SettingsPanelDependencies;
  editorActions?: Pick<MixCodeEditorActions, "setText"> &
    Partial<Pick<MixCodeEditorActions, "getText">>;
}

export type LocalCommandHandler = (
  context: LocalCommandContext,
) => undefined | typeof SKIP_FINALIZE | Promise<undefined | typeof SKIP_FINALIZE>;

export type RuntimeChangeSource = Pick<MixCodeRuntime, "onChange">;
export interface WorkspaceKeyOptions {
  workspaceFile?: string;
  /** Agent-dir state root; when set, Home sends also append conversation history. */
  rootStateDir?: string;
  /** Settings dependencies required by config-scoped commands entered from Home. */
  settingsDeps?: SettingsPanelDependencies;
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
    /**
     * Renderer-only terminal handoff for external processes (e.g. $EDITOR).
     * Unlike stop()/start() — the app-shutdown path that disposes the ctl
     * server, instance heartbeat, and peer tab sync — pause()/resume() only
     * release and re-take the terminal.
     */
    pause?: () => void;
    resume?: () => void;
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
   * True when a non-editor input component (e.g. the /login provider selector
   * or login dialog) currently owns the input area. When true, all keys must
   * be forwarded to it verbatim, bypassing global key handling — mirroring
   * Pi agent's editorContainer takeover during login.
   */
  hasInputComponent?: () => boolean;
  /** Forward a raw key to the active input component. */
  forwardToInputComponent?: (data: string) => void;
  /** Replace the editor slot with a Component (Pi showSelector / login parity). */
  setInputComponent?: (component: Component, sessionId?: string) => void;
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
