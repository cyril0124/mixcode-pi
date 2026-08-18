import * as path from "node:path";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import {
  type AgentSessionServices,
  type CreateAgentSessionResult,
  type CreateAgentSessionServicesOptions,
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEventBus,
  type ExtensionFactory,
  type LoadExtensionsResult,
  type ModelRuntime,
  type ResourceDiagnostic,
  type SessionManager,
  type SessionShutdownEvent,
  type SessionStartEvent,
  SettingsManager,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import { isProjectSkillsOnlyEnabled } from "../core/attachments.js";
import { captureCompactionBaseline } from "../core/context-limit.js";
import {
  registerExtensionEventBus,
  unregisterExtensionEventBus,
} from "../core/extension-event-bus.js";
import { detectSearchTools, type SearchToolAvailability } from "../core/system-prompt.js";
import {
  type ExtensionManagerEntry,
  extensionManagerEntriesFromResult,
  filterDisabledExtensions,
} from "../core/extension-manager.js";
import { preferDistExtensionEntries } from "../core/prefer-dist-extension-entries.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import type { AgentRuntimeConfig, MixCodeModel, MixCodeTabInfo } from "../core/types.js";
import { applyMixCodeSystemPrompt } from "./pi-session-internals.js";
import { configureMixCodeRetrySettings } from "./retry-settings.js";
import {
  appendSystemMessage,
  applyRuntimeTabModel,
  disposeChatRenderers,
  entriesToChatLines,
  resetTabForNewSession,
  syncContextUsage,
  syncPreviewFromChat,
} from "./runtime-chat.js";
import type { ExtensionCommandRuntime } from "./runtime-extension-actions.js";
import {
  createExtensionCommandActions,
  createMixCodeExtensionUiContext,
  disposeExtensionWidgets,
} from "./runtime-extension-ui.js";

import {
  buildMixCodeSystemPromptOverride,
  registerMixCodeRuntimeProvider,
  runtimeRetryNormalizationExtension,
} from "./runtime-provider.js";
import { refreshStartupHeader } from "./runtime-startup-header.js";

import {
  bindRuntimeSessionCore,
  reopenSessionInWorkdir,
  resetExtensionHostState,
  setExtensionManagerEntriesForServices,
} from "./runtime-session.js";
import type {
  ExtensionCustomUiHost,
  MixCodeStreamFn,
  RuntimeEvent,
  RuntimeTab,
  SessionReplacementReason,
} from "./runtime-types.js";
import { createMixCodeBashCustomTools } from "./mixcode-bash-env.js";
import { activateMixCodeTools } from "./tools.js";

export type RuntimeTabConfig = Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
  model?: MixCodeModel;
  reuseServicesFromSessionId?: string;
  reuseServices?: AgentSessionServices;
  /** Keep an explicit caller title instead of restoring the opened session name. */
  preserveCallerTitle?: boolean;
  /** Skip resourceLoader.reload() — caller already reloaded extensions. */
  skipExtensionReload?: boolean;
  /** Live tab title for bash MIXCODE_TAB_TITLE (replacement path). */
  getTabTitle?: () => string;
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
  /** Narrow command surface for Pi extension commandContextActions (not full host). */
  extensionCommandRuntime: ExtensionCommandRuntime;
  requestExtensionShutdown: (sessionId: string) => void;
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
  /** UI-focused agent tab title for bash env; empty when Home is focused. */
  getFocusedTabTitle?: () => string | undefined;
}

function mixcodeBashCustomTools(
  services: AgentSessionServices,
  getTabTitle: () => string,
  context: RuntimeLifecycleContext,
) {
  return createMixCodeBashCustomTools(services.cwd, services.settingsManager, () => ({
    tabTitle: getTabTitle(),
    focusedTabTitle: context.getFocusedTabTitle?.(),
  }));
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
  );
}

