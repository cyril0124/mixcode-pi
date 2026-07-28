import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type CreateAgentSessionServicesOptions,
  calculateContextTokens,
  createAgentSessionFromServices,
  createAgentSessionServices,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ModelRuntime,
  type SessionManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
  SettingsManager,
  shouldCompact,
} from "@earendil-works/pi-coding-agent";
import { captureCompactionBaseline } from "../core/context-limit.js";
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
import {
  isExtensionToolOwner,
  type ExtensionToolOwnerPolicy,
} from "../core/extension-tool-owners.js";
import type { AgentRuntimeConfig, MixCodeModel, MixCodeTabInfo } from "../core/types.js";
import type { MixCodeRuntime } from "./runtime.js";
import {
  appendSystemMessage,
  applyRuntimeTabModel,
  disposeChatRenderers,
  entriesToChatLines,
  resetTabForNewSession,
  syncContextUsage,
  syncPreviewFromChat,
} from "./runtime-chat.js";
import {
  createExtensionCommandActions,
  createMixCodeExtensionUiContext,
  disposeExtensionWidgets,
} from "./runtime-extension-ui.js";
import { consumeDeferredPendingMessageFlush } from "./runtime-follow-up.js";
import {
  buildMixCodeSystemPromptOverride,
  registerMixCodeRuntimeProvider,
} from "./runtime-provider.js";
import {
  configureMixCodeRetryClassification,
  configureMixCodeRetrySettings,
} from "./retry-settings.js";
import { refreshStartupHeader } from "./runtime-startup-header.js";
export { refreshStartupHeader } from "./runtime-startup-header.js";
import {
  bindRuntimeSessionCore,
  getExtensionManagerEntriesForServices,
  resetExtensionHostState,
  setExtensionManagerEntriesForServices,
} from "./runtime-session.js";
import type {
  ChatLine,
  ExtensionCustomUiHost,
  MixCodeStreamFn,
  RuntimeEvent,
  RuntimeTab,
  SessionReplacementReason,
} from "./runtime-types.js";
import { activateMixCodeTools, ToolLog } from "./tools.js";

export type RuntimeTabConfig = Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
  model?: MixCodeModel;
  reuseServicesFromSessionId?: string;
  reuseServices?: AgentSessionServices;
  /** Keep an explicit caller title instead of restoring the opened session name. */
  preserveCallerTitle?: boolean;
  /** Skip resourceLoader.reload() — caller already reloaded extensions. */
  skipExtensionReload?: boolean;
};

export interface RuntimeServiceOptions {
  workdir: string;
  systemPrompt?: string;
  agentDir: string;
  modelRuntime?: ModelRuntime;
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
  resolveModel: (provider: string, modelId: string) => MixCodeModel;
  resolveModelFromSession: (
    session: SessionManager,
    fallback: MixCodeTabInfo["model"] | MixCodeModel | undefined,
  ) => MixCodeModel;
  streamFn?: MixCodeStreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  getDisabledExtensionKeys?: (workdir: string) => ReadonlySet<string>;
  extensionToolOwnerPolicy?: ExtensionToolOwnerPolicy;
}

export function applyMixCodeSessionDefaults(settingsManager: SettingsManager): void {
  settingsManager.applyOverrides({ steeringMode: "all" }); // Settings reloads discard overrides.
  configureMixCodeRetrySettings(settingsManager);
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
  const reusedServices =
    config.reuseServices ??
    (config.reuseServicesFromSessionId
      ? context.tabs.get(config.reuseServicesFromSessionId)?.services
      : undefined);
  // Reload extensions on reused services so this tab gets a fresh
  // extensionsResult (fresh runtime + fresh pi closures). Without this,
  // multiple tabs sharing the same resourceLoader would share a mutable
  // runtime object — invalidating one (dispose) would break the others.
  // Note: reused services also share the same SettingsManager, so a
  // /context-limit override on one same-source (fork/reuse) tab affects the
  // others' compaction budgets. Independent tabs each get their own manager
  // (see createRuntimeServices), so cross-tab isolation holds for them.
  if (reusedServices && !config.skipExtensionReload) {
    await reusedServices.resourceLoader.reload();
  }
  return createRuntimeTabWithServices(
    tab,
    session,
    config,
    context,
    model,
    reusedServices ?? (await context.createServices(config.workdir, config.systemPrompt)),
    toolLog,
  );
}

