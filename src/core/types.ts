import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";

import type { SessionSelectorState } from "./session-selector.js";
import type { TreeSelectorState } from "./tree-selector.js";

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

export type PickerKind = "models" | "thinking" | "theme" | "workdir";

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

export interface UsageSnapshot {
  totalInput: number;
  totalOutput: number;
  totalReasoning: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  currentContextTokens?: number;
  version: string;
}

export interface GoalState {
  objective: string;
  status: "active" | "paused" | "complete" | "error";
  createdAt: string;
  updatedAt: string;
  lastError: string;
  lastErrorAt: string;
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
  currentContextTokens?: number;
  model: MixCodeModelRef;
  thinkingLevel: ThinkingLevel;
  workdir: string;
  alias: string;
  todoVisible: boolean;
  todos: TodoItem[];
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
  shellOpen: boolean;
  shellSession?: ShellSessionInfo;
  shellScrollOffset: number;
  goal?: GoalState;
  redoSessionId?: string;
  pendingEscapeAction?: PendingEscapeAction;
  pendingEscapeArmedAt?: number;
  unreadDone: boolean;
  workingStartedAt?: string;
  lastWorkedDurationSeconds?: number;
  extensionUi: ExtensionUiState;
  inputMetaHitRegions?: InputMetaHitRegion[];
}

export type PendingEscapeAction = "abort-agent" | "close-shell" | "reject-question";

export type InputMetaAction = "workdir" | "models" | "thinking";
export type ConfigAction =
  | "new-session"
  | "theme"
  | "save-workspace"
  | "restore-workspace"
  | "delete-workspace";

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

export interface ConfigActionHitRegion {
  action: ConfigAction;
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

export interface ShellSessionInfo {
  cwd: string;
  pid?: number;
  command: string;
  buffer: string[];
  input: string;
  alternateScreen?: boolean;
  normalMouse?: boolean;
  sgrMouse?: boolean;
  exitCode?: number;
  signal?: string;
}

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority?: "low" | "medium" | "high";
}

export interface MixCodeState {
  workdir: string;
  mainSessionId: string;
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
  tabJumpOpen: boolean;
  tabJumpQuery: string;
  tabJumpIndex: number;
  picker?: PickerState;
  connected: boolean;
  model: MixCodeModelRef;
  thinkingLevel: ThinkingLevel;
  theme: string;
  availableModels: MixCodeModelRef[];
  tabBarHitRow?: number;
  configActionHitRegions?: ConfigActionHitRegion[];
}

export interface WorkspaceSnapshot {
  name: string;
  children: string[];
  startupWorkdir: string;
  updatedAt: string;
}

export interface AgentRuntimeConfig {
  systemPrompt?: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  workdir: string;
  sessionId?: string;
}
