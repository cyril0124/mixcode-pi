import type { Model } from "@earendil-works/pi-ai";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionServices,
  type AuthStorage,
  type CreateAgentSessionResult,
  type CreateAgentSessionServicesOptions,
  calculateContextTokens,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ModelRegistry,
  type SessionManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
  type SettingsManager,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import { detectSearchTools, type SearchToolAvailability } from "../core/detect-search-tools.js";
import {
  type ExtensionManagerEntry,
  extensionManagerEntriesFromResult,
  filterDisabledExtensions,
} from "../core/extension-manager.js";
import {
  buildMixCodeSystemPromptFromParts,
  buildMixCodeSystemPromptOptionsFromSession,
  MIXCODE_SYSTEM_PROMPT,
} from "../core/system-prompt.js";
import type { AgentRuntimeConfig, MixCodeTabInfo } from "../core/types.js";
import type { MixCodeRuntime } from "./runtime.js";
import {
  applyRuntimeTabModel,
  disposeChatRenderers,
  entriesToChatLines,
  resetTabForNewSession,
  syncContextUsage,
  syncPreviewFromChat,
} from "./runtime-chat.js";
import {
  appendExtensionConflictDiagnostics,
  appendExtensionLoadErrors,
  createExtensionCommandActions,
  createMixCodeExtensionUiContext,
  disposeExtensionWidgets,
} from "./runtime-extension-ui.js";
import { consumeDeferredPendingMessageFlush } from "./runtime-follow-up.js";
import {
  buildMixCodeSystemPromptOverride,
  registerMixCodeRuntimeProvider,
} from "./runtime-provider.js";
import { resetExtensionHostState } from "./runtime-session.js";
import type {
  ChatLine,
  ExtensionCustomUiHost,
  MixCodeStreamFn,
  RuntimeEvent,
  RuntimeModelRegistry,
  RuntimeTab,
  SessionReplacementReason,
} from "./runtime-types.js";
import { activateMixCodeTools, ToolLog } from "./tools.js";

export type RuntimeTabConfig = Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
  model?: Model<any>;
  suppressStartupSummary?: boolean;
};

const extensionManagerEntriesByServices = new WeakMap<
  AgentSessionServices,
  ExtensionManagerEntry[]
>();

export interface RuntimeServiceOptions {
  workdir: string;
  systemPrompt?: string;
  agentDir: string;
  authStorage?: AuthStorage;
  modelRegistry?: RuntimeModelRegistry;
  settingsManager?: SettingsManager;
  resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
  additionalExtensionPaths?: string[];
  extensionFactories?: ExtensionFactory[];
  getDisabledExtensionKeys?: (workdir: string) => ReadonlySet<string>;
}

export interface RuntimeLifecycleContext {
  runtime: MixCodeRuntime;
  tabs: Map<string, RuntimeTab>;
  getExtensionUiHost: () => ExtensionCustomUiHost | undefined;
  emitChange: (event: RuntimeEvent, runtimeTab: RuntimeTab) => void;
  applyEvent: (runtimeTab: RuntimeTab, event: RuntimeEvent) => void;
  schedulePendingMessageFlush: (
    sessionId: string,
    agentSession: RuntimeTab["agentSession"],
  ) => void;
  createServices: (workdir: string, systemPrompt?: string) => Promise<AgentSessionServices>;
  resolveModel: (provider: string, modelId: string) => Model<any>;
  resolveModelFromSession: (
    session: SessionManager,
    fallback: MixCodeTabInfo["model"] | Model<any> | undefined,
  ) => Model<any>;
  streamFn?: MixCodeStreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getDisabledExtensionKeys?: (workdir: string) => ReadonlySet<string>;
}

