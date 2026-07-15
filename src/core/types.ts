import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeUiSettings } from "./mixcode-settings.js";

/** Erased Model type — the TApi type parameter is intentionally erased with `any`
 *  because different models carry incompatible API-specific fields (e.g. `compat`).
 *  Runtime code treats models uniformly while preserving shared metadata such as
 *  `id`, `provider`, `api`, `baseUrl`, `reasoning`, and `contextWindow`. */
export type MixCodeModel = Model<any>;

import type { ChatSelectionState, ChatSurfaceBounds } from "./chat-selection.js";
import type { SessionSelectorState } from "./session-selector.js";
import type { ForkSelectorState } from "../ui/fork-selector.js";
import type { ToastNotification } from "./toast.js";
import type { TreeSelectorState } from "./tree-selector.js";
import type { WorkspaceOverlayState } from "./workspace-ui.js";

export type TabStatus = "Not Ready" | "idle" | "running" | "thinking" | "error" | "done";

export interface QuestionOptionInfo {
  label: string;
  description: string;
}

export interface QuestionInfo {
  question: string;
  header: string;
  options: QuestionOptionInfo[];
  multiple: boolean;
  custom: boolean;
}

export interface DialogRequestState {
  requestId: string;
  sessionId: string;
  questions: QuestionInfo[];
  extensionResolverId?: string;
  extensionUiKind?: "select" | "confirm" | "input";
  currentQuestionIndex: number;
  highlightedOptionIndices: number[];
  selectedAnswers: string[][];
  customAnswers: string[];
  editingCustomIndex?: number;
  dirty: boolean;
}

export type PickerKind = "models" | "thinking" | "theme" | "workdir" | "context-limit";

export interface PickerItem {
  id: string;
  label: string;
  description: string;
  completeValue?: string;
}

export interface PickerState {
  kind: PickerKind;
  title: string;
  query: string;
  selectedIndex: number;
  items: PickerItem[];
  workdirBase?: string;
  /** Current browsing directory for workdir picker (absolute path) */
  browsingDir?: string;
  /** Whether to show hidden directories (starting with .) */
  showHidden?: boolean;
  /**
   * Cached sorted directory names for the workdir picker.
   * Invalidated automatically when browsingDir or showHidden changes.
   */
  workdirListingCache?: {
    browsingDir: string;
    showHidden: boolean;
    dirs: string[];
    error?: string;
  };
  /** When true, the picker is in custom input mode (context-limit) */
  customInputMode?: boolean;
  /** Validation error message for custom input mode */
  customInputError?: string;
}

export interface CommandPaletteState {
  query: string;
  selectedIndex: number;
}

export interface CommandPaletteEntry {
  id: string;
  label: string;
  command: string;
  description: string;
  enabled: boolean;
  disabledReason: string;
}

export interface ExtensionManagerEntryInfo {
  key: string;
  enabled: boolean;
  path: string;
  resolvedPath: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
  toolCount: number;
  commandCount: number;
  toolNames: string[];
  commandNames: string[];
  error?: string;
}

export interface ExtensionManagerPanelState {
  open: boolean;
  selectedIndex: number;
  entries: ExtensionManagerEntryInfo[];
  selectedKeys: string[];
  message: string;
  error: string;
  working: boolean;
}


export interface MixCodeModelRef {
  provider: string;
  modelId: string;
  displayName: string;
  contextWindow: number;
  reasoning?: boolean;
  thinkingLevelMap?: ThinkingLevelMap;
}

