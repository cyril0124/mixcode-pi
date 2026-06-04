import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionServices,
  type AuthStorage,
  type CreateAgentSessionServicesOptions,
  createAgentSessionFromServices,
  type ExtensionFactory,
  getAgentDir,
  type SessionInfo,
  type SessionManager,
  type SessionShutdownEvent,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, matchesKey as matchesPiKey } from "@earendil-works/pi-tui";
import { stripSkillInjection } from "../core/attachments.js";
import { modelToRef, replaceRegisteredModels } from "../core/models.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import type { AgentRuntimeConfig, MixCodeModelRef, MixCodeTabInfo } from "../core/types.js";
import { MIXCODE_EXTENSION_KEYBINDINGS } from "./runtime-extension-theme.js";
import { activateMixCodeTools, getActiveToolInfos } from "./tools.js";

export { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "./runtime-extension-theme.js";

import {
  defaultExtensionManagerConfig,
  type ExtensionManagerConfig,
} from "../core/extension-manager.js";
import { isExtensionToolOwner } from "../core/extension-tool-owners.js";
import {
  appendSystemMessage,
  disposeChatRenderers,
  resetTabForNewSession,
  syncContextUsage,
  syncPreviewFromChat,
} from "./runtime-chat.js";
import { applyEvent } from "./runtime-events.js";
import {
  extensionNewRuntimeSession,
  forkRuntimeSession,
  importRuntimeJsonl,
  navigateRuntimeTree,
  type RuntimeExtensionSessionContext,
  switchRuntimeSession,
} from "./runtime-extension-session.js";
import {
  appendExtensionConflictDiagnostics,
  appendExtensionLoadErrors,
  applyExtensionAutocompleteProviders,
  closeExtensionCustomOverlays,
  surfaceShortcutError,
} from "./runtime-extension-ui.js";
import {
  consumeDeferredPendingMessageFlush,
  flushRuntimePendingMessage,
  popRuntimePendingMessage,
  scheduleRuntimePendingMessageFlush,
} from "./runtime-follow-up.js";
import {
  bindRuntimeExtensions,
  createRuntimeServices,
  createRuntimeTab,
  disposeRuntimeTabAfterShutdown,
  getExtensionManagerEntriesForServices,
  installMidTurnCompactionHook,
  rebuildRuntimeChat,
  replaceRuntimeTabSession,
  shutdownRuntimeTab,
  syncRuntimeChatFromSession,
  type RuntimeLifecycleContext,
} from "./runtime-lifecycle.js";
import { resolveRuntimeModel, resolveRuntimeModelFromSession } from "./runtime-model.js";
import { registerMixCodeRuntimeProvider } from "./runtime-provider.js";
import {
  copySession,
  createSession,
  listAllSessionsGlobal,
  listSessionsForCwd,
  openOrCreateSession,
  reopenSessionInWorkdir,
  resetExtensionHostState,
} from "./runtime-session.js";
import type {
  ChatLine,
  ExtensionArgumentCompleter,
  ExtensionCustomUiHost,
  ExtensionForkOptions,
  ExtensionManagerStore,
  ExtensionNavigateTreeOptions,
  ExtensionNewSessionOptions,
  ExtensionSwitchSessionOptions,
  MixCodeStreamFn,
  RuntimeEvent,
  RuntimeExtensionManagerEntry,
  RuntimeExtensionReloadResult,
  RuntimeModelRegistry,
  RuntimeTab,
  SessionReplacementReason,
  TerminalInputResult,
} from "./runtime-types.js";

export type { SessionInfo } from "@earendil-works/pi-coding-agent";
export type {
  ChatLine,
  EditorFactory,
  ExtensionCustomUiHost,
  RuntimeTab,
} from "./runtime-types.js";

type BashResult = Awaited<ReturnType<AgentSession["executeBash"]>>;

export class MixCodeRuntime {
  private readonly sessionsRoot: string;
  private readonly rootStateDir: string | undefined;
  private readonly agentDir: string;
  private readonly tabs = new Map<string, RuntimeTab>();
  private readonly changeListeners = new Set<
    (event: RuntimeEvent, runtimeTab: RuntimeTab) => void
  >();
  private isShuttingDown = false;
  private readonly getApiKey?: (
    provider: string,
  ) => Promise<string | undefined> | string | undefined;
  private readonly streamFn?: MixCodeStreamFn;
  private readonly authStorage?: AuthStorage;
  private readonly modelRegistry?: RuntimeModelRegistry;
  private readonly settingsManager?: SettingsManager;
  private readonly extensionFactories?: ExtensionFactory[];
  private readonly additionalExtensionPaths?: string[];
  private readonly resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
  private readonly extensionManagerStore?: ExtensionManagerStore;
  private extensionManagerConfig: ExtensionManagerConfig = defaultExtensionManagerConfig();
  private extensionUiHost?: ExtensionCustomUiHost;
  private shellExecutionSequence = 0;

  private lifecycleContext(): RuntimeLifecycleContext {
    return {
      runtime: this,
      tabs: this.tabs,
      getExtensionUiHost: () => this.extensionUiHost,
      emitChange: (event, runtimeTab) => this.emitChange(event, runtimeTab),
      applyEvent: (runtimeTab, event) => this.applyEvent(runtimeTab, event),
      schedulePendingMessageFlush: (sessionId, agentSession) =>
        this.schedulePendingMessageFlush(sessionId, agentSession),
      createServices: (workdir, systemPrompt) => this.createServices(workdir, systemPrompt),
      resolveModel: (provider, modelId) => this.resolveModel(provider, modelId),
      resolveModelFromSession: (session, fallback) =>
        this.resolveModelFromSession(session, fallback),
      streamFn: this.streamFn,
      getApiKey: this.getApiKey,
      getDisabledExtensionKeys: () => this.disabledExtensionKeys(),
      extensionToolOwnerPolicy: isExtensionToolOwner,
    };
  }

  private extensionSessionContext(): RuntimeExtensionSessionContext {
    return {
      requireTab: (sessionId) => this.requireTab(sessionId),
      createSession: (cwd, sessionId, parentSession) =>
        this.createSession(cwd, sessionId, parentSession),
      replaceRuntimeTabSession: (runtimeTab, sessionManager, reason) =>
        this.replaceRuntimeTabSession(runtimeTab, sessionManager, reason),
      syncChatFromSession: (runtimeTab) => this.syncChatFromSession(runtimeTab),
      emitChange: (event, runtimeTab) => this.emitChange(event, runtimeTab),
      extensionUiHost: () => this.extensionUiHost,
      setLiveEditorText: (text) => this.setLiveEditorText(text),
    };
  }

  constructor(
    options: {
      sessionsRoot?: string;
      rootStateDir?: string;
      agentDir?: string;
      authStorage?: AuthStorage;
      modelRegistry?: RuntimeModelRegistry;
      settingsManager?: SettingsManager;
      extensionFactories?: ExtensionFactory[];
      additionalExtensionPaths?: string[];
      resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
      extensionManagerStore?: ExtensionManagerStore;
      getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
      streamFn?: MixCodeStreamFn;
    } = {},
  ) {
    this.sessionsRoot = options.sessionsRoot ?? join(tmpdir(), "mixcode-pi-sessions");
    this.rootStateDir = options.rootStateDir;
    this.agentDir = options.agentDir ?? getAgentDir();
    this.authStorage = options.authStorage;
    this.modelRegistry = options.modelRegistry;
    this.settingsManager = options.settingsManager;
    this.extensionFactories = options.extensionFactories;
    this.additionalExtensionPaths = options.additionalExtensionPaths;
    this.resourceLoaderOptions = options.resourceLoaderOptions;
    this.extensionManagerStore = options.extensionManagerStore;
    this.getApiKey = options.getApiKey;
    this.streamFn = options.streamFn;
  }

  async loadExtensionManagerConfig(): Promise<void> {
    this.extensionManagerConfig =
      (await this.extensionManagerStore?.load()) ?? defaultExtensionManagerConfig();
  }

  async createTab(
    tab: MixCodeTabInfo,
    config: Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
      model?: Model<any>;
      suppressStartupSummary?: boolean;
    },
  ): Promise<RuntimeTab> {
    const session = await this.openOrCreateSession(tab.sessionId, config.workdir);
    return this.createRuntimeTab(tab, session, config);
  }

  async clearTab(
    sessionId: string,
    config: Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
      model?: Model<any>;
      newSessionId?: string;
      suppressStartupSummary?: boolean;
    },
  ): Promise<RuntimeTab> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agent.state.isStreaming) {
      throw new Error("Cannot clear a session while it is streaming");
    }
    const oldHeader = runtimeTab.session.getHeader();
    const newSession = await this.createSession(
      config.workdir,
      config.newSessionId,
      oldHeader?.parentSession,
    );
    await this.shutdownRuntimeTab(runtimeTab, {
      type: "session_shutdown",
      reason: "new",
      targetSessionFile: newSession.getSessionFile() ?? undefined,
    });
    this.tabs.delete(sessionId);
    resetTabForNewSession(runtimeTab.tab, newSession.getSessionId());
    return this.createRuntimeTab(runtimeTab.tab, newSession, {
      ...config,
      suppressStartupSummary: true,
    });
  }

  private async createRuntimeTab(
    tab: MixCodeTabInfo,
    session: SessionManager,
    config: Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
      model?: Model<any>;
      suppressStartupSummary?: boolean;
    },
  ): Promise<RuntimeTab> {
    return createRuntimeTab(tab, session, config, this.lifecycleContext());
  }

  getTab(sessionId: string): RuntimeTab | undefined {
    return this.tabs.get(sessionId);
  }

  listTabs(): RuntimeTab[] {
    return [...this.tabs.values()].sort((a, b) => a.tab.index - b.tab.index);
  }

  getPromptHistory(sessionId: string): string[] {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) return [];
    const history: string[] = [];
    for (const line of runtimeTab.chat) {
      if (line.role === "user" && line.text.trim()) {
        history.push(stripSkillInjection(line.text));
      }
    }
    return history;
  }

  onChange(listener: (event: RuntimeEvent, runtimeTab: RuntimeTab) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  beginShutdown(): void {
    this.isShuttingDown = true;
    this.changeListeners.clear();
  }

  getExtensionCommands(sessionId: string) {
    return this.requireTab(sessionId)
      .agentSession.extensionRunner.getRegisteredCommands()
      .map((command) => ({
        name: command.invocationName,
        description: command.description,
        getArgumentCompletions: command.getArgumentCompletions,
        sourceInfo: command.sourceInfo,
      }));
  }

  getAllExtensionCommands() {
    const commands = new Map<
      string,
      {
        name: string;
        description?: string;
        getArgumentCompletions?: ExtensionArgumentCompleter;
        sourceInfo?: { path: string; source: string };
      }
    >();
    for (const runtimeTab of this.listTabs()) {
      for (const command of this.getExtensionCommands(runtimeTab.tab.sessionId)) {
        commands.set(command.name, {
          name: command.name,
          description: command.description,
          getArgumentCompletions: command.getArgumentCompletions,
          sourceInfo: command.sourceInfo,
        });
      }
    }
    return [...commands.values()];
  }

  getExtensionTools(sessionId: string) {
    return getActiveToolInfos(this.requireTab(sessionId).agentSession);
  }

  getExtensionManagerEntries(sessionId: string): RuntimeExtensionManagerEntry[] {
    const runtimeTab = this.requireTab(sessionId);
    return [...runtimeTab.extensionManagerEntries];
  }

  async setExtensionEnabled(sessionId: string, key: string, enabled: boolean): Promise<void> {
    this.requireTab(sessionId);
    const disabled = new Set(this.extensionManagerConfig.disabledExtensionKeys);
    if (enabled) disabled.delete(key);
    else disabled.add(key);
    this.extensionManagerConfig = {
      version: 1,
      disabledExtensionKeys: [...disabled].sort(),
    };
    await this.extensionManagerStore?.save(this.extensionManagerConfig);
  }

  async reloadExtensionManagerTab(sessionId: string): Promise<RuntimeExtensionReloadResult> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      return {
        sessionId,
        title: runtimeTab.tab.title,
        status: "skipped",
        reason: "streaming",
      };
    }
    if (runtimeTab.agentSession.isCompacting) {
      return {
        sessionId,
        title: runtimeTab.tab.title,
        status: "skipped",
        reason: "compacting",
      };
    }
    try {
      await this.extensionReload(sessionId);
      return { sessionId, title: runtimeTab.tab.title, status: "reloaded" };
    } catch (error) {
      return {
        sessionId,
        title: runtimeTab.tab.title,
        status: "error",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async reloadExtensionManagerWorkdir(workdir: string): Promise<RuntimeExtensionReloadResult[]> {
    const targets = this.listTabs()
      .filter((runtimeTab) => runtimeTab.tab.workdir === workdir)
      .map((runtimeTab) => runtimeTab.tab.sessionId);
    const results: RuntimeExtensionReloadResult[] = [];
    for (const sessionId of targets) {
      results.push(await this.reloadExtensionManagerTab(sessionId));
    }
    return results;
  }

  refreshTabStatus(sessionId: string): MixCodeTabInfo {
    const runtimeTab = this.requireTab(sessionId);
    const agentState = runtimeTab.agent.state;
    runtimeTab.tab.status = agentState.errorMessage
      ? "error"
      : agentState.isStreaming
        ? "running"
        : runtimeTab.tab.status === "done"
          ? "done"
          : "idle";
    runtimeTab.tab.model = {
      provider: agentState.model.provider,
      modelId: agentState.model.id,
      displayName: `${agentState.model.provider}/${agentState.model.id}`,
      contextWindow: agentState.model.contextWindow,
    };
    // Only sync contextLimit from model if the user hasn't overridden it
    if (!runtimeTab.tab.contextLimitOverridden) {
      runtimeTab.tab.contextLimit = agentState.model.contextWindow;
    }
    runtimeTab.tab.thinkingLevel = agentState.thinkingLevel;
    syncContextUsage(runtimeTab);
    return runtimeTab.tab;
  }

  refreshAllTabStatuses(): MixCodeTabInfo[] {
    return this.listTabs().map((runtimeTab) => this.refreshTabStatus(runtimeTab.tab.sessionId));
  }

  setExtensionUiHost(host: ExtensionCustomUiHost | undefined): void {
    this.extensionUiHost = host;
    if (!host) {
      for (const runtimeTab of this.tabs.values()) closeExtensionCustomOverlays(runtimeTab);
    }
  }

  applyExtensionAutocompleteProviders(
    sessionId: string,
    base: AutocompleteProvider,
  ): AutocompleteProvider {
    return applyExtensionAutocompleteProviders(this.requireTab(sessionId), base);
  }

  hasExtensionCustomOverlay(sessionId: string): boolean {
    return (this.tabs.get(sessionId)?.extensionCustomOverlayClosers.size ?? 0) > 0;
  }

  focusExtensionCustomOverlay(sessionId: string): void {
    const handles = this.tabs.get(sessionId)?.extensionCustomOverlayHandles;
    const handle = handles ? [...handles].at(-1) : undefined;
    handle?.focus();
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    const trimmed = text.trim();
    if (!trimmed) return;
    if (runtimeTab.agentSession.isStreaming) {
      await runtimeTab.agentSession.prompt(trimmed, { streamingBehavior: "steer" });
      return;
    }
    runtimeTab.postRunWorkingStartedAt = undefined;
    if (runtimeTab.agentSession.isCompacting) {
      throw new Error("Cannot prompt while compaction is running");
    }
    await runtimeTab.agentSession.prompt(text);
  }

  async executeShellCommand(
    sessionId: string,
    command: string,
    options: { excludeFromContext?: boolean } = {},
  ): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    const trimmed = command.trim();
    if (!trimmed) return;
    if (runtimeTab.agentSession.isBashRunning) {
      throw new Error("Cannot run a shell command while another bash command is running");
    }
    runtimeTab.tab.status = "running";
    runtimeTab.tab.workingStartedAt = new Date().toISOString();
    runtimeTab.tab.lastWorkedDurationSeconds = undefined;
    runtimeTab.tab.chatScrollOffset = 0;
    const excludeFromContext = options.excludeFromContext === true;
    const toolCallId = `user-bash-${Date.now()}-${++this.shellExecutionSequence}`;
    const args = { command: trimmed };

    try {
      const eventResult = await runtimeTab.agentSession.extensionRunner.emitUserBash({
        type: "user_bash",
        command: trimmed,
        excludeFromContext,
        cwd: runtimeTab.session.getCwd(),
      });
      upsertUserBashLine(runtimeTab, toolCallId, "running", "", args, excludeFromContext);
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);

      let result: BashResult;
      if (eventResult?.result) {
        result = eventResult.result;
        runtimeTab.agentSession.recordBashResult(trimmed, result, { excludeFromContext });
      } else {
        let streamedOutput = "";
        result = await runtimeTab.agentSession.executeBash(
          trimmed,
          (chunk) => {
            streamedOutput += chunk;
            upsertUserBashLine(
              runtimeTab,
              toolCallId,
              "running",
              streamedOutput,
              args,
              excludeFromContext,
              {
                exitCode: undefined,
                cancelled: false,
                truncated: false,
                fullOutputPath: undefined,
              },
            );
            this.emitChange({ type: "extension_ui_update" }, runtimeTab);
          },
          { excludeFromContext, operations: eventResult?.operations },
        );
      }

      const isError = result.cancelled || (result.exitCode !== undefined && result.exitCode !== 0);
      upsertUserBashLine(
        runtimeTab,
        toolCallId,
        isError ? "error" : "success",
        result.output,
        args,
        excludeFromContext,
        result,
      );
      runtimeTab.tab.status = "idle";
      runtimeTab.tab.unreadDone = true;
      runtimeTab.tab.lastWorkedDurationSeconds = elapsedShellSeconds(
        runtimeTab.tab.workingStartedAt,
        new Date(),
      );
      runtimeTab.tab.workingStartedAt = undefined;
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      runtimeTab.tab.status = "error";
      upsertUserBashLine(runtimeTab, toolCallId, "error", errorMessage, args, excludeFromContext, {
        exitCode: undefined,
        cancelled: false,
        truncated: false,
        fullOutputPath: undefined,
      });
      runtimeTab.tab.workingStartedAt = undefined;
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      throw error;
    }
  }

  appendSystemMessage(sessionId: string, text: string): void {
    const runtimeTab = this.requireTab(sessionId);
    appendSystemMessage(runtimeTab, text);
    this.emitChange({ type: "extension_ui_update" }, runtimeTab);
  }

  abortTab(sessionId: string): boolean {
    const runtimeTab = this.requireTab(sessionId);
    if (!runtimeTab.agentSession.isStreaming) {
      // Try aborting branch summarization and compaction (no-op if not running)
      runtimeTab.agentSession.abortBranchSummary();
      runtimeTab.agentSession.abortCompaction();
      return false;
    }
    void runtimeTab.agentSession.abort();
    runtimeTab.tab.pendingEscapeAction = undefined;
    runtimeTab.tab.pendingEscapeArmedAt = undefined;
    runtimeTab.tab.status = "running";
    runtimeTab.tab.workingStartedAt ??= new Date().toISOString();
    runtimeTab.tab.chatScrollOffset = 0;
    appendSystemMessage(runtimeTab, "Abort requested.");
    return true;
  }

  abortAllTabs(): void {
    for (const runtimeTab of this.tabs.values()) {
      runtimeTab.agentSession.abortRetry();
      runtimeTab.agentSession.abortCompaction();
      runtimeTab.agentSession.abortBranchSummary();
      if (runtimeTab.agentSession.isBashRunning) runtimeTab.agentSession.abortBash();
      if (runtimeTab.agentSession.isStreaming) runtimeTab.agentSession.agent.abort();
      runtimeTab.agentSession.clearQueue();
      runtimeTab.tab.pendingMessages = [];
      runtimeTab.queuedPromptCount = 0;
      runtimeTab.tab.pendingEscapeAction = undefined;
      runtimeTab.tab.pendingEscapeArmedAt = undefined;
    }
  }

  dispatchTerminalInput(sessionId: string, data: string): TerminalInputResult {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab || runtimeTab.extensionTerminalInputHandlers.size === 0) return undefined;
    let current = data;
    for (const handler of runtimeTab.extensionTerminalInputHandlers) {
      const result = handler(current);
      if (result?.consume) return { consume: true };
      if (result?.data !== undefined) current = result.data;
    }
    return current === data ? undefined : { data: current };
  }

  dispatchExtensionShortcut(sessionId: string, data: string): boolean {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) return false;
    const shortcuts = runtimeTab.agentSession.extensionRunner.getShortcuts(
      MIXCODE_EXTENSION_KEYBINDINGS,
    );
    for (const [key, shortcut] of shortcuts) {
      if (!matchesPiKey(data, key)) continue;
      try {
        const result = shortcut.handler(runtimeTab.agentSession.extensionRunner.createContext());
        void Promise.resolve(result).catch((error: unknown) => {
          surfaceShortcutError(runtimeTab, error);
          this.emitChange({ type: "extension_ui_update" }, runtimeTab);
        });
      } catch (error) {
        surfaceShortcutError(runtimeTab, error);
        this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      }
      return true;
    }
    return false;
  }

  resolveExtensionDialog(
    sessionId: string,
    requestId: string,
    result: string | boolean | undefined,
  ): boolean {
    const runtimeTab = this.tabs.get(sessionId);
    const resolver = runtimeTab?.extensionDialogResolvers.get(requestId);
    if (!runtimeTab || !resolver) return false;
    runtimeTab.extensionDialogResolvers.delete(requestId);
    resolver(result);
    return true;
  }

  async flushPendingMessage(sessionId: string, count?: number): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    await flushRuntimePendingMessage(runtimeTab, count);
  }

  private schedulePendingMessageFlush(sessionId: string, agentSession: AgentSession): void {
    scheduleRuntimePendingMessageFlush(
      sessionId,
      agentSession,
      (targetSessionId) => this.tabs.get(targetSessionId),
      (targetSessionId, count) => this.flushPendingMessage(targetSessionId, count),
    );
  }

  popPendingMessage(sessionId: string): string | undefined {
    const runtimeTab = this.requireTab(sessionId);
    return popRuntimePendingMessage(runtimeTab);
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<SessionManager> {
    const source = this.requireTab(sourceSessionId);
    return copySession(source.session, source.tab.workdir, newSessionId, this.sessionsRoot);
  }

  /**
   * List sessions for a specific working directory.
   * Uses the runtime's sessionsRoot as the session directory.
   */
  async listSessions(cwd: string): Promise<SessionInfo[]> {
    return listSessionsForCwd(cwd, this.sessionsRoot);
  }

  /**
   * List all sessions across all working directories.
   * Scans every workdir's sessions directory under rootStateDir,
   * plus the legacy root sessions directory.
   */
  async listAllSessions(): Promise<SessionInfo[]> {
    return listAllSessionsGlobal(this.sessionsRoot, this.rootStateDir);
  }

  /**
   * Persist a session display name into the session file.
   * Appends a session_info entry so the name survives restarts and shows in /resume.
   */
  renameSession(sessionId: string, name: string): void {
    const runtimeTab = this.requireTab(sessionId);
    runtimeTab.session.appendSessionInfo(name);
  }

  async extensionNewSession(
    sessionId: string,
    options?: ExtensionNewSessionOptions,
  ): Promise<{ cancelled: boolean }> {
    return extensionNewRuntimeSession(sessionId, options, this.extensionSessionContext());
  }

  async extensionFork(
    sessionId: string,
    entryId: string,
    options?: ExtensionForkOptions,
  ): Promise<{ cancelled: boolean }> {
    return forkRuntimeSession(sessionId, entryId, options, this.extensionSessionContext());
  }

  async extensionNavigateTree(
    sessionId: string,
    targetId: string,
    options?: ExtensionNavigateTreeOptions,
  ): Promise<{ cancelled: boolean; aborted?: boolean }> {
    return navigateRuntimeTree(sessionId, targetId, options, this.extensionSessionContext());
  }

  async extensionSwitchSession(
    sessionId: string,
    sessionPath: string,
    options?: ExtensionSwitchSessionOptions,
  ): Promise<{ cancelled: boolean }> {
    return switchRuntimeSession(sessionId, sessionPath, options, this.extensionSessionContext());
  }

  async importFromJsonl(
    sessionId: string,
    inputPath: string,
    cwdOverride?: string,
  ): Promise<{ cancelled: boolean }> {
    return importRuntimeJsonl(sessionId, inputPath, cwdOverride, this.extensionSessionContext());
  }

  async extensionReload(sessionId: string): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot reload extensions while the agent is streaming");
    }
    if (runtimeTab.agentSession.isCompacting) {
      throw new Error("Cannot reload extensions while compaction is running");
    }
    this.resetExtensionHostState(runtimeTab);
    await runtimeTab.agentSession.reload();
    runtimeTab.extensionToolOwnerPolicy = isExtensionToolOwner;
    activateMixCodeTools(runtimeTab.agentSession, runtimeTab.extensionToolOwnerPolicy);
    runtimeTab.extensionsResult = runtimeTab.agentSession.resourceLoader.getExtensions();
    runtimeTab.extensionManagerEntries = getExtensionManagerEntriesForServices(runtimeTab.services);
    runtimeTab.agent = runtimeTab.agentSession.agent;
    disposeChatRenderers(runtimeTab.chat);
    runtimeTab.chat = await this.rebuildChat(runtimeTab);
    syncPreviewFromChat(runtimeTab.tab, runtimeTab.chat);
    appendExtensionLoadErrors(runtimeTab);
    appendExtensionConflictDiagnostics(runtimeTab, runtimeTab.extensionToolOwnerPolicy);
    this.emitChange({ type: "extension_ui_update" }, runtimeTab);
  }

  /**
   * Reload model configuration from disk (models.json + auth) without restarting.
   *
   * The native agentSession.reload() only refreshes settings/extensions/skills/
   * prompts/themes; the model registry is loaded once at bootstrap and is never
   * touched by /reload. This re-reads models.json via the shared ModelRegistry
   * (which also re-applies the dynamic faux/runtime providers it owns) and
   * rebuilds the global resolver map, then returns the configured, selectable
   * model refs so the UI can rebuild its picker list.
   *
   * Returns an empty list when no model registry is wired (e.g. faux-only tests).
   */
  reloadModelConfig(): MixCodeModelRef[] {
    if (!this.modelRegistry?.refresh) return [];
    this.modelRegistry.refresh();
    const all = this.modelRegistry.getAll();
    replaceRegisteredModels(all);
    return all
      // The faux model is a runtime-only default, never a configured choice.
      .filter((model) => model.provider !== "faux")
      .filter((model) => this.modelRegistry?.getProviderAuthStatus?.(model.provider).configured)
      .map(modelToRef);
  }

  async closeTab(sessionId: string): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    await this.shutdownRuntimeTab(runtimeTab, { type: "session_shutdown", reason: "quit" });
    this.tabs.delete(sessionId);
  }

  async closeAllTabs(): Promise<void> {
    const entries = [...this.tabs.entries()];
    const closeResults = await Promise.allSettled(
      entries.map(async ([, runtimeTab]) => {
        await runtimeTab.agentSession.extensionRunner.emit({
          type: "session_shutdown",
          reason: "quit",
        });
        disposeRuntimeTabAfterShutdown(runtimeTab, this.extensionUiHost);
      }),
    );
    for (const [index, result] of closeResults.entries()) {
      if (result.status === "fulfilled") {
        this.tabs.delete(entries[index]![0]);
        continue;
      }
      for (let remainingIndex = index; remainingIndex < entries.length; remainingIndex++) {
        const [sessionId, runtimeTab] = entries[remainingIndex]!;
        if (!this.tabs.has(sessionId)) continue;
        disposeRuntimeTabAfterShutdown(runtimeTab, this.extensionUiHost);
        this.tabs.delete(sessionId);
      }
      throw result.reason;
    }
  }

  async deleteTab(sessionId: string): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    await this.shutdownRuntimeTab(runtimeTab, { type: "session_shutdown", reason: "quit" });
    const file = runtimeTab.session.getSessionFile();
    if (file) await rm(file, { force: true });
    this.tabs.delete(sessionId);
  }

  async deleteAllTabs(): Promise<void> {
    for (const sessionId of [...this.tabs.keys()]) {
      await this.deleteTab(sessionId);
    }
  }

  async compactSession(sessionId: string, customInstructions = ""): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot compact while the agent is streaming");
    }
    if (runtimeTab.agentSession.isCompacting) {
      throw new Error("Cannot compact while compaction is running");
    }
    const branch = runtimeTab.session.getBranch();
    if (branch.filter((entry) => entry.type === "message").length < 2) {
      throw new Error("Nothing to compact (no messages yet)");
    }
    if (branch.at(-1)?.type === "compaction") {
      throw new Error("Session is already compacted");
    }
    runtimeTab.tab.status = "running";
    runtimeTab.tab.workingStartedAt = new Date().toISOString();
    runtimeTab.tab.lastWorkedDurationSeconds = undefined;
    runtimeTab.tab.pendingEscapeAction = undefined;
    runtimeTab.tab.pendingEscapeArmedAt = undefined;
    this.emitChange({ type: "extension_ui_update" }, runtimeTab);
    try {
      // compact() emits compaction_end which triggers applyEvent to rebuild chat
      await runtimeTab.agentSession.compact(customInstructions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
      if (!aborted) {
        runtimeTab.tab.status = "error";
      }
      runtimeTab.tab.workingStartedAt = undefined;
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      throw error;
    }
  }

  requireTab(sessionId: string): RuntimeTab {
    const tab = this.tabs.get(sessionId);
    if (!tab) throw new Error(`Unknown tab session: ${sessionId}`);
    return tab;
  }

  resolveModel(provider: string, modelId: string): Model<any> {
    return resolveRuntimeModel(provider, modelId, this.modelRegistry);
  }

  updateTabModel(sessionId: string, model: Model<any>): void {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agent.state.isStreaming) {
      throw new Error("Cannot change model while the agent is streaming");
    }
    runtimeTab.agent.state.model = model;
    runtimeTab.tab.model = {
      provider: model.provider,
      modelId: model.id,
      displayName: `${model.provider}/${model.id}`,
      contextWindow: model.contextWindow,
    };
    runtimeTab.tab.contextLimit = model.contextWindow;
    runtimeTab.tab.contextLimitOverridden = false;
  }

  updateTabThinkingLevel(sessionId: string, level: ThinkingLevel): ThinkingLevel {
    const runtimeTab = this.requireTab(sessionId);
    runtimeTab.agentSession.setThinkingLevel(level);
    runtimeTab.tab.thinkingLevel = runtimeTab.agent.state.thinkingLevel;
    return runtimeTab.tab.thinkingLevel;
  }

  async updateTabWorkdir(
    sessionId: string,
    workdir: string,
    systemPrompt = MIXCODE_SYSTEM_PROMPT,
  ): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot change workdir while the agent is streaming");
    }
    const services = await this.createServices(workdir, systemPrompt);
    const model = runtimeTab.agent.state.model;
    registerMixCodeRuntimeProvider(services.modelRegistry, model, this.streamFn, this.getApiKey);
    await this.shutdownRuntimeTab(runtimeTab, { type: "session_shutdown", reason: "reload" });
    const sessionManager = await reopenSessionInWorkdir(
      runtimeTab.session,
      workdir,
      this.sessionsRoot,
    );
    const { session: agentSession, extensionsResult } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model,
      thinkingLevel: runtimeTab.tab.thinkingLevel,
      sessionStartEvent: { type: "session_start", reason: "reload" },
    });
    const extensionToolOwnerPolicy = isExtensionToolOwner;
    activateMixCodeTools(agentSession, extensionToolOwnerPolicy);
    runtimeTab.session = sessionManager;
    runtimeTab.agentSession = agentSession;
    runtimeTab.services = services;
    runtimeTab.extensionsResult = extensionsResult;
    runtimeTab.extensionManagerEntries = getExtensionManagerEntriesForServices(services);
    runtimeTab.extensionToolOwnerPolicy = extensionToolOwnerPolicy;
    runtimeTab.agent = agentSession.agent;
    installMidTurnCompactionHook(agentSession, runtimeTab.tab, { current: runtimeTab });
    runtimeTab.tab.workdir = workdir;
    appendExtensionLoadErrors(runtimeTab);
    appendExtensionConflictDiagnostics(runtimeTab, runtimeTab.extensionToolOwnerPolicy);
    agentSession.subscribe((event) => {
      this.applyEvent(runtimeTab, event);
      if (event.type === "agent_end") {
        if (consumeDeferredPendingMessageFlush(runtimeTab)) return;
        this.schedulePendingMessageFlush(runtimeTab.tab.sessionId, runtimeTab.agentSession);
      }
    });
    await this.bindExtensions(runtimeTab);
  }

  private async shutdownRuntimeTab(
    runtimeTab: RuntimeTab,
    event: SessionShutdownEvent,
  ): Promise<void> {
    await shutdownRuntimeTab(runtimeTab, event, this.extensionUiHost);
  }

  private resetExtensionHostState(runtimeTab: RuntimeTab): void {
    resetExtensionHostState(runtimeTab, this.extensionUiHost);
  }

  private async openOrCreateSession(sessionId: string, cwd: string): Promise<SessionManager> {
    return openOrCreateSession(sessionId, cwd, this.sessionsRoot);
  }

  private async createSession(
    cwd: string,
    sessionId?: string,
    parentSession?: string,
  ): Promise<SessionManager> {
    return createSession(cwd, this.sessionsRoot, sessionId, parentSession);
  }

  private async replaceRuntimeTabSession(
    runtimeTab: RuntimeTab,
    sessionManager: SessionManager,
    reason: SessionReplacementReason,
  ): Promise<RuntimeTab> {
    return replaceRuntimeTabSession(runtimeTab, sessionManager, reason, this.lifecycleContext());
  }

  private async syncChatFromSession(runtimeTab: RuntimeTab): Promise<void> {
    await syncRuntimeChatFromSession(runtimeTab);
  }

  private resolveModelFromSession(
    session: SessionManager,
    fallback: MixCodeTabInfo["model"] | Model<any> | undefined,
  ): Model<any> {
    return resolveRuntimeModelFromSession(session, fallback, this.modelRegistry);
  }

  private setLiveEditorText(text: string): void {
    this.extensionUiHost?.editor?.setText(text);
  }

  private async rebuildChat(runtimeTab: RuntimeTab): Promise<ChatLine[]> {
    return rebuildRuntimeChat(runtimeTab);
  }

  private async createServices(
    workdir: string,
    systemPrompt?: string,
  ): Promise<AgentSessionServices> {
    return createRuntimeServices({
      workdir,
      systemPrompt,
      agentDir: this.agentDir,
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
      settingsManager: this.settingsManager,
      resourceLoaderOptions: this.resourceLoaderOptions,
      additionalExtensionPaths: this.additionalExtensionPaths,
      extensionFactories: this.extensionFactories,
      getDisabledExtensionKeys: () => this.disabledExtensionKeys(),
    });
  }

  private disabledExtensionKeys(): Set<string> {
    return new Set(this.extensionManagerConfig.disabledExtensionKeys);
  }

  private async bindExtensions(runtimeTab: RuntimeTab): Promise<void> {
    await bindRuntimeExtensions(runtimeTab, this.lifecycleContext());
  }

  private applyEvent(runtimeTab: RuntimeTab, event: RuntimeEvent): void {
    applyEvent(runtimeTab, event, (nextEvent, nextRuntimeTab) => {
      this.emitChange(nextEvent, nextRuntimeTab);
    });
  }

  private emitChange(event: RuntimeEvent, runtimeTab: RuntimeTab): void {
    if (this.isShuttingDown) return;
    this.changeListeners.forEach((listener) => listener(event, runtimeTab));
  }
}