async function createRuntimeTabWithServices(
  tab: MixCodeTabInfo,
  session: SessionManager,
  config: RuntimeTabConfig,
  context: RuntimeLifecycleContext,
  model: MixCodeModel,
  services: AgentSessionServices,
  toolLog: ToolLog,
): Promise<RuntimeTab> {
  registerMixCodeRuntimeProvider(
    services.modelRuntime,
    model,
    context.streamFn,
    context.getApiKey,
  );
  applyMixCodeSessionDefaults(services.settingsManager);
  const { session: agentSession, extensionsResult } = await createAgentSessionFromServices({
    services,
    sessionManager: session,
    model: { ...model },
    thinkingLevel: config.thinkingLevel,
  });
  const extensionToolOwnerPolicy = resolveExtensionToolOwnerPolicy(context);
  // Mid-turn compaction check: after each tool call, if context exceeds the threshold,
  // signal terminate=true so the agent loop exits cleanly (agent_end). The runtime
  // then waits for idle, compacts, and continues from the compacted transcript.
  const runtimeTabRef: { current?: RuntimeTab } = {};
  const runtimeTab: RuntimeTab = {
    tab,
    agentSession,
    services,
    extensionsResult,
    agent: agentSession.agent,
    session,
    chat: [],
    toolLog,
    queuedPromptCount: 0,
    queuedFollowUpCount: 0,
    extensionTerminalInputHandlers: new Set(),
    extensionDialogResolvers: new Map(),
    extensionCustomOverlayClosers: new Set(),
    extensionCustomOverlayHandles: new Set(),
    extensionAutocompleteProviderFactories: [],
    extensionManagerEntries: getExtensionManagerEntriesForServices(services),
    extensionToolOwnerPolicy,
  };
  tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    pendingUserInteractions: [],
    workingVisible: true,
  };
  // Pi may restore a different model and clamps thinking during session creation.
  applyRuntimeTabModel(runtimeTab, agentSession.agent.state.model);
  tab.thinkingLevel = agentSession.thinkingLevel;
  runtimeTab.requestRender = () => context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  runtimeTabRef.current = runtimeTab;
  try {
    activateMixCodeTools(agentSession, extensionToolOwnerPolicy);
    applyMixCodeSystemPrompt(services, config.workdir, agentSession);
    installMidTurnCompactionHook(agentSession, tab, runtimeTabRef);
    const restoredChat = await rebuildRuntimeChat(runtimeTab);
    if (tab.previewMessages.length === 0) {
      syncPreviewFromChat(tab, restoredChat);
    }
    runtimeTab.chat = restoredChat;
    await bindRuntimeExtensions(runtimeTab, context);
    activateMixCodeTools(agentSession, extensionToolOwnerPolicy);
    applyMixCodeSystemPrompt(services, config.workdir, agentSession);
    refreshStartupHeader(runtimeTab);
    syncContextUsage(runtimeTab);
    // Opening an existing on-disk session (bootstrap / peer / openExisting) must
    // show its persisted name. Fork supplies a distinct caller-owned title.
    const openedName = session.getSessionName();
    if (openedName && !config.preserveCallerTitle) tab.title = openedName;
    context.tabs.set(tab.sessionId, runtimeTab);
    return runtimeTab;
  } catch (error) {
    await disposePartialRuntimeTab(runtimeTab, error, context);
    throw error;
  }
}

