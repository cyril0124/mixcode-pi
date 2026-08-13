import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  CreateAgentSessionServicesOptions,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  DefaultPackageManager,
  ensureTool,
  getAgentDir,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime } from "../agent/runtime.js";
import { scanSkillEntries } from "../core/attachments.js";
import { createInitialState, createSessionId, createTab, DEFAULT_MODEL_REF } from "../core/defaults.js";
import {
  extensionManagerFile,
  loadExtensionManagerConfig,
  saveExtensionManagerConfig,
} from "../core/extension-manager.js";
import {
  buildConversationHistoryPromptForRoot,
  conversationHistoryPaths,
  ensureConversationHistoryState,
} from "../core/conversation-history.js";
import { loadMixCodeSettings } from "../core/mixcode-settings.js";
import { setTheme } from "../ui/themes.js";
import {
  applyDisabledModelFlags,
  buildAvailableModelRefs,
  isModelRefAvailable,
  modelRefId,
  modelToRef,
  normalizeModelRef,
  registerModels,
  setStateModel,
  setTabModel,
} from "../core/models.js";
import {
  configureDisabledModelRuntime,
  createPiModelRegistryBundle,
  resolveAgentDirEnv,
} from "../core/pi-models.js";
import {
  loadStateFile,
  saveStateFile,
  scopedStateDir,
  stateFileForPort,
} from "../core/state-store.js";
import { MIXCODE_SYSTEM_PROMPT, setGlobalConversationHistoryPrompt } from "../core/system-prompt.js";
import type { MixCodeModelRef, MixCodeState } from "../core/types.js";
import type { MixCodeCompletionSources } from "../ui/completion.js";
import { applyHttpProxySettings, configureHttpDispatcher } from "@earendil-works/pi-coding-agent";

export interface BootstrapOptions {
  workdir: string;
  stateDir?: string;
  homeDir?: string;
  port?: number;
  modelConfigPath?: string;
  agentDir?: string;
  extensionFactories?: ExtensionFactory[];
  additionalExtensionPaths?: string[];
  resourceLoaderOptions?: CreateAgentSessionServicesOptions["resourceLoaderOptions"];
}

export const DEFAULT_STATE_PORT = 0;

export function defaultStateDir(): string {
  return path.join(getAgentDir(), "mixcode-pi");
}

export function defaultPiSessionDir(workdir: string, agentDir = getAgentDir()): string {
  const resolved = path.resolve(workdir);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(path.resolve(agentDir), "sessions", safePath);
}

/** Resolve the session root using Pi's current precedence. */
export function resolveSessionsRoot(input: {
  workdir: string;
  agentDir: string;
  envSessionDir?: string;
  settingsSessionDir?: string;
}): string {
  return (
    resolveAgentDirEnv(input.envSessionDir) ??
    input.settingsSessionDir ??
    defaultPiSessionDir(input.workdir, input.agentDir)
  );
}