async function createRuntimeTabWithServices(
  tab: MixCodeTabInfo,
  session: SessionManager,
  config: RuntimeTabConfig,
  context: RuntimeLifecycleContext,
  model: MixCodeModel,
  services: AgentSessionServices,
): Promise<RuntimeTab> {
  await registerMixCodeRuntimeProvider(
    services.modelRuntime,
    model,
    context.streamFn,
    context.getApiKey,
  );
  applyMixCodeSessionDefaults(services.settingsManager);
  const { session: agentSession } = await createAgentSessionFromServices({
    services,
    sessionManager: session,
    model: { ...model },
    thinkingLevel: config.thinkingLevel,
    customTools: mixcodeBashCustomTools(services, () => tab.title, context),
  });
  const runtimeTab: RuntimeTab = {
    tab,
    agentSession,
    services,
    session,
    chat: [],
    queuedPromptCount: 0,
    queuedFollowUpCount: 0,
    extensionTerminalInputHandlers: new Set(),
    extensionCustomOverlayClosers: new Set(),
    extensionCustomOverlayHandles: new Set(),
    extensionCustomOverlayComponents: new Set(),
    extensionAutocompleteProviderFactories: [],
  };
  tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    waitingForInputs: [],
    workingVisible: true,
  };
  // Pi may restore a different model and clamps thinking during session creation.
  applyRuntimeTabModel(runtimeTab, agentSession.agent.state.model);
  tab.thinkingLevel = agentSession.thinkingLevel;
  runtimeTab.requestRender = () => context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  try {
    activateMixCodeTools(agentSession);
    applyMixCodeSystemPrompt(agentSession, cachedSearchTools);
    const restoredChat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
    if (tab.previewMessages.length === 0) {
      syncPreviewFromChat(tab, restoredChat);
    }
    runtimeTab.chat = restoredChat;
    await bindRuntimeExtensions(runtimeTab, context);
    activateMixCodeTools(agentSession);
    applyMixCodeSystemPrompt(agentSession, cachedSearchTools);
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
): Promise<CreateAgentSessionResult & { services: AgentSessionServices }> {
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
  );
}

async function createAgentSessionForReplacementWithServices(
  sessionManager: SessionManager,
  config: RuntimeTabConfig & { sessionStartEvent: SessionStartEvent },
  context: RuntimeLifecycleContext,
  model: MixCodeModel,
  services: AgentSessionServices,
): Promise<CreateAgentSessionResult & { services: AgentSessionServices }> {
  await registerMixCodeRuntimeProvider(
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
    customTools: mixcodeBashCustomTools(
      services,
      config.getTabTitle ?? (() => ""),
      context,
    ),
  });
  activateMixCodeTools(result.session);
  applyMixCodeSystemPrompt(result.session, cachedSearchTools);
  return { ...result, services };
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
  unregisterExtensionEventBus(runtimeTab.services);
}

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
  const { promise: replaceLock, resolve: releaseLock } = Promise.withResolvers<void>();
  runtimeTab.replaceLock = replaceLock;
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
      getTabTitle: () => runtimeTab.tab.title,
    },
    context,
  );
  bindRuntimeSessionCore(runtimeTab, {
    agentSession: created.session,
    services: created.services,
  });
  runtimeTab.session = sessionManager;
  runtimeTab.queuedPromptCount = 0;
  runtimeTab.queuedFollowUpCount = 0;
  runtimeTab.streamingAssistant = undefined;
  disposeExtensionWidgets(runtimeTab.tab);
  runtimeTab.tab.extensionUi = {
    statuses: [],
    widgets: [],
    toolsExpanded: false,
    waitingForInputs: [],
    workingVisible: true,
  };
  // Rebuild chat and bind extensions BEFORE mutating tab identity.
  // If either throws, the caller's state is still intact — no orphaned tab.
  runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
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
  activateMixCodeTools(created.session);
  applyMixCodeSystemPrompt(created.session, cachedSearchTools);
  applyRuntimeTabModel(runtimeTab, created.session.agent.state.model);
  runtimeTab.tab.thinkingLevel = created.session.agent.state.thinkingLevel;
  refreshStartupHeader(runtimeTab);
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
  return runtimeTab;
}

export async function syncRuntimeChatFromSession(runtimeTab: RuntimeTab): Promise<void> {
  disposeChatRenderers(runtimeTab.chat);
  runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  runtimeTab.tab.status = runtimeTab.agentSession.isStreaming ? "running" : "idle";
}