export interface MixCodeTabInfo {
  index: number;
  sessionId: string;
  title: string;
  status: TabStatus;
  tokenInput: number;
  tokenOutput: number;
  contextLimit: number;
  /** True when contextLimit was explicitly overridden by the user via /context-limit */
  contextLimitOverridden?: boolean;
  currentContextTokens?: number;
  model: MixCodeModelRef;
  thinkingLevel: ThinkingLevel;
  workdir: string;
  /**
   * True when this tab's base/identity system prompt was overridden (e.g. batch
   * `system_prompt`). UI shows a [sys] badge next to the editor title.
   */
  customBasePrompt?: boolean;
  alias: string;
  pendingDialogs: DialogRequestState[];
  pendingMessages: string[];
  promptHistory: string[];
  draftInput: string;
  chatScrollOffset: number;
  chatScrollAnchorEntryId?: string;
  chatScrollAnchorIndex?: number;
  chatScrollAnchorText?: string;
  previewOpen: boolean;
  previewMessages: PreviewMessage[];
  previewIndex: number;
  previewScrollOffset: number;
  previewHint: string;
  previewPendingHome?: boolean;
  vimMode: boolean;
  vimPendingEscapeAt?: number;
  vimPendingHome?: boolean;
  pendingEscapeAction?: PendingEscapeAction;
  pendingEscapeArmedAt?: number;
  /** Timestamp of last Escape press for double-escape tree detection */
  lastEscapeTime?: number;
  /** Retry state: present when auto-retry is in progress */
  retryInfo?: { attempt: number; maxAttempts: number; delayMs: number; startedAt: number };
  unreadDone: boolean;
  workingStartedAt?: string;
  lastWorkedDurationSeconds?: number;
  /** ISO timestamp captured when work last ended; rendered next to the duration. */
  lastWorkedAt?: string;
  extensionUi: ExtensionUiState;
  /**
   * Non-persisted: startup resource summary ([Context]/[Skills]/[Extensions]/
   * [Tool Owners]/[Diagnostics]) rendered at the top of the scrollable
   * conversation. Lives outside the chat array (Pi's loadedResourcesContainer
   * analogue) so chat rebuilds from session entries can never clear it.
   */
  startupSummary?: string;
  inputMetaHitRegions?: InputMetaHitRegion[];
  /** Non-persisted: screen bounds for the visible Agent message surface. */
  chatSurfaceBounds?: ChatSurfaceBounds;
  /** Non-persisted: active application-level text selection in the Agent message surface. */
  chatSelection?: ChatSelectionState;
  /** Non-persisted: raw rendered Agent message rows before selection highlighting. */
  lastRenderedChatLines?: string[];
  /** Non-persisted: screen bounds for the active input/editor surface. */
  inputSurfaceBounds?: ChatSurfaceBounds;
  /** Non-persisted: active text selection in the input/editor surface. */
  inputSelection?: ChatSelectionState;
  /** Non-persisted: raw rendered input/editor rows before selection highlighting. */
  lastRenderedInputLines?: string[];
  /**
   * Per-tab toggle for the extension widget side panel. When true and the
   * editor input is empty, the aboveEditor/belowEditor widgets are collected
   * into a right-hand vertical split instead of stacking around the editor.
   */
  panelOpen: boolean;
  /**
   * Vertical scroll offset (in rows from the top) for the widget side panel
   * when its content exceeds the visible height. 0 = top. Clamped at render
   * time to the actual overflow. Independent of chat scroll so the two
   * side-by-side regions never fight.
   */
  panelScrollOffset: number;
  /** Non-persisted: screen bounds for the visible widget side panel. */
  panelSurfaceBounds?: ChatSurfaceBounds;
  /** Non-persisted: active text selection inside the widget side panel. */
  panelSelection?: ChatSelectionState;
  /** Non-persisted: raw rendered side-panel rows before selection highlighting. */
  lastRenderedPanelLines?: string[];
  /** Non-persisted: transient toast notification shown in the top-right corner. */
  toast?: ToastNotification;
  /** Non-persisted: generic floating panel anchored by the layout renderer. */
  floatingPanel?: FloatingPanelState;
}

export type FloatingPanelThemeRole =
  | "border"
  | "borderDim"
  | "text"
  | "dim"
  | "subtle"
  | "accent"
  | "danger"
  | "warning"
  | "success"
  | "surface"
  | "panel"
  | "selection"
  | "vimBorder"
  | "userMessage";

export interface FloatingPanelStyle {
  border?: FloatingPanelThemeRole;
  title?: FloatingPanelThemeRole;
  body?: FloatingPanelThemeRole;
  highlighted?: FloatingPanelThemeRole;
}

export interface FloatingPanelState {
  title: string;
  lines: string[];
  highlightedIndex?: number;
  width: number;
  expiresAt: number;
  style?: FloatingPanelStyle;
}

export type PendingEscapeAction = "abort-agent";

export type InputMetaAction = "workdir" | "models" | "thinking";

