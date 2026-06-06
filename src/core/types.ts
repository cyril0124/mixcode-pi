import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { ChatSelectionState, ChatSurfaceBounds } from "./chat-selection.js";
import type { SessionSelectorState } from "./session-selector.js";
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
  alias: string;
  pendingDialogs: DialogRequestState[];
  pendingMessages: string[];
  promptHistory: string[];
  draftInput: string;
  chatScrollOffset: number;
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
  unreadDone: boolean;
  workingStartedAt?: string;
  lastWorkedDurationSeconds?: number;
  extensionUi: ExtensionUiState;
  inputMetaHitRegions?: InputMetaHitRegion[];
  /** Non-persisted: screen bounds for the visible Agent message surface. */
  chatSurfaceBounds?: ChatSurfaceBounds;
  /** Non-persisted: active application-level text selection in the Agent message surface. */
  chatSelection?: ChatSelectionState;
  /** Non-persisted: raw rendered Agent message rows before selection highlighting. */
  lastRenderedChatLines?: string[];
  /** Non-persisted: transient toast notification shown in the top-right corner. */
  toast?: ToastNotification;
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
  render?: (width: number) => string[];
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
  hiddenThinkingLabel?: string;
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

export interface MixCodeState {
  workdir: string;
  tabs: MixCodeTabInfo[];
  activeTabId: string;
  packageUpdates: string[];
  exportChooserOpen: boolean;
  exportChooserIndex: number;
  quitConfirmOpen: boolean;
  commandPaletteOpen: boolean;
  commandPalette: CommandPaletteState;
  extensionManager: ExtensionManagerPanelState;
  sessionSelector: SessionSelectorState;
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
  tabBarHitRow?: number;
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
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  workdir: string;
  sessionId?: string;
}