export async function createRuntimeServices(
  options: RuntimeServiceOptions,
): Promise<AgentSessionServices> {
  // Compile-binary mpi loads extensions via jiti virtualModules; prefer dist
  // entries before packageManager.resolve so src+TypeBox packages don't fail.
  preferDistExtensionEntries(options.agentDir);

  let servicesRef: AgentSessionServices | undefined;
  let latestExtensionManagerEntries: ExtensionManagerEntry[] = [];
  const resourceLoaderOptions = {
    ...(options.resourceLoaderOptions ?? {}),
    additionalExtensionPaths: [
      ...(options.resourceLoaderOptions?.additionalExtensionPaths ?? []),
      ...(options.additionalExtensionPaths ?? []),
    ],
    extensionFactories: [
      runtimeRetryNormalizationExtension,
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
    skillsOverride: (result: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
      const overridden = options.resourceLoaderOptions?.skillsOverride
        ? options.resourceLoaderOptions.skillsOverride(result)
        : result;
      if (!isProjectSkillsOnlyEnabled()) return overridden;
      const normalizedWorkdir = path.resolve(options.workdir);
      return {
        ...overridden,
        skills: overridden.skills.filter((skill) => {
          if (skill.sourceInfo?.scope === "user") return false;
          const skillPath = path.resolve(skill.filePath);
          return skillPath === normalizedWorkdir || skillPath.startsWith(`${normalizedWorkdir}${path.sep}`);
        }),
      };
    },
  };
  // Give every tab its own SettingsManager (Pi's native per-cwd design) instead
  // of sharing the bootstrap manager. /context-limit mutates compaction budgets
  // via applyOverrides; a shared manager would leak one tab's override into all
  // other tabs' SDK turn-boundary compaction decisions. The bootstrap manager is
  // retained by the runtime only for startup proxy/defaults and global settings writes.
  const settingsManager = SettingsManager.create(options.workdir, options.agentDir, {
    projectTrusted: options.settingsManager?.isProjectTrusted() ?? true,
  });
  // Per-services EventBus so host can fan-out WaitingForInput on pi.events without
  // private loader access. Registered for multi-tab broadcast in the signal module.
  const eventBus = createEventBus();
  const services = await createAgentSessionServices({
    cwd: options.workdir,
    agentDir: options.agentDir,
    modelRuntime: options.modelRuntime,
    settingsManager,
    resourceLoaderOptions: {
      ...resourceLoaderOptions,
      eventBus,
    },
  });
  registerExtensionEventBus(services, eventBus);
  if (services.diagnostics.some((diagnostic) => diagnostic.type === "error")) {
    throw new Error(services.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  applyMixCodeSessionDefaults(services.settingsManager);
  // Record the user's compaction baseline before any /context-limit override so
  // a later reset restores these values, not hardcoded SDK defaults.
  captureCompactionBaseline(services.settingsManager);
  // Merge ResourceLoader-discovered themes (packages, ~/.pi/agent/themes, …).
  const { registerMixCodeThemes } = await import("./runtime-extension-theme.js");
  registerMixCodeThemes(services.resourceLoader.getThemes().themes);
  servicesRef = services;
  setExtensionManagerEntriesForServices(services, latestExtensionManagerEntries);
  return services;
}

/** Cached search tool availability, detected once at module load. */
const cachedSearchTools: SearchToolAvailability = detectSearchTools();

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
    commandContextActions: createExtensionCommandActions(
      context.extensionCommandRuntime,
      runtimeTab,
    ),
    // Multi-tab: close this session only (not process exit). Defers while streaming.
    shutdownHandler: () => {
      context.requestExtensionShutdown(runtimeTab.tab.sessionId);
    },
    onError: (error) => {
      appendSystemMessage(
        runtimeTab,
        `Extension ${error.extensionPath} ${error.event}: ${error.error}`,
        "error",
      );
    },
  });
  applyMixCodeSystemPrompt(runtimeTab.agentSession, cachedSearchTools);
}

