import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import type { Model, ThinkingLevelMap } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { MixCodeUiSettings, RawMixCodeSettings } from "./mixcode-settings.js";

/** Pi SettingsManager markdown.mermaid (not re-exported from package entry). */
export type MermaidRenderingMode = "off" | "final" | "streaming";

/** Erased Model type — the TApi type parameter is intentionally erased with `any`
 *  because different models carry incompatible API-specific fields (e.g. `compat`).
 *  Runtime code treats models uniformly while preserving shared metadata such as
 *  `id`, `provider`, `api`, `baseUrl`, `reasoning`, and `contextWindow`. */
export type MixCodeModel = Model<any>;

import type { ChatSelectionState, ChatSurfaceBounds } from "./chat-selection.js";
import type { SessionSelectorState } from "./session-selector.js";
import type { ForkSelectorState } from "./fork-selector.js";
import type { ToastNotification } from "./toast.js";
import type { TreeSelectorState } from "./tree-selector.js";
import type { WorkspaceOverlayState } from "./workspace-ui.js";

export type TabStatus = "Not Ready" | "idle" | "running" | "thinking" | "error" | "done";

/** Sentinel `activeTabId` / tab-bar id for MixCode Home. */
export const HOME_TAB_ID = "home";
export type CompactionReason = "manual" | "threshold" | "overflow";

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

export type PickerKind = "models" | "thinking" | "workdir" | "context-limit";

