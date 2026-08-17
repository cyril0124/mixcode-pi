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
  ModelRuntime,
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
import type { MixCodeTabInfo } from "../core/types.js";
import type { mixcodeFauxStream } from "./faux-stream.js";

export type MixCodeStreamFn = (
  model: MixCodeModel,
  context: Context,
  options?: SimpleStreamOptions,
) => ReturnType<typeof mixcodeFauxStream> | Promise<ReturnType<typeof mixcodeFauxStream>>;
export type RuntimeEvent = AgentSessionEvent | { type: "extension_ui_update" };
/** Extension-facing ModelRegistry facade methods used by MixCode runtime/UI. */
export type RuntimeModelRegistry = Pick<
  ModelRegistry,
  | "find"
  | "getApiKeyAndHeaders"
  | "hasConfiguredAuth"
  | "isUsingOAuth"
  | "registerProvider"
  | "unregisterProvider"
  | "getAll"
  // refresh re-reads models.json from disk; getProviderAuthStatus tells us which
  // providers have credentials so /reload can rebuild the selectable model list.
  | "refresh"
  | "getProviderAuthStatus"
  | "getProviderDisplayName"
  | "getApiKeyForProvider"
>;

export type RuntimeModelRuntime = ModelRuntime;
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
  role: "user" | "assistant" | "thinking" | "tool" | "system" | "extension";
  text: string;
  title?: string;
  variant?: "user-bash" | "system-error" | "system-warning" | "system-plain";
  customType?: string;
  status?: "pending" | "running" | "success" | "error";
  toolCallId?: string;
  entryId?: string;
  /** Epoch ms when a user message was sent; used for right-side clock render. */
  timestamp?: number;
  /** Image blocks from a user message (Pi content array); rendered under the text body. */
  images?: ImageContent[];
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
  /** True for Pi-style transient status lines that coalesce when consecutive. */
  systemStatus?: boolean;
  excludeFromContext?: boolean;
  /**
   * True while a user `!`/`!!` bash block should render in the pending zone
   * (Pi parity: started during agent streaming, stays pending until agent_end).
   */
  pendingBash?: boolean;
  bashExitCode?: number;
  bashCancelled?: boolean;
  bashTruncated?: boolean;
  bashFullOutputPath?: string;
  extensionRendererLastComponent?: Component & { dispose?(): void };
  extensionRendererExpanded?: boolean;
  /** Theme id used when extensionRendererLastComponent was built; invalidate on /theme. */
  extensionRendererThemeId?: string;
  /** outputPad used when extensionRendererLastComponent was built; invalidate on settings change. */
  extensionRendererOutputPad?: number;
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
  /** Count of runtime-mirrored steer messages at the tail of tab.pendingMessages. */
  queuedPromptCount: number;
  /** Count of runtime-mirrored follow-up messages at the tail of tab.pendingFollowUps. */
  queuedFollowUpCount: number;
  /**
   * Serializes replaceRuntimeTabSession on this tab so a concurrent resume/new/fork
   * cannot dispose the session installed by an in-flight replace before bindExtensions.
   */
  replaceLock?: Promise<void>;
  extensionTerminalInputHandlers: Set<TerminalInputHandler>;
  extensionDialogResolvers: Map<string, ExtensionDialogResolver>;
  extensionCustomOverlayClosers: Set<ExtensionCustomOverlayCloser>;
  extensionCustomOverlayHandles: Set<OverlayHandle>;
  /** Live custom overlay components; dump-screen renders these. */
  extensionCustomOverlayComponents: Set<Component>;
  extensionAutocompleteProviderFactories: ExtensionAutocompleteProviderFactory[];
  extensionManagerEntries: ExtensionManagerEntry[];
  extensionAutocompleteProviderCache?: ExtensionAutocompleteProviderCache;
  /**
   * When true, custom messages with display:false are rendered in the chat
   * (with a [hidden] marker). Toggled per tab via /toggle-hidden-messages;
   * intentionally not persisted — it is a session-scoped debugging aid.
   */
  showHiddenMessages?: boolean;
  requestRender?: () => void;
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
  /**
   * One-shot marker set at compaction_end (willRetry): the SDK will continue
   * the run next, so the following agent_start must not restart the timer.
   */
  sdkRunContinuation?: boolean;
  /**
   * When true, agent_end skips auto-flush of queued prompts once.
   * Used by tests and any path that must suppress the idle resend.
   */
  deferPendingMessageFlush?: boolean;
  /** True while compactSession owns a manual compact (covers SDK pre-isCompacting gap). */
  compactionInFlight?: boolean;
  /** Gate to serialize prompt dispatch decisions (user submit, queued flush) at idle→active transition */
  promptDispatchGate?: Promise<void>;
}

export interface ExtensionManagerStore {
  load: () => Promise<ExtensionManagerConfig>;
  save: (config: ExtensionManagerConfig) => Promise<void>;
}

export type RuntimeExtensionManagerEntry = ExtensionManagerEntry;
export type RuntimeExtensionReloadResult = ExtensionReloadResult;