export async function bootstrapMixCode(options: BootstrapOptions): Promise<{
  state: MixCodeState;
  runtime: MixCodeRuntime;
  stateFile: string;
  workspaceFile: string;
  rootStateDir: string;
  completionSources: MixCodeCompletionSources;
  packageUpdateCheck: () => Promise<string[]>;
  /** Resolves when all runtime tabs are fully initialized (extensions loaded). */
  tabsReady: Promise<void>;
  /**
   * Resolves when conversation history backfill and session-index rebuild
   * finish. This scans every persisted session file, so it runs in the
   * background after the TUI renders instead of blocking the first frame.
   */
  historyReady: Promise<{ warnings: string[] }>;
  settingsDeps: {
    settingsManager: SettingsManager;
    mixcodeFile: string;
    piSettingsFile: string;
  };
}> {
  const rootStateDir = options.stateDir ?? defaultStateDir();
  const stateDir = scopedStateDir(rootStateDir, options.workdir);
  const agentDir = options.agentDir ?? getAgentDir();
  // Create SettingsManager early so its sessionDir/httpProxy settings can be
  // read before we resolve the session root or issue any network request.
  const settingsManager = SettingsManager.create(options.workdir, agentDir, { projectTrusted: true });
  const sessionsRoot = resolveSessionsRoot({
    workdir: options.workdir,
    agentDir,
    envSessionDir: process.env.PI_CODING_AGENT_SESSION_DIR,
    settingsSessionDir: settingsManager.getSessionDir(),
  });
  const port = options.port ?? DEFAULT_STATE_PORT;
  await fs.mkdir(rootStateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(rootStateDir, 0o700);
  await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
  await fs.chmod(stateDir, 0o700);

  const stateFile = stateFileForPort(stateDir, port);
  const workspaceFile = path.join(stateDir, "workspaces.json");
  const mixCodeSettings = await loadMixCodeSettings(conversationHistoryPaths(rootStateDir).settingsFile);
  let state: MixCodeState;
  let restoredFromDisk = true;
  try {
    state = await loadStateFile(stateFile, options.workdir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    // Read defaultThinkingLevel from settings when creating initial state
    const defaultThinkingLevel = settingsManager.getDefaultThinkingLevel();
    state = createInitialState(options.workdir, defaultThinkingLevel);
    restoredFromDisk = false;
  }
  state.ui = mixCodeSettings.ui;
  for (const tab of state.tabs) tab.inlineWidgets = state.ui.inlineWidgets === true;
  // Validate and apply the effective theme at the UI composition boundary.
  setTheme(state, mixCodeSettings.theme ?? state.theme);
  // Thinking-block visibility follows Pi's native hideThinkingBlock setting
  // (global/project scoped) rather than MixCode's own persisted state.
  state.hideThinkingBlock = settingsManager.getHideThinkingBlock();
  // Image / mermaid rendering follow Pi SettingsManager (settings.json).
  state.showImages = settingsManager.getShowImages();
  state.imageWidthCells = settingsManager.getImageWidthCells();
  state.mermaidRenderingMode = settingsManager.getMermaidRenderingMode();
  // Derive auth/models from the effective agent dir (PI_CODING_AGENT_DIR or default).
  const modelBundle = await createPiModelRegistryBundle(
    options.modelConfigPath ?? path.join(agentDir, "models.json"),
    path.join(agentDir, "auth.json"),
    { allowModelNetwork: true },
  );
  configureDisabledModelRuntime(
    modelBundle.modelRuntime,
    mixCodeSettings.disabledProviders,
    mixCodeSettings.disabledModels,
  );
  registerModels(modelBundle.sources.map((source) => source.model));
  const configuredModels = modelBundle.sources
    .filter((source) => source.authStatus.configured)
    .map((source) => modelToRef(source.model));
  state.disabledProviders = mixCodeSettings.disabledProviders;
  state.disabledModels = mixCodeSettings.disabledModels;
  state.availableModels = applyDisabledModelFlags(
    buildAvailableModelRefs(configuredModels),
    state.disabledProviders,
    state.disabledModels,
  );

  // Respect settings.json defaultProvider/defaultModel if set
  const defaultProvider = settingsManager.getDefaultProvider();
  const defaultModel = settingsManager.getDefaultModel();
  let preferredModel: MixCodeModelRef;
  if (defaultProvider && defaultModel) {
    const settingsModelRef: MixCodeModelRef = {
      provider: defaultProvider,
      modelId: defaultModel,
      displayName: `${defaultProvider}/${defaultModel}`,
      contextWindow: 200000, // will be corrected by normalizeModelRef if available
    };
    preferredModel = isModelRefAvailable(state.availableModels, settingsModelRef)
      ? normalizeModelRef(state.availableModels, settingsModelRef)
      : applyDisabledModelFlags(
          [configuredModels.at(-1) ?? { ...DEFAULT_MODEL_REF }],
          state.disabledProviders,
          state.disabledModels,
        )[0]!;
  } else {
    preferredModel = applyDisabledModelFlags(
      [configuredModels.at(-1) ?? { ...DEFAULT_MODEL_REF }],
      state.disabledProviders,
      state.disabledModels,
    )[0]!;
  }

  const savedStateModelAvailable = isModelRefAvailable(state.availableModels, state.model);
  if (!restoredFromDisk || !savedStateModelAvailable) {
    setStateModel(state, preferredModel);
  } else {
    setStateModel(state, normalizeModelRef(state.availableModels, state.model));
  }
  if (state.tabs.length === 0) {
    const firstTab = createTab(1, createSessionId(), options.workdir, {
      model: { ...state.model },
      contextLimit: state.model.contextWindow,
      thinkingLevel: state.thinkingLevel,
      inlineWidgets: state.ui.inlineWidgets === true,
    });
    state.tabs.push(firstTab);
  }
  state.activeTabId = "config";
  const modelRepairs = repairUnavailableTabModels(state);
  // The history recall prompt is a static path string (no file scanning), so
  // it is set synchronously to ensure every session's system prompt includes
  // it. The actual backfill/index rebuild below is deferred to the background.
  setGlobalConversationHistoryPrompt(buildConversationHistoryPromptForRoot(rootStateDir));
  const historyReady = ensureConversationHistoryState({
    rootStateDir,
    activeSessionsRoot: sessionsRoot,
  });
  const runtime = new MixCodeRuntime({
    sessionsRoot,
    agentDir,
    modelRuntime: modelBundle.modelRuntime,
    modelRegistry: modelBundle.registry,
    settingsManager,
    extensionFactories: options.extensionFactories,
    additionalExtensionPaths: options.additionalExtensionPaths,
    resourceLoaderOptions: options.resourceLoaderOptions,
    extensionManagerStore: {
      load: () => loadExtensionManagerConfig(extensionManagerFile(stateDir)),
      save: (config) => saveExtensionManagerConfig(extensionManagerFile(stateDir), config),
    },
    getApiKey: modelBundle.runtimeAuth.getApiKey,
    streamFn: modelBundle.runtimeAuth.stream,
  });

  // Apply HTTP proxy settings from SettingsManager after runtime is created but before any network requests
  applyHttpProxySettings(settingsManager.getGlobalSettings().httpProxy);
  configureHttpDispatcher(settingsManager.getHttpIdleTimeoutMs());
  const fdPath = await ensureTool("fd");

  await runtime.loadExtensionManagerConfig();
  const completionSources = {
    skills: await scanSkillEntries(state.workdir, options.homeDir),
    ...(fdPath ? { fdPath } : {}),
  };
  await saveStateFile(stateFile, state);
  // Defer tab creation: return immediately so the TUI can render the initial
  // frame with persisted previewMessages. Extensions load in the background.
  for (const tab of state.tabs) tab.status = "Not Ready";
  const tabsReady = Promise.all(
    state.tabs.map(async (tab) => {
      const runtimeTab = await runtime.createTab(tab, {
        systemPrompt: MIXCODE_SYSTEM_PROMPT,
        thinkingLevel: tab.thinkingLevel,
        workdir: tab.workdir,
      });
      // session_start extensions may already have kicked off a turn while the
      // tab was loading. Do not overwrite their running/thinking state.
      if (!runtimeTab.agentSession.isStreaming) tab.status = "idle";
      const sessionName = runtimeTab.session.getSessionName();
      if (sessionName) tab.title = sessionName;
      const repair = modelRepairs.get(tab.sessionId);
      if (repair) {
        runtime.appendSystemMessage(
          tab.sessionId,
          `Saved model ${repair.from} is unavailable in Pi models; switched to ${repair.to}.`,
        );
      }
    }),
  ) as unknown as Promise<void>;
  return {
    state,
    runtime,
    stateFile,
    workspaceFile,
    rootStateDir,
    completionSources,
    packageUpdateCheck: () => checkPiPackageUpdates({ workdir: state.workdir, agentDir }),
    tabsReady,
    historyReady,
    settingsDeps: {
      settingsManager,
      mixcodeFile: conversationHistoryPaths(rootStateDir).settingsFile,
      piSettingsFile: path.join(agentDir, "settings.json"),
    },
  };
}

function repairUnavailableTabModels(
  state: MixCodeState,
): Map<string, { from: string; to: string }> {
  const repairs = new Map<string, { from: string; to: string }>();
  for (const tab of state.tabs) {
    if (isModelRefAvailable(state.availableModels, tab.model)) {
      setTabModel(tab, normalizeModelRef(state.availableModels, tab.model));
      continue;
    }
    const from = modelRefId(tab.model);
    setTabModel(tab, state.model);
    repairs.set(tab.sessionId, { from, to: modelRefId(state.model) });
  }
  return repairs;
}

export interface PackageUpdateCheckOptions {
  workdir: string;
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
}

export async function checkPiPackageUpdates(options: PackageUpdateCheckOptions): Promise<string[]> {
  if (options.env?.PI_OFFLINE ?? process.env.PI_OFFLINE) return [];
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(options.workdir, agentDir);
  const packageManager = new DefaultPackageManager({
    cwd: options.workdir,
    agentDir,
    settingsManager,
  });
  const updates = await packageManager.checkForAvailableUpdates();
  return updates.map((update) => update.displayName);
}
