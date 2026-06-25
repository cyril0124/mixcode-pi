import type { Agent } from "@earendil-works/pi-agent-core";
import type {
  Context,
  ImageContent,
  SimpleStreamOptions,
  TextContent,
} from "@earendil-works/pi-ai";
import type { MixCodeModel } from "../core/types.js";
import type {
  AgentSession,
  AgentSessionEvent,
  AgentSessionServices,
  CreateAgentSessionServicesOptions,
  ExtensionCommandContextActions,
  KeybindingsManager as ExtensionKeybindingsManager,
  ExtensionUIContext,
  LoadExtensionsResult,
  ModelRegistry,
  SessionManager,
  SessionShutdownEvent,
  TerminalInputHandler,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type {
  AutocompleteItem,
  AutocompleteProvider,
  Component,
  OverlayHandle,
  TUI as PiTui,
} from "@earendil-works/pi-tui";
import type {
  ExtensionManagerConfig,
  ExtensionManagerEntry,
  ExtensionReloadResult,
} from "../core/extension-manager.js";
import type { ExtensionToolOwnerPolicy } from "../core/extension-tool-owners.js";
import type { MixCodeTabInfo } from "../core/types.js";
import type { mixcodeFauxStream } from "./faux-stream.js";
import type { ToolLog } from "./tools.js";

export type MixCodeStreamFn = (
  model: MixCodeModel,
  context: Context,
  options?: SimpleStreamOptions,
) => ReturnType<typeof mixcodeFauxStream> | Promise<ReturnType<typeof mixcodeFauxStream>>;
export type RuntimeEvent = AgentSessionEvent | { type: "extension_ui_update" };
export type RuntimeModelRegistry = Pick<
  ModelRegistry,
  | "find"
  | "getApiKeyAndHeaders"
  | "hasConfiguredAuth"
  | "isUsingOAuth"
  | "registerProvider"
  | "getAll"
  // refresh re-reads models.json from disk; getProviderAuthStatus tells us which
  // providers have credentials so /reload can rebuild the selectable model list.
  | "refresh"
  | "getProviderAuthStatus"
>;
export type ExtensionArgumentCompleter = (
  argumentPrefix: string,
) => AutocompleteItem[] | null | Promise<AutocompleteItem[] | null>;
export type ExtensionAutocompleteProviderFactory = Parameters<
  ExtensionUIContext["addAutocompleteProvider"]
>[0];
export type EditorFactory = NonNullable<Parameters<ExtensionUIContext["setEditorComponent"]>[0]>;
export type SystemPromptOverride = NonNullable<
  CreateAgentSessionServicesOptions["resourceLoaderOptions"]
>["systemPromptOverride"];

export interface ChatLine {
  role: "user" | "assistant" | "thinking" | "tool" | "system" | "extension" | "startup";
  text: string;
  title?: string;
  variant?: "user-bash";
  customType?: string;
  status?: "pending" | "running" | "success" | "error";
  toolCallId?: string;
  entryId?: string;
  args?: unknown;
  renderExtension?: (width: number) => string[];
  renderToolCall?: (width: number) => string[];
  renderToolResult?: (width: number) => string[];
  toolRenderShell?: "default" | "self";
  toolResult?: ToolResultLike;
  toolIsPartial?: boolean;
  toolExpanded?: boolean;
  branchSummary?: boolean;
  compactionSummary?: boolean;
  compactionTokensBefore?: number;
  excludeFromContext?: boolean;
  bashExitCode?: number;
  bashCancelled?: boolean;
  bashTruncated?: boolean;
  bashFullOutputPath?: string;
  extensionRendererLastComponent?: Component & { dispose?(): void };
  extensionRendererExpanded?: boolean;
  toolRendererState?: Record<string, unknown>;
  toolCallRendererLastComponent?: Component & { dispose?(): void };
  toolResultRendererLastComponent?: Component & { dispose?(): void };
}

export interface CustomMessageLike {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp: number;
}

export type ToolResultLike = {
  content: (TextContent | ImageContent)[];
  details?: unknown;
  isError: boolean;
};

export type TerminalInputResult = ReturnType<TerminalInputHandler>;
export type ExtensionDialogResolver = (result: string | boolean | undefined) => void;
export type ExtensionCustomComponent = Component & {
  dispose?(): void;
  onInput?: (data: string) => void;
};
export type ExtensionCustomFactory<T> = (
  tui: PiTui,
  theme: Theme,
  keybindings: ExtensionKeybindingsManager,
  done: (result: T) => void,
) => ExtensionCustomComponent | Promise<ExtensionCustomComponent>;
export type ExtensionCustomOptions = Parameters<ExtensionUIContext["custom"]>[1];
export type ExtensionCustomOverlayCloser = () => void;
export type ExtensionFooterFactory = NonNullable<Parameters<ExtensionUIContext["setFooter"]>[0]>;
export type ExtensionHeaderFactory = NonNullable<Parameters<ExtensionUIContext["setHeader"]>[0]>;
export type ExtensionNewSessionOptions = Parameters<
  ExtensionCommandContextActions["newSession"]
>[0];
export type ExtensionForkOptions = Parameters<ExtensionCommandContextActions["fork"]>[1];
export type ExtensionNavigateTreeOptions = Parameters<
  ExtensionCommandContextActions["navigateTree"]
>[1];
export type ExtensionSwitchSessionOptions = Parameters<
  ExtensionCommandContextActions["switchSession"]
>[1];
export type SessionReplacementReason = Extract<
  SessionShutdownEvent["reason"],
  "new" | "resume" | "fork"
>;

export interface ExtensionEditorHost {
  getText: (sessionId?: string) => string;
  getExpandedText?: (sessionId?: string) => string;
  setText: (text: string, sessionId?: string) => void;
  pasteToEditor: (text: string, sessionId?: string) => void;
  setAutocompleteProvider?: (provider: AutocompleteProvider) => void;
  setEditorComponent?: (factory: EditorFactory | undefined, sessionId?: string) => void;
  getEditorComponent?: (sessionId?: string) => EditorFactory | undefined;
  getEmbeddedTerminalRows?: (sessionId?: string) => number | undefined;
}

export interface ExtensionCustomUiHost {
  tui: PiTui;
  editor?: ExtensionEditorHost;
  themes?: ExtensionThemeHost;
  isSessionActive?: (sessionId: string) => boolean;
  topReservedRows?: (sessionId: string) => number;
}

export interface ExtensionThemeHost {
  getTheme: () => string;
  setTheme: (themeId: string) => void;
  requestRender?: () => void;
}

export interface ExtensionAutocompleteProviderCache {
  base: AutocompleteProvider;
  factoryCount: number;
  provider: AutocompleteProvider;
}

export interface RuntimeTab {
  tab: MixCodeTabInfo;
  agentSession: AgentSession;
  services: AgentSessionServices;
  extensionsResult: LoadExtensionsResult;
  agent: Agent;
  session: SessionManager;
  chat: ChatLine[];
  reasoning: string[];
  toolLog: ToolLog;
  queuedPromptCount: number;
  extensionTerminalInputHandlers: Set<TerminalInputHandler>;
  extensionDialogResolvers: Map<string, ExtensionDialogResolver>;
  extensionCustomOverlayClosers: Set<ExtensionCustomOverlayCloser>;
  extensionCustomOverlayHandles: Set<OverlayHandle>;
  extensionAutocompleteProviderFactories: ExtensionAutocompleteProviderFactory[];
  extensionManagerEntries: ExtensionManagerEntry[];
  extensionToolOwnerPolicy: ExtensionToolOwnerPolicy;
  extensionAutocompleteProviderCache?: ExtensionAutocompleteProviderCache;
  requestRender?: () => void;
  streamingReasoning?: {
    entries: Map<number, number>;
  };
  currentRunChatStartIndex?: number;
  streamingAssistant?: {
    chatIndex?: number;
    blockIndices: Map<number, number>;
    toolCallIndices: Map<string, number>;
    previewIndex?: number;
    tokenInput: number;
    tokenOutput: number;
  };
  /** Start time from the just-ended run, reused if SDK post-run compaction starts immediately. */
  postRunWorkingStartedAt?: string;
  /** Set by mid-turn compaction hook when compaction pressure terminates the tool loop */
  pendingContextLimitCompaction?: boolean;
  /** Skip the next pending-message flush after auto-compaction takes over */
  deferPendingMessageFlush?: boolean;
  /** True while the context-limit auto-compaction cycle owns follow-up work */
  autoCompactCycleActive?: boolean;
  /** True when that cycle observes a compaction_end without a result */
  autoCompactCycleFailed?: boolean;
  /** True while autoCompactAndContinue is running */
  isAutoCompacting?: boolean;
}

export interface ExtensionManagerStore {
  load: () => Promise<ExtensionManagerConfig>;
  save: (config: ExtensionManagerConfig) => Promise<void>;
}

export type RuntimeExtensionManagerEntry = ExtensionManagerEntry;
export type RuntimeExtensionReloadResult = ExtensionReloadResult;