export async function reloadRuntimeTabWithFreshServices(
  runtimeTab: RuntimeTab,
  context: RuntimeLifecycleContext,
): Promise<void> {
  const services = await context.createServices(runtimeTab.tab.workdir, MIXCODE_SYSTEM_PROMPT);
  const model = { ...runtimeTab.agentSession.agent.state.model };
  await registerMixCodeRuntimeProvider(
    services.modelRuntime,
    model,
    context.streamFn,
    context.getApiKey,
  );
  await shutdownRuntimeTab(
    runtimeTab,
    { type: "session_shutdown", reason: "reload" },
    context.getExtensionUiHost(),
  );
  const { session: agentSession } = await createAgentSessionFromServices({
    services,
    sessionManager: runtimeTab.session,
    model,
    thinkingLevel: runtimeTab.tab.thinkingLevel,
    sessionStartEvent: { type: "session_start", reason: "reload" },
    customTools: mixcodeBashCustomTools(services, () => runtimeTab.tab.title, context),
  });
  bindRuntimeSessionCore(runtimeTab, {
    agentSession,
    services,
  });
  activateMixCodeTools(agentSession);
  runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
  syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
  await bindRuntimeExtensions(runtimeTab, context);
  activateMixCodeTools(agentSession);
  // Pi refreshes the same loadedResourcesContainer on session_start and /reload;
  // the tab-level header is the MixCode analogue, so recompute it here too.
  refreshStartupHeader(runtimeTab);
  context.emitChange({ type: "extension_ui_update" }, runtimeTab);
}

/**
 * Rebind a live tab onto a new workdir: fresh services, reopened session file,
 * extension bind, startup header. Caller owns sync retrack and any pre-bind
 * agentSession listeners (e.g. deferred extension shutdown flush).
 */
export async function updateRuntimeTabWorkdir(
  runtimeTab: RuntimeTab,
  workdir: string,
  systemPrompt: string,
  sessionsRoot: string,
  context: RuntimeLifecycleContext,
  options?: {
    /** Called after session core is rebound, before bindExtensions. */
    onSessionRebound?: (runtimeTab: RuntimeTab) => void;
  },
): Promise<void> {
  if (runtimeTab.agentSession.isStreaming) {
    throw new Error("Cannot change workdir while the agent is streaming");
  }
  const services = await context.createServices(workdir, systemPrompt);
  const model = { ...runtimeTab.agentSession.agent.state.model };
  await registerMixCodeRuntimeProvider(
    services.modelRuntime,
    model,
    context.streamFn,
    context.getApiKey,
  );
  await shutdownRuntimeTab(
    runtimeTab,
    { type: "session_shutdown", reason: "reload" },
    context.getExtensionUiHost(),
  );
  const sessionManager = await reopenSessionInWorkdir(
    runtimeTab.session,
    workdir,
    sessionsRoot,
  );
  const { session: agentSession } = await createAgentSessionFromServices({
    services,
    sessionManager,
    model,
    thinkingLevel: runtimeTab.tab.thinkingLevel,
    sessionStartEvent: { type: "session_start", reason: "reload" },
    customTools: mixcodeBashCustomTools(services, () => runtimeTab.tab.title, context),
  });
  activateMixCodeTools(agentSession);
  runtimeTab.session = sessionManager;
  bindRuntimeSessionCore(runtimeTab, {
    agentSession,
    services,
  });
  runtimeTab.tab.workdir = workdir;
  options?.onSessionRebound?.(runtimeTab);
  await bindRuntimeExtensions(runtimeTab, context);
  // After extensions are bound: tool owners and diagnostics are final.
  refreshStartupHeader(runtimeTab);
}

export function subscribeRuntimeTab(runtimeTab: RuntimeTab, context: RuntimeLifecycleContext): void {
  runtimeTab.agentSession.subscribe((event: AgentSessionEvent) => {
    context.applyEvent(runtimeTab, event);
    if (event.type === "agent_end") {
      context.schedulePendingMessageFlush(runtimeTab.tab.sessionId, runtimeTab.agentSession);
    }
  });
}
