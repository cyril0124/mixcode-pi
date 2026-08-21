import * as os from "node:os";
import * as path from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type AgentSessionServices,
  type CreateAgentSessionServicesOptions,
  type ExtensionFactory,
  getAgentDir,
  type ModelRuntime,
  type SessionInfo,
  type SessionEntry,
  SessionManager,
  type SessionShutdownEvent,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteProvider, matchesKey as matchesPiKey } from "@earendil-works/pi-tui";
import { contentText } from "./runtime-tool-chat.js";
import { modelToRef, replaceRegisteredModels } from "../core/models.js";
import { nextAvailableAgentTitle } from "../core/defaults.js";
import { onActiveTabChange } from "../core/tabs.js";
import { clearPendingEscape } from "../core/escape.js";
import {
  setPendingFollowUps,
  setPendingMessages,
  setTabStatus,
} from "../core/tab-state.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { HOME_TAB_ID, type AgentRuntimeConfig, type MixCodeModel, type MixCodeModelRef, type MixCodeTabInfo, type QueueKind } from "../core/types.js";
import { MIXCODE_EXTENSION_KEYBINDINGS } from "./runtime-extension-theme.js";
import { getActiveToolInfos } from "./tools.js";

export { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "./runtime-extension-theme.js";

import {
  defaultExtensionManagerConfig,
  type ExtensionManagerConfig,
  type ExtensionManagerEntry,
  type ExtensionReloadResult,
} from "../core/extension-manager.js";
import {
  appendSystemMessage,
  applyRuntimeTabModel,
  disposeChatRenderers,
  entriesToChatLines,
  inspectSessionImport,
  isNothingToCompactError,
  resetTabForNewSession,
  syncContextUsage,
  syncPreviewFromChat,
  type SystemMessageKind,
} from "./runtime-chat.js";
import { applyEvent } from "./runtime-events.js";
import { reloadRuntimeSessionFromDisk } from "./runtime-session-reload.js";
import { invalidateSessionCatalog } from "../core/session-catalog.js";
import { RuntimeSyncManager } from "./runtime-sync.js";
import type { SessionLockHandle } from "../core/session-lock.js";
import {
  extensionNewRuntimeSession,
  forkRuntimeSession,
  importRuntimeJsonl,
  navigateRuntimeTree,
  retractRuntimeTurn,
  type RuntimeExtensionSessionContext,
  switchRuntimeSession,
} from "./runtime-extension-session.js";
import {
  applyExtensionAutocompleteProviders,
  closeExtensionCustomOverlays,
  surfaceShortcutError,
} from "./runtime-extension-ui.js";
import {
  dispatchTurn,
  flushRuntimePendingMessage,
  popRuntimePendingMessage,
  scheduleRuntimePendingMessageFlush,
} from "./runtime-follow-up.js";
import {
  createRuntimeServices,
  createRuntimeTabWithFallback,
  disposeRuntimeTabAfterShutdown,
  reloadRuntimeTabWithFreshServices,
  replaceRuntimeTabSession,
  shutdownRuntimeTab,
  syncRuntimeChatFromSession,
  updateRuntimeTabWorkdir,
  type RuntimeLifecycleContext,
} from "./runtime-lifecycle.js";
import { resolveRuntimeModel, resolveRuntimeModelFromSession } from "./runtime-model.js";
import {
  copySession,
  createSession,
  findSessionFileByName,
  getExtensionManagerEntriesForServices,
  listAllSessionsGlobal,
  listSessionsForCwd,
  openOrCreateSession,
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

/** Thrown when `!`/`!!` is submitted while another user bash is still running (Pi parity). */
export class BashAlreadyRunningError extends Error {
  constructor() {
    super("A bash command is already running. Press Esc to cancel it first.");
    this.name = "BashAlreadyRunningError";
  }
}

export function isBashAlreadyRunningError(error: unknown): boolean {
  return (
    error instanceof BashAlreadyRunningError ||
    (error instanceof Error &&
      error.name === "BashAlreadyRunningError" &&
      error.message === "A bash command is already running. Press Esc to cancel it first.")
  );
}

function promptsFromSessionFile(file: string | undefined): string[] {
  if (!file) return [];
  return SessionManager.open(file)
    .getBranch()
    .flatMap((entry) => promptsFromSessionEntry(entry));
}

function promptsFromSessionEntry(entry: SessionEntry): string[] {
  if (entry.type !== "message" || entry.message.role !== "user") return [];
  const text = contentText(entry.message.content).trim();
  return text ? [text] : [];
}

export class MixCodeRuntime {
  private readonly sessionsRoot: string;
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
  private readonly modelRuntime?: ModelRuntime;
  private readonly modelRegistry?: RuntimeModelRegistry;
  private readonly settingsManager?: SettingsManager;
  private readonly extensionFactories?: ExtensionFactory[];
  private readonly additionalExtensionPaths?: string[];
  private readonly resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
  private readonly extensionManagerStore?: ExtensionManagerStore;
  private extensionManagerConfig: ExtensionManagerConfig = defaultExtensionManagerConfig();
  private extensionUiHost?: ExtensionCustomUiHost;
  private shellExecutionSequence = 0;
  private readonly sync: RuntimeSyncManager;
  /** sessionIds that called ctx.shutdown() while streaming/compacting. */
  private readonly pendingExtensionShutdown = new Set<string>();
  /** UI host removes the tab from MixCodeState after runtime closeTab. */
  private readonly tabClosedListeners = new Set<(sessionId: string) => void>();
  /** UI rebuilds /model list when extensions registerProvider/unregisterProvider. */
  private readonly modelsChangedListeners = new Set<(refs: MixCodeModelRef[]) => void>();
  /** UI-focused agent session id; undefined when Home is focused. */
  private focusedSessionId: string | undefined;

  private lifecycleContext(): RuntimeLifecycleContext {
    return {
      extensionCommandRuntime: this,
      requestExtensionShutdown: (sessionId) => this.requestExtensionShutdown(sessionId),
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
      getFocusedTabTitle: () => this.getFocusedTabTitle(),
    };
  }

  private getFocusedTabTitle(): string | undefined {
    const focusedId = this.focusedSessionId;
    if (!focusedId) return undefined;
    for (const runtimeTab of this.tabs.values()) {
      if (runtimeTab.tab.sessionId === focusedId) return runtimeTab.tab.title;
    }
    return undefined;
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
      agentDir?: string;
      modelRuntime?: ModelRuntime;
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
    this.sessionsRoot = options.sessionsRoot ?? path.join(os.tmpdir(), "mixcode-pi-sessions");
    this.agentDir = options.agentDir ?? getAgentDir();
    this.modelRuntime = options.modelRuntime;
    this.modelRegistry = options.modelRegistry;
    this.settingsManager = options.settingsManager;
    this.extensionFactories = options.extensionFactories;
    this.additionalExtensionPaths = options.additionalExtensionPaths;
    this.resourceLoaderOptions = options.resourceLoaderOptions;
    this.extensionManagerStore = options.extensionManagerStore;
    this.getApiKey = options.getApiKey;
    this.streamFn = options.streamFn;
    this.sync = new RuntimeSyncManager(
      this.sessionsRoot,
      (sessionId) => this.syncSessionFromDisk(sessionId),
    );
    // Extension pi.registerProvider updates ModelRegistry but MixCode UI reads
    // state.availableModels; keep them in sync when providers are registered.
    this.installProviderRegistryUiSync();
    // Runtime lives for the process lifetime; the subscription is never torn down.
    onActiveTabChange((tabId) => {
      this.focusedSessionId = tabId === HOME_TAB_ID ? undefined : tabId;
    });
  }

  /**
   * Enable cross-process session sync: poll registered session files for
   * external appends and serialize this instance's session writes with a turn
   * lock. Opt-in (the CLI calls it at startup) so batch/test runtimes that
   * share a sessionsRoot do not poll files or contend on locks.
   */
  enableSessionSync(): void {
    this.sync.enable();
    for (const runtimeTab of this.tabs.values()) this.sync.register(runtimeTab);
  }

  async loadExtensionManagerConfig(): Promise<void> {
    this.extensionManagerConfig =
      (await this.extensionManagerStore?.load()) ?? defaultExtensionManagerConfig();
  }

  async createTab(
    tab: MixCodeTabInfo,
    config: Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
      model?: MixCodeModel;
      reuseServicesFromSessionId?: string;
      preserveCallerTitle?: boolean;
    },
  ): Promise<RuntimeTab> {
    const session = await this.openOrCreateSession(tab.sessionId, config.workdir);
    const runtimeTab = await createRuntimeTabWithFallback(
      tab,
      session,
      config,
      this.lifecycleContext(),
    );
    this.sync.register(runtimeTab);
    return runtimeTab;
  }

  async clearTab(
    sessionId: string,
    config: Omit<AgentRuntimeConfig, "sessionId" | "model"> & {
      model?: MixCodeModel;
      newSessionId?: string;
      /** Rebuild services (e.g. apply a new base system prompt). Default reuses. */
      rebuildServices?: boolean;
    },
  ): Promise<RuntimeTab> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot clear a session while it is streaming");
    }
    const oldHeader = runtimeTab.session?.getHeader();
    // Align with Pi /new: /clear starts a fresh child session without carrying
    // session_info name. Old file keeps its name for resume; new side is unnamed.
    const services = runtimeTab.services;
    const rebuildServices = Boolean(config.rebuildServices);
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
    // Reload extensions now (while tab.sessionId still matches state.activeTabId)
    // so that createRuntimeTabWithFallback doesn't need to reload during the
    // window where tab.sessionId has changed but state.activeTabId hasn't.
    // Skip when rebuilding services — createServices loads a fresh resourceLoader.
    if (!rebuildServices) {
      await services.resourceLoader.reload();
    }
    this.tabs.delete(sessionId);
    resetTabForNewSession(runtimeTab.tab, newSession.getSessionId());
    // Reset UI title so state-store tab_titles cannot re-persist a custom name
    // under the new session id after restart: custom names fall back to the next
    // free generic title. Generic Agent-NN names are kept — the tab's list
    // position must never be used here: after closing/forking/restoring tabs the
    // position diverges from the title, and position-based retitling collides
    // with an existing tab (clearing the 4th tab renamed it "Agent-04" while an
    // Agent-04 tab already existed). this.tabs no longer contains this session,
    // so the kept/next title is always free.
    runtimeTab.tab.title = /^Agent-\d+$/.test(runtimeTab.tab.title)
      ? runtimeTab.tab.title
      : nextAvailableAgentTitle([...this.tabs.values()].map((entry) => entry.tab));
    const cleared = await createRuntimeTabWithFallback(
      runtimeTab.tab,
      newSession,
      {
        ...config,
        // createRuntimeTabWithFallback recomputes the startup header, so a
        // cleared session shows what is loaded again (like Pi's /new).
        // rebuildServices applies a new base systemPrompt via createServices.
        reuseServices: rebuildServices ? undefined : services,
        skipExtensionReload: !rebuildServices,
      },
      this.lifecycleContext(),
    );
    // /clear swaps to a fresh child session file: retrack under the new file.
    this.sync.unregister(sessionId);
    this.sync.register(cleared);
    return cleared;
  }

  getTab(sessionId: string): RuntimeTab | undefined {
    return this.tabs.get(sessionId);
  }

  /**
   * Rebuild the chat projection from the live session branch. Disposes prior
   * render caches first. Used when UI toggles projection flags (e.g. hidden
   * messages) without replacing the session.
   */
  rebuildChatFromSession(sessionId: string): void {
    const runtimeTab = this.requireTab(sessionId);
    disposeChatRenderers(runtimeTab.chat);
    runtimeTab.chat = entriesToChatLines(runtimeTab.session.getBranch(), runtimeTab);
  }

  /**
   * Dispose chat renderers and clear the in-memory projection without touching
   * the underlying session (prepare-clear paints empty chat before clearTab).
   */
  clearTabChatProjection(sessionId: string): void {
    const runtimeTab = this.requireTab(sessionId);
    disposeChatRenderers(runtimeTab.chat);
    runtimeTab.chat = [];
  }

  /**
   * Same session file: move the leaf pointer before any entries (`resetLeaf`).
   * Next append creates a new root; DAG history remains for /tree.
   * Does not change session id, title, or open_tabs identity.
   */
  resetTabToRoot(sessionId: string): { noop: boolean } {
    const runtimeTab = this.requireTab(sessionId);
    if (!runtimeTab.agentSession) {
      throw new Error("Cannot reset a session without a live agent session");
    }
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot reset a session while it is streaming");
    }
    if (runtimeTab.agentSession.isBashRunning) {
      throw new Error("Cannot reset a session while bash is running");
    }
    if (runtimeTab.session.getLeafId() === null) {
      return { noop: true };
    }
    runtimeTab.session.resetLeaf();
    // Match navigateTree / session-reload: agent context follows the new leaf path.
    runtimeTab.agentSession.agent.state.messages = runtimeTab.session.buildSessionContext().messages;
    this.rebuildChatFromSession(sessionId);
    return { noop: false };
  }

  /** True when a session JSONL for this id exists under sessionsRoot. */
  hasSessionOnDisk(sessionId: string): boolean {
    return findSessionFileByName(this.sessionsRoot, sessionId) !== undefined;
  }

  /**
   * Validate a session JSONL import path and return the session id from its
   * header without mutating tabs (open_tabs identity pre-switch for /import).
   */
  previewSessionImport(
    inputPath: string,
    cwdOverride: string | undefined,
    fallbackCwd: string,
  ): Promise<{ resolvedPath: string; sessionId: string }> {
    return inspectSessionImport(inputPath, cwdOverride, fallbackCwd);
  }

  /** Persist thinking-block visibility through Pi's native SettingsManager. */
  async setHideThinkingBlock(hide: boolean): Promise<void> {
    const settingsManager = this.settingsManager;
    if (!settingsManager) throw new Error("Settings manager is not available");
    settingsManager.setHideThinkingBlock(hide);
    await settingsManager.flush();
    const errors = settingsManager.drainErrors();
    if (errors.length > 0) {
      throw new Error(errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "));
    }
  }

  listTabs(): RuntimeTab[] {
    return [...this.tabs.values()].sort((a, b) => a.tab.index - b.tab.index);
  }

  getPromptHistory(sessionId: string): string[] {
    const runtimeTab = this.tabs.get(sessionId);
    if (runtimeTab) {
      const prompts = runtimeTab.session
        .getBranch()
        .flatMap((entry) => promptsFromSessionEntry(entry));
      if (prompts.length > 0) return prompts;
      return runtimeTab.chat.flatMap((line) => {
        if (line.role !== "user") return [];
        const text = line.text.trim();
        return text ? [text] : [];
      });
    }
    const filePrompts = promptsFromSessionFile(findSessionFileByName(this.sessionsRoot, sessionId));
    if (filePrompts.length > 0) return filePrompts;
    return [];
  }

  /**
   * The configured double-Escape action on an empty editor: "tree" (session
   * tree selector), "fork" (user-message fork selector), or "none". Reads Pi's
   * native `doubleEscapeAction` setting; defaults to "tree" when no session
   * settings manager is available (e.g. in tests).
   */
  getDoubleEscapeAction(sessionId: string): "tree" | "fork" | "none" {
    const runtimeTab = this.tabs.get(sessionId);
    return runtimeTab?.agentSession.settingsManager.getDoubleEscapeAction() ?? "tree";
  }

  /**
   * User messages eligible as fork points, newest last. Each entry pairs the
   * session entryId (fork target) with the message text (prefilled into the
   * editor after forking). Empty when the session has no forkable user turns.
   */
  getForkableUserMessages(sessionId: string): Array<{ entryId: string; text: string }> {
    const runtimeTab = this.tabs.get(sessionId);
    return runtimeTab?.agentSession.getUserMessagesForForking() ?? [];
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
    this.tabClosedListeners.clear();
    this.modelsChangedListeners.clear();
    this.pendingExtensionShutdown.clear();
    this.sync.dispose();
  }

  /**
   * Pi-compatible ctx.shutdown() for multi-tab: close this session's tab only.
   * If the tab is streaming/compacting, mark pending and close after idle
   * (waitForIdle / agent_settled), matching Pi's shutdownRequested behavior.
   */
  requestExtensionShutdown(sessionId: string): void {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) return;
    // Always mark pending so idle and deferred paths share flushPending's catch.
    this.pendingExtensionShutdown.add(sessionId);
    if (runtimeTab.agentSession.isStreaming || runtimeTab.agentSession.isCompacting) {
      // Prefer waitForIdle over agent_end: isStreaming is still true at agent_end.
      void runtimeTab.agentSession
        .waitForIdle()
        .then(async () => {
          if (runtimeTab.agentSession.isCompacting) {
            await waitForCompactionIdle(runtimeTab.agentSession);
          }
          this.flushPendingExtensionShutdown(sessionId);
        })
        .catch(() => undefined);
      return;
    }
    this.flushPendingExtensionShutdown(sessionId);
  }

  onTabClosed(listener: (sessionId: string) => void): () => void {
    this.tabClosedListeners.add(listener);
    return () => {
      this.tabClosedListeners.delete(listener);
    };
  }

  /**
   * Fired when the selectable model list may have changed (extension
   * registerProvider/unregisterProvider, or after reloadModelConfig).
   */
  onModelsChanged(listener: (refs: MixCodeModelRef[]) => void): () => void {
    this.modelsChangedListeners.add(listener);
    return () => {
      this.modelsChangedListeners.delete(listener);
    };
  }

  /**
   * Selectable models for the UI picker: registry getAll() minus faux, auth-configured only.
   * Does not re-read models.json (unlike reloadModelConfig).
   */
  collectSelectableModelRefs(): MixCodeModelRef[] {
    if (!this.modelRuntime?.getModels) return [];
    const all = [...this.modelRuntime.getModels()];
    replaceRegisteredModels(all);
    return all
      .filter((model) => model.provider !== "faux")
      .filter((model) => this.modelRuntime?.getProviderAuthStatus?.(model.provider).configured)
      .map(modelToRef);
  }

  private installProviderRegistryUiSync(): void {
    const runtime = this.modelRuntime as
      | (ModelRuntime & {
          registerProvider?: (name: string, config: unknown) => void;
          registerNativeProvider?: (provider: { id: string }) => void;
          unregisterProvider?: (name: string) => void;
          __mixcodeUiSync?: boolean;
        })
      | undefined;
    if (!runtime?.registerProvider || !runtime.unregisterProvider || runtime.__mixcodeUiSync) {
      return;
    }
    const originalRegister = runtime.registerProvider.bind(runtime);
    const originalUnregister = runtime.unregisterProvider.bind(runtime);
    runtime.registerProvider = (name: string, config: unknown) => {
      originalRegister(name, config);
      this.emitModelsChanged();
    };
    // Full Provider registration (pi.registerProvider(providerObject)).
    if (typeof runtime.registerNativeProvider === "function") {
      const originalNative = runtime.registerNativeProvider.bind(runtime);
      runtime.registerNativeProvider = (provider: { id: string }) => {
        originalNative(provider);
        this.emitModelsChanged();
      };
    }
    runtime.unregisterProvider = (name: string) => {
      originalUnregister(name);
      this.emitModelsChanged();
    };
    runtime.__mixcodeUiSync = true;
  }

  private emitModelsChanged(): void {
    if (this.modelsChangedListeners.size === 0) return;
    const refs = this.collectSelectableModelRefs();
    for (const listener of this.modelsChangedListeners) listener(refs);
  }

  private async closeTabFromExtensionShutdown(sessionId: string): Promise<void> {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) {
      this.pendingExtensionShutdown.delete(sessionId);
      return;
    }
    // closeTab rejects while streaming; re-queue if a race re-entered the turn.
    if (runtimeTab.agentSession.isStreaming || runtimeTab.agentSession.isCompacting) {
      this.pendingExtensionShutdown.add(sessionId);
      return;
    }
    this.pendingExtensionShutdown.delete(sessionId);
    try {
      await this.closeTab(sessionId);
    } catch (error) {
      // Re-queue if close raced into a new turn; surface other failures.
      if (this.tabs.has(sessionId)) this.pendingExtensionShutdown.add(sessionId);
      throw error;
    }
    for (const listener of this.tabClosedListeners) listener(sessionId);
  }

  private flushPendingExtensionShutdown(sessionId: string): void {
    if (!this.pendingExtensionShutdown.has(sessionId)) return;
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) {
      this.pendingExtensionShutdown.delete(sessionId);
      return;
    }
    if (runtimeTab.agentSession.isStreaming || runtimeTab.agentSession.isCompacting) return;
    void this.closeTabFromExtensionShutdown(sessionId).catch((error: unknown) => {
      appendSystemMessage(
        runtimeTab,
        `Extension shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
    });
  }

  getExtensionCommands(sessionId: string) {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) return [];
    return runtimeTab
      .agentSession.extensionRunner.getRegisteredCommands()
      .map((command) => {
        // Pi registerCommand spreads options; extensions may set argumentHint even
        // though RegisteredCommand's published type omits it.
        const argumentHint = (command as { argumentHint?: string }).argumentHint;
        return {
          name: command.invocationName,
          description: command.description,
          ...(argumentHint ? { argumentHint } : {}),
          getArgumentCompletions: command.getArgumentCompletions,
          sourceInfo: command.sourceInfo,
        };
      });
  }

  getAllExtensionCommands() {
    const commands = new Map<
      string,
      {
        name: string;
        description?: string;
        argumentHint?: string;
        getArgumentCompletions?: ExtensionArgumentCompleter;
        sourceInfo?: { path: string; source: string };
      }
    >();
    for (const runtimeTab of this.listTabs()) {
      for (const command of this.getExtensionCommands(runtimeTab.tab.sessionId)) {
        commands.set(command.name, {
          name: command.name,
          description: command.description,
          ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
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

  getExtensionManagerEntries(sessionId: string): ExtensionManagerEntry[] {
    const runtimeTab = this.requireTab(sessionId);
    return [...getExtensionManagerEntriesForServices(runtimeTab.services)];
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

  async reloadExtensionManagerTab(sessionId: string): Promise<ExtensionReloadResult> {
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

  async reloadExtensionManagerWorkdir(workdir: string): Promise<ExtensionReloadResult[]> {
    const targets = this.listTabs()
      .filter((runtimeTab) => runtimeTab.tab.workdir === workdir)
      .map((runtimeTab) => runtimeTab.tab.sessionId);
    const results: ExtensionReloadResult[] = [];
    for (const sessionId of targets) {
      results.push(await this.reloadExtensionManagerTab(sessionId));
    }
    return results;
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
    // Skip already-focused overlays: this runs per keypress from the lazy
    // refocus path, so avoid needless focus-order churn and re-renders.
    // pi-tui's handle.focus() itself no-ops for invisible overlays.
    if (!handle || handle.isFocused()) return;
    handle.focus();
  }

  async prompt(
    sessionId: string,
    text: string,
    options?: { streamingBehavior?: "steer" | "followUp" },
  ): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    const trimmed = text.trim();
    if (!trimmed) return;
    const streamingBehavior = options?.streamingBehavior ?? "steer";
    // Registered extension commands may await custom UI for a long time. Skills,
    // templates, and unknown slash input remain agent turns and need dispatchTurn.
    const commandName = trimmed.match(/^\/(\S+)/)?.[1];
    const isIdleExtensionCommand =
      commandName !== undefined &&
      !runtimeTab.agentSession.isStreaming &&
      this.getExtensionCommands(sessionId).some((command) => command.name === commandName);
    if (isIdleExtensionCommand) {
      if (runtimeTab.agentSession.isCompacting) {
        throw new Error("Cannot prompt while compaction is running");
      }
      await runtimeTab.agentSession.prompt(trimmed);
      return;
    }
    await dispatchTurn(runtimeTab, async (signalRegistered) => {
      if (runtimeTab.agentSession.isStreaming) {
        // Already streaming: this instance owns the turn (and its lock); queue
        // as steer (interrupt) or followUp (wait until idle).
        await runtimeTab.agentSession.prompt(trimmed, {
          streamingBehavior,
          preflightResult: signalRegistered,
        });
        return;
      }
      runtimeTab.postRunWorkingStartedAt = undefined;
      // A fresh prompt is a fresh run: drop any stale SDK continuation marker.
      runtimeTab.sdkRunContinuation = false;
      if (runtimeTab.agentSession.isCompacting) {
        throw new Error("Cannot prompt while compaction is running");
      }
      // Claim the cross-process turn lock, then branch off the latest on-disk
      // state so this turn is a child of any messages another instance wrote.
      const lock = this.sync.acquire(sessionId);
      try {
        if (lock) reloadRuntimeSessionFromDisk(runtimeTab);
        await runtimeTab.agentSession.prompt(text, { preflightResult: signalRegistered });
      } finally {
        this.sync.markLocalWrite(sessionId);
        lock?.release();
      }
    });
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
      throw new BashAlreadyRunningError();
    }
    // A standalone (idle) shell run records a bashExecution entry to the
    // session JSONL, so it must take the cross-process turn lock like a prompt.
    // While the agent is streaming, this instance already owns the turn lock
    // and the bash result is queued + flushed inside that turn, so re-acquiring
    // here would self-conflict. Acquire before any tab-state mutation so a
    // conflict throws cleanly, leaving the tab untouched.
    const lock = runtimeTab.agentSession.isStreaming ? undefined : this.sync.acquire(sessionId);
    if (lock) reloadRuntimeSessionFromDisk(runtimeTab);
    // A streaming run owns the tab status/timer; the shell only drives them
    // when the agent is idle (fresh stamp for a standalone shell execution).
    if (!runtimeTab.agentSession.isStreaming) {
      setTabStatus(runtimeTab.tab, "running", { restart: true });
    }
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
      // Close the shell's own timer only when the agent didn't take over the
      // status meanwhile: still not streaming and still in the shell's
      // "running" state (an agent_end during the shell already closed it).
      if (!runtimeTab.agentSession.isStreaming && runtimeTab.tab.status === "running") {
        runtimeTab.tab.status = "idle";
        runtimeTab.tab.unreadDone = true;
        runtimeTab.tab.lastWorkedDurationSeconds = elapsedShellSeconds(
          runtimeTab.tab.workingStartedAt,
          new Date(),
        );
        runtimeTab.tab.lastWorkedAt = new Date().toISOString();
        runtimeTab.tab.workingStartedAt = undefined;
      }
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      upsertUserBashLine(runtimeTab, toolCallId, "error", errorMessage, args, excludeFromContext, {
        exitCode: undefined,
        cancelled: false,
        truncated: false,
        fullOutputPath: undefined,
      });
      // Same ownership rule on the failure path: never flip a streaming run
      // into "error" or discard its timer because a user shell command failed.
      if (!runtimeTab.agentSession.isStreaming && runtimeTab.tab.status === "running") {
        setTabStatus(runtimeTab.tab, "error", { discardTimer: true });
      }
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      throw error;
    } finally {
      // Only meaningful when this call acquired the lock (standalone idle bash).
      if (lock) {
        this.sync.markLocalWrite(sessionId);
        lock.release();
      }
    }
  }

  appendSystemMessage(sessionId: string, text: string, kind?: SystemMessageKind): void {
    const runtimeTab = this.requireTab(sessionId);
    appendSystemMessage(runtimeTab, text, kind);
    this.emitChange({ type: "extension_ui_update" }, runtimeTab);
  }

  abortTab(sessionId: string): boolean {
    const runtimeTab = this.requireTab(sessionId);
    // Pi interactive Esc: streaming → abort agent; else if bash → abortBash().
    if (!runtimeTab.agentSession.isStreaming) {
      if (runtimeTab.agentSession.isBashRunning) {
        runtimeTab.agentSession.abortBash();
        clearPendingEscape(runtimeTab.tab);
        this.emitChange({ type: "extension_ui_update" }, runtimeTab);
        return true;
      }
      // Try aborting retry, branch summarization and compaction (no-op if not running)
      const wasRetrying = runtimeTab.agentSession.isRetrying;
      const hadRetryCountdown = runtimeTab.tab.retryInfo !== undefined;
      runtimeTab.agentSession.abortRetry();
      runtimeTab.agentSession.abortBranchSummary();
      runtimeTab.agentSession.abortCompaction();
      // Agent auto-retry and summarization_retry both arm tab.retryInfo for the
      // working-loader countdown; clear UI state when either path is cancelled.
      if (wasRetrying || hadRetryCountdown) {
        const attempt = runtimeTab.tab.retryInfo?.attempt ?? 0;
        runtimeTab.tab.retryInfo = undefined;
        setTabStatus(runtimeTab.tab, "idle", { discardTimer: false });
        if (wasRetrying) {
          appendSystemMessage(runtimeTab, `Error: Retry failed after ${attempt} attempts: Retry cancelled`);
        }
        this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      }
      return false;
    }
    void runtimeTab.agentSession.abort();
    clearPendingEscape(runtimeTab.tab);
    // Preserve an existing timer (??=) — abort during an active run keeps elapsed.
    setTabStatus(runtimeTab.tab, "running");
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
      runtimeTab.tab.retryInfo = undefined;
      setPendingMessages(runtimeTab.tab, []);
      setPendingFollowUps(runtimeTab.tab, []);
      runtimeTab.queuedPromptCount = 0;
      runtimeTab.queuedFollowUpCount = 0;
      clearPendingEscape(runtimeTab.tab);
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

  /** Whether a custom overlay is hidden but still awaiting its recovery key. */
  hasHiddenExtensionOverlay(sessionId: string): boolean {
    const handles = this.tabs.get(sessionId)?.extensionCustomOverlayHandles;
    return handles ? [...handles].some((handle) => handle.isHidden()) : false;
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

  async flushPendingMessage(sessionId: string, count?: number): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    // The queued-message auto-resend is a fresh turn (the prior turn already
    // released its lock at agent_end), so it re-acquires the cross-process turn
    // lock. On conflict flushRuntimePendingMessage re-queues the text, so the
    // user's input is preserved.
    const lock = this.sync.acquire(sessionId);
    try {
      if (lock) reloadRuntimeSessionFromDisk(runtimeTab);
      await flushRuntimePendingMessage(runtimeTab, count);
    } finally {
      this.sync.markLocalWrite(sessionId);
      lock?.release();
    }
  }

  private schedulePendingMessageFlush(sessionId: string, agentSession: AgentSession): void {
    scheduleRuntimePendingMessageFlush(
      sessionId,
      agentSession,
      (targetSessionId) => this.tabs.get(targetSessionId),
      (targetSessionId, count) => this.flushPendingMessage(targetSessionId, count),
      (targetSessionId, error) => this.reportPendingMessageFlushError(targetSessionId, error),
    );
  }

  // Surface an auto-resend failure on the owning tab instead of letting it
  // bubble into an unhandled rejection. The queued text is already restored by
  // flushRuntimePendingMessage; here we only make the failure visible.
  private reportPendingMessageFlushError(sessionId: string, error: unknown): void {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) return;
    const message = error instanceof Error ? error.message : String(error);
    appendSystemMessage(runtimeTab, `Error: Queued message failed to send: ${message}`);
    this.emitChange({ type: "extension_ui_update" }, runtimeTab);
  }

  popPendingMessage(sessionId: string, kind: QueueKind): string | undefined {
    const runtimeTab = this.requireTab(sessionId);
    return popRuntimePendingMessage(runtimeTab, kind);
  }

  async forkSession(sourceSessionId: string, newSessionId: string): Promise<SessionManager> {
    const source = this.requireTab(sourceSessionId);
    return copySession(source.session, source.tab.workdir, newSessionId, this.sessionsRoot);
  }

  /**
   * List sessions for a specific working directory.
   * Uses the runtime's sessionsRoot as the session directory.
   */
  async listSessions(
    cwd: string,
    signal?: AbortSignal,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<SessionInfo[]> {
    return listSessionsForCwd(cwd, this.sessionsRoot, signal, onProgress);
  }

  /** List all sessions across Pi's current per-workdir session directories. */
  async listAllSessions(
    signal?: AbortSignal,
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<SessionInfo[]> {
    return listAllSessionsGlobal(this.sessionsRoot, signal, onProgress);
  }

  /**
   * Persist a session display name into the session file.
   * Appends a session_info entry so the name survives restarts and shows in /resume.
   */
  renameSession(sessionId: string, name: string): void {
    const runtimeTab = this.requireTab(sessionId);
    runtimeTab.session.appendSessionInfo(name);
    invalidateSessionCatalog(this.sessionsRoot);
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

  /**
   * Retract the in-flight turn (abort + rewind leaf to the last user message)
   * when it produced no visible output. Returns the message text to refill the
   * editor, or undefined when not eligible so the caller aborts normally.
   */
  async retractCurrentTurn(sessionId: string): Promise<{ editorText: string } | undefined> {
    return retractRuntimeTurn(sessionId, this.extensionSessionContext());
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
    try {
      await reloadRuntimeTabWithFreshServices(runtimeTab, this.lifecycleContext());
    } finally {
      // Session reconstruction persists metadata; suppress its watcher echo.
      this.sync.markLocalWrite(sessionId);
    }
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
  async reloadModelConfig(): Promise<MixCodeModelRef[]> {
    if (!this.modelRuntime?.refresh) return [];
    // Reload only the user-owned models.json; provider catalogs are unrelated to /reload.
    await this.modelRuntime.refresh({ allowNetwork: false });
    // Re-install sync after refresh in case the runtime object was replaced
    // (normally the same instance; wrap is idempotent via __mixcodeUiSync).
    this.installProviderRegistryUiSync();
    // Parse/schema failures leave a ModelRuntime error. Do not emit models-changed:
    // the UI listener would rewrite availableModels even though /reload keeps the
    // previous selection and reports failure.
    if (this.modelRuntime.getError?.()) return this.collectSelectableModelRefs();
    const refs = this.collectSelectableModelRefs();
    this.emitModelsChanged();
    return refs;
  }

  getSharedModelRuntime(): ModelRuntime | undefined {
    return this.modelRuntime;
  }

  async closeTab(sessionId: string): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot close a session while the agent is streaming");
    }
    if (runtimeTab.agentSession.isCompacting) {
      throw new Error("Cannot close a session while compaction is running");
    }
    await this.shutdownRuntimeTab(runtimeTab, { type: "session_shutdown", reason: "quit" });
    this.sync.unregister(sessionId);
    this.tabs.delete(sessionId);
    this.pendingExtensionShutdown.delete(sessionId);
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
        this.sync.unregister(entries[index]![0]);
        this.tabs.delete(entries[index]![0]);
        continue;
      }
      for (let remainingIndex = index; remainingIndex < entries.length; remainingIndex++) {
        const [sessionId, runtimeTab] = entries[remainingIndex]!;
        if (!this.tabs.has(sessionId)) continue;
        disposeRuntimeTabAfterShutdown(runtimeTab, this.extensionUiHost);
        this.sync.unregister(sessionId);
        this.tabs.delete(sessionId);
      }
      throw result.reason;
    }
  }

  async deleteTab(sessionId: string): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot delete a session while the agent is streaming");
    }
    if (runtimeTab.agentSession.isCompacting) {
      throw new Error("Cannot delete a session while compaction is running");
    }
    await this.shutdownRuntimeTab(runtimeTab, { type: "session_shutdown", reason: "quit" });
    const file = runtimeTab.session.getSessionFile();
    if (file) {
      await Bun.file(file).unlink().catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
      invalidateSessionCatalog(this.sessionsRoot);
    }
    this.sync.unregister(sessionId);
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
    // Cover the gap before SDK sets isCompacting (await abort() inside compact).
    if (runtimeTab.compactionInFlight || runtimeTab.agentSession.isCompacting) {
      throw new Error("Cannot compact while compaction is running");
    }
    const branch = runtimeTab.session.getBranch();
    if (branch.filter((entry) => entry.type === "message").length < 2) {
      throw new Error("Nothing to compact (no messages yet)");
    }
    if (branch.at(-1)?.type === "compaction") {
      throw new Error("Session is already compacted");
    }
    // Claim before any await so concurrent compactSession calls cannot interleave.
    runtimeTab.compactionInFlight = true;
    if (runtimeTab.agentSession.isCompacting) {
      runtimeTab.compactionInFlight = false;
      throw new Error("Cannot compact while compaction is running");
    }
    runtimeTab.tab.activeCompactionReason = "manual";
    setTabStatus(runtimeTab.tab, "running", { restart: true });
    clearPendingEscape(runtimeTab.tab);
    // Compaction rewrites the branch, so it must hold the cross-process turn
    // lock just like a prompt does — and reload first so the rewrite is a child
    // of any messages another instance already appended.
    let lock: SessionLockHandle | undefined;
    try {
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      lock = this.sync.acquire(sessionId);
      if (lock) reloadRuntimeSessionFromDisk(runtimeTab);
      // compact() emits compaction_end which triggers applyEvent to rebuild chat
      await runtimeTab.agentSession.compact(customInstructions);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
      // SDK 0.80+ refuses sessions with nothing to summarize (everything still
      // fits the keep-recent window). That is a benign no-op, not an error:
      // surface it as a system message, return to idle, and don't propagate.
      if (isNothingToCompactError(message)) {
        runtimeTab.tab.activeCompactionReason = undefined;
        setTabStatus(runtimeTab.tab, "idle", { discardTimer: true });
        appendSystemMessage(runtimeTab, "Nothing to compact (session too small).");
        this.emitChange({ type: "extension_ui_update" }, runtimeTab);
        return;
      }
      runtimeTab.tab.activeCompactionReason = undefined;
      // Drop the timer silently either way; compaction_end did not record a duration.
      // On a real error also flip to "error"; an abort leaves status untouched.
      if (aborted) {
        runtimeTab.tab.workingStartedAt = undefined;
      } else {
        setTabStatus(runtimeTab.tab, "error", { discardTimer: true });
      }
      this.emitChange({ type: "extension_ui_update" }, runtimeTab);
      throw error;
    } finally {
      runtimeTab.tab.activeCompactionReason = undefined;
      runtimeTab.compactionInFlight = false;
      this.sync.markLocalWrite(sessionId);
      lock?.release();
    }
  }

  requireTab(sessionId: string): RuntimeTab {
    const tab = this.tabs.get(sessionId);
    if (!tab) throw new Error(`Unknown tab session: ${sessionId}`);
    return tab;
  }

  resolveModel(provider: string, modelId: string): MixCodeModel {
    return resolveRuntimeModel(provider, modelId, this.modelRuntime ?? this.modelRegistry);
  }

  async updateTabModel(sessionId: string, model: MixCodeModel): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    if (runtimeTab.agentSession.isStreaming) {
      throw new Error("Cannot change model while the agent is streaming");
    }
    try {
      const sessionModel = { ...model };
      // Use agentSession.setModel() to trigger model_select event and persist to session
      await runtimeTab.agentSession.setModel(sessionModel);
      // Sync local state after SDK updates its own state
      runtimeTab.agentSession.agent.state.model = sessionModel;
      applyRuntimeTabModel(runtimeTab, sessionModel);
      // Sync thinking level after Pi clamps it to new model's capability
      runtimeTab.tab.thinkingLevel = runtimeTab.agentSession.thinkingLevel;
    } finally {
      this.sync.markLocalWrite(sessionId);
    }
  }

  updateTabThinkingLevel(sessionId: string, level: ThinkingLevel): ThinkingLevel {
    const runtimeTab = this.requireTab(sessionId);
    runtimeTab.agentSession.setThinkingLevel(level);
    runtimeTab.tab.thinkingLevel = runtimeTab.agentSession.agent.state.thinkingLevel;
    return runtimeTab.tab.thinkingLevel;
  }

  async updateTabWorkdir(
    sessionId: string,
    workdir: string,
    systemPrompt = MIXCODE_SYSTEM_PROMPT,
  ): Promise<void> {
    const runtimeTab = this.requireTab(sessionId);
    await updateRuntimeTabWorkdir(
      runtimeTab,
      workdir,
      systemPrompt,
      this.sessionsRoot,
      this.lifecycleContext(),
      {
        onSessionRebound: (tab) => {
          tab.agentSession.subscribe((event) => {
            // Registered before the shared UI listener so deferred shutdown flushes first.
            if (event.type === "agent_settled" || event.type === "compaction_end") {
              this.flushPendingExtensionShutdown(tab.tab.sessionId);
            }
          });
        },
      },
    );
    // Header rewrite is a local write; suppress the session-file watcher echo.
    this.sync.markLocalWrite(sessionId);
    // Workdir change reopens the session (possibly a new file path): retrack it.
    this.sync.register(runtimeTab);
  }

  private async shutdownRuntimeTab(
    runtimeTab: RuntimeTab,
    event: SessionShutdownEvent,
  ): Promise<void> {
    await shutdownRuntimeTab(runtimeTab, event, this.extensionUiHost);
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
    // Map key by identity: UI may pre-rename tab.sessionId for open_tabs before
    // replace commits (resume race). Sync still tracks the pre-replace file key.
    let previousSessionId = runtimeTab.tab.sessionId;
    for (const [key, value] of this.tabs) {
      if (value === runtimeTab) {
        previousSessionId = key;
        break;
      }
    }
    const replaced = await replaceRuntimeTabSession(
      runtimeTab,
      sessionManager,
      reason,
      this.lifecycleContext(),
    );
    // new/resume/fork swap the tab to a different session id + file: retrack.
    this.sync.unregister(previousSessionId);
    this.sync.register(replaced);
    return replaced;
  }

  private async syncChatFromSession(runtimeTab: RuntimeTab): Promise<void> {
    await syncRuntimeChatFromSession(runtimeTab);
  }

  /**
   * Reload a tab's session from disk to pick up appends made by another
   * mixcode-pi instance sharing this sessionsRoot, then notify listeners so the
   * TUI re-renders. No-op (returns false) while the local agent is streaming or
   * compacting, or when the tab is unknown.
   */
  syncSessionFromDisk(sessionId: string): boolean {
    const runtimeTab = this.tabs.get(sessionId);
    if (!runtimeTab) return false;
    const result = reloadRuntimeSessionFromDisk(runtimeTab);
    if (result.reloaded) this.emitChange({ type: "extension_ui_update" }, runtimeTab);
    return result.reloaded;
  }

  private resolveModelFromSession(
    session: SessionManager,
    fallback: MixCodeTabInfo["model"] | MixCodeModel | undefined,
  ): MixCodeModel {
    return resolveRuntimeModelFromSession(session, fallback, this.modelRuntime ?? this.modelRegistry);
  }

  private setLiveEditorText(text: string): void {
    this.extensionUiHost?.editor?.setText(text);
  }

  private async createServices(
    workdir: string,
    systemPrompt?: string,
  ): Promise<AgentSessionServices> {
    return createRuntimeServices({
      workdir,
      systemPrompt,
      agentDir: this.agentDir,
      modelRuntime: this.modelRuntime,
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
  // Pi keeps streaming-started user bash in the pending area until the agent
  // turn ends; once marked pending, keep it pending across chunk updates.
  const previousPending =
    existing >= 0 ? runtimeTab.chat[existing]?.pendingBash === true : false;
  const pendingBash = previousPending || runtimeTab.agentSession.isStreaming;
  const line: ChatLine = {
    role: "tool",
    title: "bash",
    variant: "user-bash",
    toolCallId,
    status,
    text,
    args,
    excludeFromContext,
    pendingBash: pendingBash || undefined,
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

async function waitForCompactionIdle(
  agentSession: RuntimeTab["agentSession"],
): Promise<void> {
  if (!agentSession.isCompacting) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type !== "compaction_end") return;
      unsubscribe();
      resolve();
    });
    if (!agentSession.isCompacting) {
      unsubscribe();
      resolve();
    }
  });
}