export async function createRuntimeTab(
  tab: MixCodeTabInfo,
  session: SessionManager,
  config: RuntimeTabConfig,
  context: RuntimeLifecycleContext,
): Promise<RuntimeTab> {
  const toolLog = new ToolLog();
  const model = config.model
    ? config.model
    : context.resolveModel(tab.model.provider, tab.model.modelId);
  const services = await context.createServices(config.workdir, config.systemPrompt);
  registerMixCodeRuntimeProvider(
    services.modelRegistry,
    model,
    context.streamFn,
    context.getApiKey,
  );
  const { session: agentSession, extensionsResult } = await createAgentSessionFromServices({
    services,
    sessionManager: session,
    model,
    thinkingLevel: config.thinkingLevel,
  });
  activateMixCodeTools(agentSession);
  applyMixCodeSystemPrompt(runtimeTabPromptOptions(services, config.workdir), agentSession);
  // Mid-turn compaction check: after each tool call, if context exceeds the threshold,
  // signal terminate=true so the agent loop exits cleanly (agent_end). The runtime
  // then waits for idle, compacts, and continues from the compacted transcript.
  const runtimeTabRef: { current?: RuntimeTab } = {};
  installMidTurnCompactionHook(agentSession, tab, runtimeTabRef);
  const runtimeTab: RuntimeTab = {
    tab,
    agentSession,
    services,
    extensionsResult,
    agent: agentSession.agent,
    session,
    chat: [],
    reasoning: [],
    toolLog,
    queuedPromptCount: 0,
    extensionTerminalInputHandlers: new Set(),
    extensionDialogResolvers: new Map(),
    extensionCustomOverlayClosers: new Set(),
    extensionCustomOverlayHandles: new Set(),
    extensionAutocompleteProviderFactories: [],
    extensionManagerEntries: getExtensionManagerEntriesForServices(services),
  };
  runtimeTab.requestRender = () => context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  runtimeTabRef.current = runtimeTab;
  const restoredChat = await rebuildRuntimeChat(runtimeTab);
  if (tab.previewMessages.length === 0) {
    syncPreviewFromChat(tab, restoredChat);
  }
  tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    pendingUserInteractions: [],
    workingVisible: true,
  };
  runtimeTab.chat = restoredChat;
  if (!config.suppressStartupSummary) {
    const summary = startupResourceSummary(runtimeTab);
    if (summary) runtimeTab.chat.unshift({ role: "startup", text: summary });
  }
  syncContextUsage(runtimeTab);
  appendExtensionDiagnostics(runtimeTab);
  subscribeRuntimeTab(runtimeTab, context);
  await bindRuntimeExtensions(runtimeTab, context);
  context.tabs.set(tab.sessionId, runtimeTab);
  return runtimeTab;
}

export async function createAgentSessionForReplacement(
  sessionManager: SessionManager,
  config: RuntimeTabConfig & { sessionStartEvent: SessionStartEvent },
  context: RuntimeLifecycleContext,
): Promise<CreateAgentSessionResult & { services: AgentSessionServices; toolLog: ToolLog }> {
  const toolLog = new ToolLog();
  const model = config.model
    ? config.model
    : context.resolveModelFromSession(sessionManager, config.model);
  const services = await context.createServices(config.workdir, config.systemPrompt);
  registerMixCodeRuntimeProvider(
    services.modelRegistry,
    model,
    context.streamFn,
    context.getApiKey,
  );
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: config.thinkingLevel,
    sessionStartEvent: config.sessionStartEvent,
  });
  activateMixCodeTools(result.session);
  applyMixCodeSystemPrompt(runtimeTabPromptOptions(services, config.workdir), result.session);
  return { ...result, services, toolLog };
}

export async function shutdownRuntimeTab(
  runtimeTab: RuntimeTab,
  event: SessionShutdownEvent,
  extensionUiHost: ExtensionCustomUiHost | undefined,
): Promise<void> {
  await runtimeTab.agentSession.extensionRunner.emit(event);
  disposeRuntimeTabAfterShutdown(runtimeTab, extensionUiHost);
}