export type ExtensionWidgetPlacement = "aboveEditor" | "belowEditor";

export interface ExtensionStatusLine {
  key: string;
  text: string;
}

export interface ExtensionWidgetLine {
  key: string;
  placement: ExtensionWidgetPlacement;
  lines: string[];
  /**
   * Render the widget at a given width. `maxLines` caps the output: when
   * omitted the host applies its default editor-area cap (with a "truncated"
   * marker); when provided (e.g. by the side panel) the lines are clipped
   * silently to that budget so the caller renders its own overflow indicator.
   */
  render?: (width: number, maxLines?: number) => string[];
  dispose?: () => void;
}

export interface ExtensionDynamicLines {
  lines: string[];
  render?: (width: number) => string[];
  dispose?: () => void;
}

export interface ExtensionPendingUserInteraction {
  id: string;
  kind: "custom" | "editor";
}

export interface ExtensionUiState {
  statuses: ExtensionStatusLine[];
  widgets: ExtensionWidgetLine[];
  toolsExpanded: boolean;
  pendingUserInteractions: ExtensionPendingUserInteraction[];
  workingIndicatorFrames?: string[];
  workingIndicatorIntervalMs?: number;
  workingMessage?: string;
  workingVisible: boolean;
  title?: string;
  header?: ExtensionDynamicLines;
  footer?: ExtensionDynamicLines;
}

export interface InputMetaHitRegion {
  action: InputMetaAction;
  row: number;
  startX: number;
  endX: number;
}

export type PreviewMessageRole =
  | "user"
  | "assistant"
  | "thinking"
  | "tool"
  | "system"
  | "shell"
  | "empty";

export interface PreviewMessage {
  role: PreviewMessageRole;
  text: string;
}

export type SessionActionConfirm = {
  action: "close" | "delete";
  sessionId: string;
};

export interface MixCodeState {
  workdir: string;
  tabs: MixCodeTabInfo[];
  ui?: MixCodeUiSettings;
  activeTabId: string;
  packageUpdates: string[];
  quitConfirmOpen: boolean;
  deleteAllSessionsConfirmOpen: boolean;
  closeAllSessionsConfirmOpen: boolean;
  sessionActionConfirm: SessionActionConfirm | null;
  commandPaletteOpen: boolean;
  commandPalette: CommandPaletteState;
  extensionManager: ExtensionManagerPanelState;
  sessionSelector: SessionSelectorState;
  forkSelector: ForkSelectorState;
  treeSelector: TreeSelectorState;
  workspaceOverlay: WorkspaceOverlayState;
  tabJumpOpen: boolean;
  tabJumpQuery: string;
  tabJumpIndex: number;
  picker?: PickerState;
  model: MixCodeModelRef;
  thinkingLevel: ThinkingLevel;
  theme: string;
  availableModels: MixCodeModelRef[];
  /**
   * Non-persisted app-level toggle for thinking-block visibility, mirroring
   * Pi's `hideThinkingBlock`. When true, thinking content collapses to a
   * `Thinking...` placeholder across all tabs. Initialized from Pi's
   * SettingsManager at bootstrap; toggled by /hide-thinking, which also writes
   * the value back through the runtime so it survives restarts.
   */
  hideThinkingBlock?: boolean;
  tabBarHitRow?: number;
  /** Absolute 1-indexed terminal row of the tab bar's first line (multi-row aware). */
  tabBarTopRow?: number;
  /** Width used by the last render; lets mouse handlers recompute tab wrap layout. */
  lastRenderWidth?: number;
  /** Non-persisted: selected row index in the Agent View table on MixCode Home. */
  homeSelectedTabIndex: number;
}

export interface WorkspaceTabSnapshot {
  sessionId: string;
  sessionPath?: string;
  title: string;
  workdir: string;
  model?: MixCodeModelRef;
  thinkingLevel?: ThinkingLevel;
}

export interface WorkspaceSnapshot {
  name: string;
  children: string[];
  startupWorkdir: string;
  updatedAt: string;
  activeSessionId?: string;
  tabs: WorkspaceTabSnapshot[];
}

export interface AgentRuntimeConfig {
  systemPrompt?: string;
  model: MixCodeModel;
  thinkingLevel: ThinkingLevel;
  workdir: string;
  sessionId?: string;
}