async function disposePartialRuntimeTab(
  runtimeTab: RuntimeTab,
  originalError: unknown,
  context: RuntimeLifecycleContext,
): Promise<void> {
  // Fast-path fallback must not leave a half-initialized AgentSession alive.
  try {
    await shutdownRuntimeTab(
      runtimeTab,
      { type: "session_shutdown", reason: "new" },
      context.getExtensionUiHost(),
    );
  } catch (cleanupError) {
    throw new AggregateError(
      [originalError, cleanupError],
      `Session startup failed and cleanup failed: ${formatErrorMessage(originalError)}; cleanup: ${formatErrorMessage(cleanupError)}`,
    );
  }
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function createRuntimeTabWithFallback(
  tab: MixCodeTabInfo,
  session: SessionManager,
  config: RuntimeTabConfig,
  context: RuntimeLifecycleContext,
): Promise<RuntimeTab> {
  try {
    return await createRuntimeTab(tab, session, config, context);
  } catch (error) {
    if (!config.reuseServicesFromSessionId && !config.reuseServices) throw error;
    const rebuilt = await createRuntimeTab(
      tab,
      session,
      { ...config, reuseServicesFromSessionId: undefined, reuseServices: undefined },
      context,
    );
    appendSystemMessage(
      rebuilt,
      `Fast session reuse failed; rebuilt services: ${error instanceof Error ? error.message : String(error)}`,
    );
    return rebuilt;
  }
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
  const services =
    config.reuseServices ??
    (config.reuseServicesFromSessionId
      ? context.tabs.get(config.reuseServicesFromSessionId)?.services
      : undefined);
  // Same invariant as createRuntimeTab: a disposed AgentSession invalidates the
  // shared extensionsResult.runtime. Reusing services without reload would make
  // the next session_start see stale ctx (pi-subagents scheduler warn).
  if (services && !config.skipExtensionReload) {
    await services.resourceLoader.reload();
  }
  return createAgentSessionForReplacementWithServices(
    sessionManager,
    config,
    context,
    model,
    services ?? (await context.createServices(config.workdir, config.systemPrompt)),
    toolLog,
  );
}

async function createAgentSessionForReplacementWithServices(
  sessionManager: SessionManager,
  config: RuntimeTabConfig & { sessionStartEvent: SessionStartEvent },
  context: RuntimeLifecycleContext,
  model: MixCodeModel,
  services: AgentSessionServices,
  toolLog: ToolLog,
): Promise<CreateAgentSessionResult & { services: AgentSessionServices; toolLog: ToolLog }> {
  registerMixCodeRuntimeProvider(
    services.modelRuntime,
    model,
    context.streamFn,
    context.getApiKey,
  );
  applyMixCodeSessionDefaults(services.settingsManager);
  const result = await createAgentSessionFromServices({
    services,
    sessionManager,
    model: { ...model },
    thinkingLevel: config.thinkingLevel,
    sessionStartEvent: config.sessionStartEvent,
  });
  const extensionToolOwnerPolicy = resolveExtensionToolOwnerPolicy(context);
  activateMixCodeTools(result.session, extensionToolOwnerPolicy);
  applyMixCodeSystemPrompt(services, config.workdir, result.session);
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

// Test-only: delay after installing the replacement session and before bindExtensions.
export const __testReplaceHooks = { bindDelayMs: 0 };

/** Map key for a RuntimeTab — identity first, then tab.sessionId fallback. */
function mapKeyForRuntimeTab(
  tabs: Map<string, RuntimeTab>,
  runtimeTab: RuntimeTab,
): string {
  for (const [key, value] of tabs) {
    if (value === runtimeTab) return key;
  }
  return runtimeTab.tab.sessionId;
}

export async function replaceRuntimeTabSession(
  runtimeTab: RuntimeTab,
  sessionManager: SessionManager,
  reason: SessionReplacementReason,
  context: RuntimeLifecycleContext,
): Promise<RuntimeTab> {
  // Serialize per tab: concurrent resume/new/fork must not dispose a session that
  // another replace has installed but not yet bound (stale ctx in session_start).
  const previousLock = runtimeTab.replaceLock ?? Promise.resolve();
  let releaseLock!: () => void;
  runtimeTab.replaceLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });
  await previousLock.catch(() => undefined);
  try {
    return await replaceRuntimeTabSessionUnlocked(
      runtimeTab,
      sessionManager,
      reason,
      context,
    );
  } finally {
    releaseLock();
  }
}