export function disposeRuntimeTabAfterShutdown(
  runtimeTab: RuntimeTab,
  extensionUiHost: ExtensionCustomUiHost | undefined,
): void {
  disposeChatRenderers(runtimeTab.chat);
  runtimeTab.agentSession.dispose();
  resetExtensionHostState(runtimeTab, extensionUiHost);
}

export async function replaceRuntimeTabSession(
  runtimeTab: RuntimeTab,
  sessionManager: SessionManager,
  reason: SessionReplacementReason,
  context: RuntimeLifecycleContext,
): Promise<RuntimeTab> {
  if (runtimeTab.agentSession.isStreaming) {
    throw new Error(`Cannot replace a session while the agent is streaming: ${reason}`);
  }
  const previousSessionId = runtimeTab.tab.sessionId;
  const previousSessionFile = runtimeTab.session.getSessionFile();
  const targetSessionFile = sessionManager.getSessionFile() ?? undefined;
  const model = context.resolveModelFromSession(sessionManager, runtimeTab.tab.model);
  await shutdownRuntimeTab(
    runtimeTab,
    {
      type: "session_shutdown",
      reason,
      targetSessionFile,
    },
    context.getExtensionUiHost(),
  );
  const created = await createAgentSessionForReplacement(
    sessionManager,
    {
      systemPrompt: MIXCODE_SYSTEM_PROMPT,
      thinkingLevel: runtimeTab.tab.thinkingLevel,
      workdir: sessionManager.getCwd(),
      model,
      sessionStartEvent: { type: "session_start", reason, previousSessionFile },
    },
    context,
  );
  resetTabForNewSession(runtimeTab.tab, sessionManager.getSessionId());
  runtimeTab.tab.workdir = sessionManager.getCwd();
  context.tabs.delete(previousSessionId);
  runtimeTab.agentSession = created.session;
  runtimeTab.services = created.services;
  runtimeTab.extensionsResult = created.extensionsResult;
  runtimeTab.extensionManagerEntries = getExtensionManagerEntriesForServices(created.services);
  runtimeTab.agent = created.session.agent;
  runtimeTab.session = sessionManager;
  runtimeTab.toolLog = created.toolLog;
  runtimeTab.queuedPromptCount = 0;
  runtimeTab.streamingAssistant = undefined;
  runtimeTab.streamingReasoning = undefined;
  installMidTurnCompactionHook(created.session, runtimeTab.tab, { current: runtimeTab });
  runtimeTab.chat = await rebuildRuntimeChat(runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  applyRuntimeTabModel(runtimeTab, created.session.agent.state.model);
  runtimeTab.tab.thinkingLevel = created.session.agent.state.thinkingLevel;
  disposeExtensionWidgets(runtimeTab.tab);
  runtimeTab.tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    pendingUserInteractions: [],
    workingVisible: true,
  };
  appendExtensionDiagnostics(runtimeTab);
  subscribeRuntimeTab(runtimeTab, context);
  await bindRuntimeExtensions(runtimeTab, context);
  context.tabs.set(runtimeTab.tab.sessionId, runtimeTab);
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  return runtimeTab;
}