export interface PickerItem {
  id: string;
  label: string;
  description: string;
  completeValue?: string;
  /** When true, item is visible but not selectable (e.g. disabled model). */
  disabled?: boolean;
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

/** State for the /settings floating overlay panel. */
export interface SettingsPanelState {
  open: boolean;
  selectedIndex: number;
  /** Main-list filter; optional for restored/test state created before search existed. */
  filterQuery?: string;
  editMode: boolean;
  editText: string;
  /** Inline validation error shown in the settings footer while editing. */
  editError?: string;
  enumOpen: boolean;
  enumIndex: number;
  /** Snapshot of raw mixcode settings; mutated in place on write. */
  mixcodeRaw: RawMixCodeSettings;
  mixcodeFile: string;
  /** Absolute path to Pi global settings.json (display only). */
  piSettingsFile: string;
  /** Bound at open time so key handlers can write Pi settings. */
  settingsManager?: SettingsManager;
  setHideThinkingBlock?: (hide: boolean) => Promise<void>;
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
  detailScrollOffset: number;
  searchActive: boolean;
  searchQuery: string;
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
  /** Stamped from mixcode_settings disabled lists at bootstrap/reload. */
  disabled?: boolean;
}

export interface VimTranscriptSearchSnapshot {
  query: string;
  selectedIndex: number;
  resultCount: number;
  selectedKey?: string;
  chatScrollOffset: number;
  chatScrollAnchorEntryId?: string;
  chatScrollAnchorIndex?: number;
  chatScrollAnchorText?: string;
  editorText: string;
}

export interface VimTranscriptSearchState {
  query: string;
  selectedIndex: number;
  resultCount: number;
  selectedKey?: string;
  selectionMode: "query" | "next" | "previous" | "retain";
  anchorRow: number;
  /** Resolve the windowed renderer's estimated row against the full search corpus once. */
  anchorPending?: boolean;
  promptOpen: boolean;
  cancelSnapshot?: VimTranscriptSearchSnapshot;
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
  /** Follow-up queue (delivered after the agent is fully idle). Separate from steer pendingMessages. */
  pendingFollowUps: string[];
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
  /** Non-persisted Vim transcript search state; rendered corpus lives in a WeakMap cache. */
  vimTranscriptSearch?: VimTranscriptSearchState;
  /** Restore draftInput into the live editor after a non-editor lifecycle clears search. */
  vimSearchDraftRestorePending?: boolean;
  vimPendingEscapeAt?: number;
  vimPendingHome?: boolean;
  /** Timestamp when empty-queue Ctrl+U armed enter-via-u; cleared on next key. */
  vimEnterArmedAt?: number;
  /** Distraction-free chrome: hide tab bar; tab/shift-tab swallowed; ctrl+t transfers. */
  zenMode: boolean;
  /**
   * Per-tab toggle: render aboveEditor/belowEditor widgets at the chat tail
   * (after messages, before Steer/Follow-up) instead of around the editor.
   * Non-persisted; migrates with the active agent like zen/vim.
   */
  inlineWidgets: boolean;
  pendingEscapeAction?: PendingEscapeAction;
  pendingEscapeArmedAt?: number;
  /** Timestamp of last Escape press for double-escape tree detection */
  lastEscapeTime?: number;
  /** Retry state: present when auto-retry is in progress */
  retryInfo?: { attempt: number; maxAttempts: number; delayMs: number; startedAt: number };
  unreadDone: boolean;
  workingStartedAt?: string;
  /** Non-persisted: reason for the active Pi compaction operation. */
  activeCompactionReason?: CompactionReason;
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
  /** Full startup resource detail, shown while the existing tool expansion is active. */
  startupSummary?: string;
  /** Pi-style compact startup resource detail, shown by default. */
  startupSummaryCompact?: string;
  inputMetaHitRegions?: InputMetaHitRegion[];
  /** Non-persisted: screen bounds for the visible Agent message surface. */
  chatSurfaceBounds?: ChatSurfaceBounds;
  /** Non-persisted: active application-level text selection in the Agent message surface. */
  chatSelection?: ChatSelectionState;
  /** Non-persisted: raw rendered Agent message rows before selection highlighting. */
  lastRenderedChatLines?: string[];
  /** Non-persisted: last chat scroll metrics for scrollbar and edge-drag mapping. */
  lastChatScrollMetrics?: {
    total: number;
    viewport: number;
    start: number;
    end: number;
    scrollable: boolean;
  };
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
  | "borderMuted"
  | "text"
  | "dim"
  | "muted"
  | "accent"
  | "error"
  | "warning"
  | "success"
  | "surface"
  | "panel"
  | "selectedBg"
  | "vimBorder"
  | "userMessageBg";

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

export interface WaitingForInput {
  id: string;
  kind: "custom" | "editor";
}

export interface ExtensionUiState {
  statuses: ExtensionStatusLine[];
  widgets: ExtensionWidgetLine[];
  toolsExpanded: boolean;
  waitingForInputs: WaitingForInput[];
  workingIndicatorFrames?: string[];
  workingIndicatorIntervalMs?: number;
  workingMessage?: string;
  workingVisible: boolean;
  title?: string;
  /** Pi setHiddenThinkingLabel — placeholder when thinking blocks are collapsed. */
  hiddenThinkingLabel?: string;
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
  /** In-process MRU of agent tabs (max 3). Home is never recorded. */
  recentAgentTabIds: string[];
  packageUpdates: string[];
  quitConfirmOpen: boolean;
  deleteAllSessionsConfirmOpen: boolean;
  closeAllSessionsConfirmOpen: boolean;
  sessionActionConfirm: SessionActionConfirm | null;
  commandPaletteOpen: boolean;
  commandPalette: CommandPaletteState;
  settingsPanel: SettingsPanelState;
  extensionManager: ExtensionManagerPanelState;
  sessionSelector: SessionSelectorState;
  forkSelector: ForkSelectorState;
  treeSelector: TreeSelectorState;
  workspaceOverlay: WorkspaceOverlayState;
  tabJumpOpen: boolean;
  tabJumpQuery: string;
  tabJumpIndex: number;
  /** While Tab Jump is open: when true, list non-idle/attention tabs only. Reset on open/close. */
  tabJumpNonIdleOnly: boolean;
  picker?: PickerState;
  model: MixCodeModelRef;
  thinkingLevel: ThinkingLevel;
  theme: string;
  availableModels: MixCodeModelRef[];
  /** In-memory copy of mixcode_settings disabledProviders; applied on bootstrap/reload. */
  disabledProviders: string[];
  /** In-memory copy of mixcode_settings disabledModels; applied on bootstrap/reload. */
  disabledModels: string[];
  /**
   * Non-persisted app-level toggle for thinking-block visibility, mirroring
   * Pi's `hideThinkingBlock`. When true, thinking content collapses to a
   * `Thinking...` placeholder across all tabs. Initialized from Pi's
   * SettingsManager at bootstrap; toggled by /hide-thinking, which also writes
   * the value back through the runtime so it survives restarts.
   */
  hideThinkingBlock?: boolean;
  /**
   * Live mirrors of Pi SettingsManager terminal/markdown fields used by the
   * chat surface. Bootstrap + /settings write them; renderers read state only
   * (no per-frame SettingsManager disk access).
   */
  showImages?: boolean;
  imageWidthCells?: number;
  mermaidRenderingMode?: MermaidRenderingMode; // Pi markdown.mermaid
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