async function replaceRuntimeTabSessionUnlocked(
  runtimeTab: RuntimeTab,
  sessionManager: SessionManager,
  reason: SessionReplacementReason,
  context: RuntimeLifecycleContext,
): Promise<RuntimeTab> {
  if (runtimeTab.agentSession.isStreaming) {
    throw new Error(`Cannot replace a session while the agent is streaming: ${reason}`);
  }
  // Prefer the tabs-map key (by object identity). Resume may pre-rename
  // tab.sessionId for open_tabs/peer reconcile before switch commits, so the
  // map key can still be the ephemeral id while tab.sessionId is already the
  // durable one — using tab.sessionId here would delete the wrong map entry.
  const previousSessionId = mapKeyForRuntimeTab(context.tabs, runtimeTab);
  const previousSessionFile = runtimeTab.session.getSessionFile();
  const targetSessionFile = sessionManager.getSessionFile() ?? undefined;
  const model = context.resolveModelFromSession(sessionManager, runtimeTab.tab.model);
  // Capture services before shutdown: dispose invalidates the current runner, but
  // the ResourceLoader can be reloaded for a fresh extensionsResult.runtime.
  const previousServices = runtimeTab.services;
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
      // Reload-on-reuse keeps a fresh extension runtime after dispose (see above).
      reuseServices: previousServices,
      sessionStartEvent: { type: "session_start", reason, previousSessionFile },
    },
    context,
  );
  bindRuntimeSessionCore(runtimeTab, {
    agentSession: created.session,
    services: created.services,
    extensionsResult: created.extensionsResult,
    extensionToolOwnerPolicy: resolveExtensionToolOwnerPolicy(context),
  });
  runtimeTab.session = sessionManager;
  runtimeTab.toolLog = created.toolLog;
  runtimeTab.queuedPromptCount = 0;
  runtimeTab.queuedFollowUpCount = 0;
  runtimeTab.streamingAssistant = undefined;
  disposeExtensionWidgets(runtimeTab.tab);
  runtimeTab.tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    pendingUserInteractions: [],
    workingVisible: true,
  };
  installMidTurnCompactionHook(created.session, runtimeTab.tab, { current: runtimeTab });
  // Rebuild chat and bind extensions BEFORE mutating tab identity.
  // If either throws, the caller's state is still intact — no orphaned tab.
  runtimeTab.chat = await rebuildRuntimeChat(runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  if (__testReplaceHooks.bindDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, __testReplaceHooks.bindDelayMs));
  }
  // Resume title before bind so the tab bar never flashes Agent-NN if bind is slow
  // or a session_start handler races a UI render. new/fork keep the caller title.
  if (reason === "resume") {
    const resumedName = sessionManager.getSessionName();
    if (resumedName) runtimeTab.tab.title = resumedName;
  }
  await bindRuntimeExtensions(runtimeTab, context);
  const sessionStartStatus = runtimeTab.tab.status;
  const sessionStartWorkingStartedAt = runtimeTab.tab.workingStartedAt;
  // Only now commit the identity switch: update the tab's sessionId,
  // remove the old key from the tabs map, and register under the new key.
  resetTabForNewSession(runtimeTab.tab, sessionManager.getSessionId());
  if (created.session.isStreaming) {
    runtimeTab.tab.status = sessionStartStatus === "thinking" ? "thinking" : "running";
    runtimeTab.tab.workingStartedAt = sessionStartWorkingStartedAt ?? new Date().toISOString();
  }
  runtimeTab.tab.workdir = sessionManager.getCwd();
  // Re-apply after identity switch: resetTabForNewSession does not clear title, but
  // bind/session_start may have renamed; prefer the session file's persisted name.
  if (reason === "resume") {
    const resumedName = sessionManager.getSessionName();
    if (resumedName) runtimeTab.tab.title = resumedName;
  }
  context.tabs.delete(previousSessionId);
  context.tabs.set(runtimeTab.tab.sessionId, runtimeTab);
  // Repopulate preview after identity-switch reset cleared previewMessages
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  activateMixCodeTools(created.session, runtimeTab.extensionToolOwnerPolicy);
  applyMixCodeSystemPrompt(created.services, runtimeTab.tab.workdir, created.session);
  applyRuntimeTabModel(runtimeTab, created.session.agent.state.model);
  runtimeTab.tab.thinkingLevel = created.session.agent.state.thinkingLevel;
  refreshStartupHeader(runtimeTab);
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
        setExtensionManagerEntriesForServices(servicesRef, latestExtensionManagerEntries);
      }
      return filterDisabledExtensions(overridden, disabledKeys);
    },
    systemPromptOverride: buildMixCodeSystemPromptOverride(
      options.resourceLoaderOptions?.systemPromptOverride,
      options.systemPrompt,
    ),
  };
  // Give every tab its own SettingsManager (Pi's native per-cwd design) instead
  // of sharing the bootstrap manager. /context-limit mutates compaction budgets
  // via applyOverrides; a shared manager would leak one tab's override into all
  // other tabs' compaction decisions (both the SDK turn-boundary check and the
  // mid-turn hook read from this manager). The bootstrap manager is retained by
  // the runtime only for startup proxy/defaults and global settings writes.
  const settingsManager = SettingsManager.create(options.workdir, options.agentDir, {
    projectTrusted: options.settingsManager?.isProjectTrusted() ?? true,
  });
  const services = await createAgentSessionServices({
    cwd: options.workdir,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    settingsManager,
    resourceLoaderOptions,
  });
  if (services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new Error(services.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  applyMixCodeSessionDefaults(services.settingsManager);
  // Record the user's compaction baseline before any /context-limit override so
  // a later reset restores these values, not hardcoded SDK defaults.
  captureCompactionBaseline(services.settingsManager);
  configureMixCodeRetryClassification();
  servicesRef = services;
  setExtensionManagerEntriesForServices(services, latestExtensionManagerEntries);
  return services;
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

/**
 * Route Pi's own system-prompt rebuilds through MixCode's builder.
 *
 * Pi rebuilds the base system prompt via AgentSession._rebuildSystemPrompt on
 * construction, on setActiveToolsByName (which extensions can trigger at runtime
 * through pi.setActiveTools), and on reload. Without this override those rebuilds
 * replace MixCode's prompt (history recall, search guidelines, MixCode project-
 * context format) with Pi's default builder output. Overriding the method keeps
 * MixCode's builder authoritative across every rebuild path, and passing the
 * rebuild's own toolNames captures each tool's promptSnippet and promptGuidelines.
 */
function installMixCodeSystemPromptBuilder(
  agentSession: RuntimeTab["agentSession"],
  services: AgentSessionServices,
  cwd: string,
): void {
  const writableSession = agentSession as unknown as {
    _rebuildSystemPrompt?: (toolNames: string[]) => string;
    _baseSystemPromptOptions?: ReturnType<typeof buildMixCodeSystemPromptOptionsFromSession>;
  };
  if (typeof writableSession._rebuildSystemPrompt !== "function") {
    throw new Error(
      "Pi AgentSession._rebuildSystemPrompt internals changed; MixCode cannot own system prompt assembly.",
    );
  }
  writableSession._rebuildSystemPrompt = (toolNames: string[]) => {
    const options = buildMixCodeSystemPromptOptionsFromSession(
      {
        getActiveToolNames: () => toolNames,
        getToolDefinition: (name) => agentSession.getToolDefinition(name),
      },
      runtimeTabPromptOptions(services, cwd),
    );
    // Pi reads _baseSystemPromptOptions in before_agent_start; keep it in sync.
    writableSession._baseSystemPromptOptions = options;
    return buildMixCodeSystemPromptFromParts(options);
  };
}

function applyMixCodeSystemPrompt(
  services: AgentSessionServices,
  cwd: string,
  agentSession: RuntimeTab["agentSession"],
): void {
  installMixCodeSystemPromptBuilder(agentSession, services, cwd);
  const writableSession = agentSession as unknown as {
    _rebuildSystemPrompt: (toolNames: string[]) => string;
    _baseSystemPrompt?: string;
    _systemPromptOverride?: string;
  };
  const prompt = writableSession._rebuildSystemPrompt(agentSession.getActiveToolNames());
  writableSession._baseSystemPrompt = prompt;
  // Respect an active extension system-prompt override, matching Pi semantics.
  agentSession.agent.state.systemPrompt = writableSession._systemPromptOverride ?? prompt;
}

export async function bindRuntimeExtensions(
  runtimeTab: RuntimeTab,
  context: RuntimeLifecycleContext,
): Promise<void> {
  // bindExtensions emits session_start, which may synchronously start a turn.
  subscribeRuntimeTab(runtimeTab, context);
  await runtimeTab.agentSession.bindExtensions({
    mode: "tui",
    uiContext: createMixCodeExtensionUiContext(
      runtimeTab,
      () => {
        context.emitChange({ type: "extension_ui_update" }, runtimeTab);
      },
      context.getExtensionUiHost,
    ),
    commandContextActions: createExtensionCommandActions(context.runtime, runtimeTab),
    // Multi-tab: close this session only (not process exit). Defers while streaming.
    shutdownHandler: () => {
      context.runtime.requestExtensionShutdown(runtimeTab.tab.sessionId);
    },
    onError: (error) => {
      appendSystemMessage(
        runtimeTab,
        `Extension ${error.extensionPath} ${error.event}: ${error.error}`,
        "error",
      );
    },
  });
  applyMixCodeSystemPrompt(
    runtimeTab.services,
    runtimeTab.tab.workdir,
    runtimeTab.agentSession,
  );
}

function resolveExtensionToolOwnerPolicy(context: RuntimeLifecycleContext): ExtensionToolOwnerPolicy {
  return context.extensionToolOwnerPolicy ?? isExtensionToolOwner;
}

export async function reloadRuntimeTabWithFreshServices(
  runtimeTab: RuntimeTab,
  context: RuntimeLifecycleContext,
): Promise<void> {
  const services = await context.createServices(runtimeTab.tab.workdir, MIXCODE_SYSTEM_PROMPT);
  const model = runtimeTab.agent.state.model;
  registerMixCodeRuntimeProvider(services.modelRuntime, model, context.streamFn, context.getApiKey);
  await shutdownRuntimeTab(
    runtimeTab,
    { type: "session_shutdown", reason: "reload" },
    context.getExtensionUiHost(),
  );
  const { session: agentSession, extensionsResult } = await createAgentSessionFromServices({
    services,
    sessionManager: runtimeTab.session,
    model,
    thinkingLevel: runtimeTab.tab.thinkingLevel,
    sessionStartEvent: { type: "session_start", reason: "reload" },
  });
  bindRuntimeSessionCore(runtimeTab, {
    agentSession,
    services,
    extensionsResult,
    extensionToolOwnerPolicy: resolveExtensionToolOwnerPolicy(context),
  });
  activateMixCodeTools(agentSession, runtimeTab.extensionToolOwnerPolicy);
  installMidTurnCompactionHook(agentSession, runtimeTab.tab, { current: runtimeTab });
  runtimeTab.chat = await rebuildRuntimeChat(runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  await bindRuntimeExtensions(runtimeTab, context);
  activateMixCodeTools(agentSession, runtimeTab.extensionToolOwnerPolicy);
  applyMixCodeSystemPrompt(services, runtimeTab.tab.workdir, agentSession);
  // Pi refreshes the same loadedResourcesContainer on session_start and /reload;
  // the tab-level header is the MixCode analogue, so recompute it here too.
  refreshStartupHeader(runtimeTab);
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
}

export function subscribeRuntimeTab(runtimeTab: RuntimeTab, context: RuntimeLifecycleContext): void {
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
        // This hook terminates an active tool loop mid-turn, so runtime must own
        // the follow-up compact + continue cycle instead of leaving the task idle.
        if (runtimeTabRef?.current) {
          runtimeTabRef.current.pendingContextLimitCompaction = true;
        }
        // Merge terminate into existing result (preserve content/details overrides)
        return { ...existingResult, terminate: true };
      }
    }

    return existingResult;
  };
}