export async function syncRuntimeChatFromSession(runtimeTab: RuntimeTab): Promise<void> {
  disposeChatRenderers(runtimeTab.chat);
  runtimeTab.chat = await rebuildRuntimeChat(runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  runtimeTab.tab.status = runtimeTab.agentSession.isStreaming ? "running" : "idle";
}

export async function rebuildRuntimeChat(runtimeTab: RuntimeTab): Promise<ChatLine[]> {
  return entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
}

export async function createRuntimeServices(
  options: RuntimeServiceOptions,
): Promise<AgentSessionServices> {
  let servicesRef: AgentSessionServices | undefined;
  let latestExtensionManagerEntries: ExtensionManagerEntry[] = [];
  const resourceLoaderOptions = {
    ...(options.resourceLoaderOptions ?? {}),
    additionalExtensionPaths: [
      ...(options.resourceLoaderOptions?.additionalExtensionPaths ?? []),
      ...(options.additionalExtensionPaths ?? []),
    ],
    extensionFactories: [
      ...(options.resourceLoaderOptions?.extensionFactories ?? []),
      ...(options.extensionFactories ?? []),
    ],
    extensionsOverride: (result: LoadExtensionsResult) => {
      const overridden = options.resourceLoaderOptions?.extensionsOverride
        ? options.resourceLoaderOptions.extensionsOverride(result)
        : result;
      const disabledKeys = options.getDisabledExtensionKeys?.(options.workdir) ?? new Set<string>();
      latestExtensionManagerEntries = extensionManagerEntriesFromResult(overridden, disabledKeys);
      if (servicesRef) {
        extensionManagerEntriesByServices.set(servicesRef, latestExtensionManagerEntries);
      }
      return filterDisabledExtensions(overridden, disabledKeys);
    },
    systemPromptOverride: buildMixCodeSystemPromptOverride(
      options.resourceLoaderOptions?.systemPromptOverride,
      options.systemPrompt,
    ),
  };
  const services = await createAgentSessionServices({
    cwd: options.workdir,
    agentDir: options.agentDir,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry as ModelRegistry | undefined,
    settingsManager: options.settingsManager,
    resourceLoaderOptions,
  });
  if (services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new Error(services.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  servicesRef = services;
  extensionManagerEntriesByServices.set(services, latestExtensionManagerEntries);
  return services;
}

export function getExtensionManagerEntriesForServices(
  services: AgentSessionServices,
): ExtensionManagerEntry[] {
  return extensionManagerEntriesByServices.get(services) ?? [];
}

/** Cached search tool availability, detected once at module load. */
const cachedSearchTools: SearchToolAvailability = detectSearchTools();

function runtimeTabPromptOptions(services: AgentSessionServices, cwd: string) {
  const appendSystemPrompt = services.resourceLoader.getAppendSystemPrompt().join("\n\n");
  return {
    customPrompt: services.resourceLoader.getSystemPrompt() || undefined,
    appendSystemPrompt,
    contextFiles: services.resourceLoader.getAgentsFiles().agentsFiles,
    skills: services.resourceLoader.getSkills().skills,
    cwd,
    searchTools: cachedSearchTools,
  };
}

function startupResourceSummary(runtimeTab: RuntimeTab): string {
  const contextFiles = runtimeTab.services.resourceLoader
    .getAgentsFiles()
    .agentsFiles.map((file) => displayResourcePath(file.path));
  const skills = runtimeTab.services.resourceLoader.getSkills().skills.map((skill) => skill.name);
  const extensions = runtimeTab.extensionManagerEntries
    .filter((entry) => entry.enabled)
    .map((entry) => displayExtensionName(entry));
  return [
    ...resourceSummarySection("Context", contextFiles),
    ...resourceSummarySection("Skills", skills),
    ...resourceSummarySection("Extensions", extensions),
  ].join("\n");
}

function resourceSummarySection(title: string, items: string[]): string[] {
  return [`[${title}]`, items.length ? `  ${items.join(", ")}` : "  none", ""];
}

function displayExtensionName(entry: ExtensionManagerEntry): string {
  if (entry.source && entry.source !== "local" && entry.source !== "unknown") return entry.source;
  return displayResourcePath(entry.path);
}

function displayResourcePath(path: string): string {
  const home = process.env.HOME;
  return home && path.startsWith(`${home}/`) ? `~/${path.slice(home.length + 1)}` : path;
}

function applyMixCodeSystemPrompt(
  baseOptions: ReturnType<typeof runtimeTabPromptOptions>,
  agentSession: RuntimeTab["agentSession"],
): void {
  const options = buildMixCodeSystemPromptOptionsFromSession(agentSession, baseOptions);
  const prompt = buildMixCodeSystemPromptFromParts(options);
  const writableSession = agentSession as unknown as {
    _baseSystemPrompt?: string;
    _baseSystemPromptOptions?: typeof options;
  };
  writableSession._baseSystemPrompt = prompt;
  writableSession._baseSystemPromptOptions = options;
  agentSession.agent.state.systemPrompt = prompt;
}

export async function bindRuntimeExtensions(
  runtimeTab: RuntimeTab,
  context: RuntimeLifecycleContext,
): Promise<void> {
  await runtimeTab.agentSession.bindExtensions({
    uiContext: createMixCodeExtensionUiContext(
      runtimeTab,
      () => {
        context.emitChange({ type: "extension_ui_update" }, runtimeTab);
      },
      context.getExtensionUiHost,
    ),
    commandContextActions: createExtensionCommandActions(context.runtime, runtimeTab),
    shutdownHandler: () => {
      runtimeTab.chat.push({ role: "system", text: "Extension requested shutdown." });
    },
    onError: (error) => {
      runtimeTab.chat.push({
        role: "system",
        text: `Extension ${error.extensionPath} ${error.event}: ${error.error}`,
      });
    },
  });
  applyMixCodeSystemPrompt(
    runtimeTabPromptOptions(runtimeTab.services, runtimeTab.tab.workdir),
    runtimeTab.agentSession,
  );
}

function appendExtensionDiagnostics(runtimeTab: RuntimeTab): void {
  appendExtensionLoadErrors(runtimeTab);
  appendExtensionConflictDiagnostics(runtimeTab);
}

function subscribeRuntimeTab(runtimeTab: RuntimeTab, context: RuntimeLifecycleContext): void {
  runtimeTab.agentSession.subscribe((event: AgentSessionEvent) => {
    context.applyEvent(runtimeTab, event);
    if (event.type === "agent_end") {
      if (consumeDeferredPendingMessageFlush(runtimeTab)) return;
      context.schedulePendingMessageFlush(runtimeTab.tab.sessionId, runtimeTab.agentSession);
    }
  });
}

/**
 * Install a mid-turn compaction check on the agent's afterToolCall hook.
 *
 * The Pi SDK only checks compaction at turn boundaries (agent_end) and before
 * the next user prompt. During long tool loops, context can grow unbounded.
 * This hook checks after each tool call whether context exceeds the compaction
 * threshold. If so, it returns { terminate: true } which causes the agent loop
 * to exit cleanly (agent_end), and the runtime schedules an auto-compact cycle.
 *
 * The hook chains with the existing afterToolCall set by AgentSession (for
 * extension tool_result events) by capturing and delegating to it.
 */
export function installMidTurnCompactionHook(
  agentSession: RuntimeTab["agentSession"],
  tab?: MixCodeTabInfo,
  runtimeTabRef?: { current?: RuntimeTab },
): void {
  const existingHook = agentSession.agent.afterToolCall;

  agentSession.agent.afterToolCall = async (context, signal) => {
    // Run the existing hook first (extension tool_result interception)
    const existingResult = await existingHook?.(context, signal);

    // Check if context exceeds compaction threshold
    const settings = agentSession.settingsManager.getCompactionSettings();
    if (settings.enabled && context.assistantMessage.usage) {
      const contextTokens = calculateContextTokens(context.assistantMessage.usage);
      // Use the tab's contextLimit which respects user override via /context-limit.
      // Falls back to model's contextWindow (which is also mutated by the override).
      const contextWindow = tab?.contextLimit ?? agentSession.agent.state.model?.contextWindow ?? 0;
      if (contextWindow > 0 && shouldCompact(contextTokens, contextWindow, settings)) {
        // Always attempt auto-compact-and-continue for context limit overrides.
        // The autoCompactAndContinue function will detect if compact was ineffective
        // and stop the loop with a user-facing message.
        if (runtimeTabRef?.current && tab?.contextLimitOverridden) {
          runtimeTabRef.current.pendingContextLimitCompaction = true;
        }
        // Merge terminate into existing result (preserve content/details overrides)
        return { ...existingResult, terminate: true };
      }
    }

    return existingResult;
  };
}