function elapsedShellSeconds(startedAt: string | undefined, endedAt: Date): number | undefined {
  if (!startedAt) return undefined;
  const startMs = Date.parse(startedAt);
  if (Number.isNaN(startMs)) return undefined;
  return Math.max(0, Math.round((endedAt.getTime() - startMs) / 1000));
}

function upsertUserBashLine(
  runtimeTab: RuntimeTab,
  toolCallId: string,
  status: ChatLine["status"],
  text: string,
  args: { command: string },
  excludeFromContext: boolean,
  result?: Pick<BashResult, "exitCode" | "cancelled" | "truncated" | "fullOutputPath">,
): void {
  runtimeTab.tab.chatScrollOffset = 0;
  const existing = runtimeTab.chat.findIndex(
    (line) => line.role === "tool" && line.toolCallId === toolCallId,
  );
  const line: ChatLine = {
    role: "tool",
    title: "bash",
    variant: "user-bash",
    toolCallId,
    status,
    text,
    args,
    excludeFromContext,
    bashExitCode: result?.exitCode,
    bashCancelled: result?.cancelled,
    bashTruncated: result?.truncated,
    bashFullOutputPath: result?.fullOutputPath,
  };
  if (existing >= 0 && runtimeTab.chat[existing]?.role === "tool") {
    runtimeTab.chat[existing] = line;
    return;
  }
  runtimeTab.chat.push(line);
}
