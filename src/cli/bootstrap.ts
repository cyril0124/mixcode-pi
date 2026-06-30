import { chmod, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type {
  CreateAgentSessionServicesOptions,
  ExtensionFactory,
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
  ensureConversationHistoryState,
} from "../core/conversation-history.js";
import { scanProjectFiles } from "../core/file-picker.js";
import {
  buildAvailableModelRefs,
  isModelRefAvailable,
  modelRefId,
  modelToRef,
  normalizeModelRef,
  registerModels,
  setStateModel,
  setTabModel,
} from "../core/models.js";
import { checkPiPackageUpdates } from "../core/package-updates.js";
import {
  createPiModelRegistryBundle,
  defaultPiAgentDir,
  resolveAgentDirEnv,
} from "../core/pi-models.js";
import {
  loadStateFile,
  saveStateFile,
  scopedStateDir,
  stateFileForPort,
} from "../core/state-store.js";
import { MIXCODE_SYSTEM_PROMPT, setGlobalConversationHistoryPrompt } from "../core/system-prompt.js";
import type { MixCodeState } from "../core/types.js";
import type { MixCodeCompletionSources } from "../ui/completion.js";

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

export function defaultMixCodeAgentDir(): string {
  return resolveAgentDirEnv(process.env.MIXCODE_CODING_AGENT_DIR) ?? defaultPiAgentDir();
}

export function defaultStateDir(): string {
  return join(defaultMixCodeAgentDir(), "mixcode-pi");
}

export function defaultPiSessionDir(workdir: string, agentDir = defaultMixCodeAgentDir()): string {
  const resolved = resolve(workdir);
  const safePath = `--${resolved.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(resolve(agentDir), "sessions", safePath);
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
}> {
  const rootStateDir = options.stateDir ?? defaultStateDir();
  const stateDir = scopedStateDir(rootStateDir, options.workdir);
  const agentDir = options.agentDir ?? defaultMixCodeAgentDir();
  const sessionsRoot = options.stateDir
    ? join(stateDir, "sessions")
    : defaultPiSessionDir(options.workdir, agentDir);
  const port = options.port ?? DEFAULT_STATE_PORT;
  await mkdir(rootStateDir, { recursive: true, mode: 0o700 });
  await chmod(rootStateDir, 0o700);
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await chmod(stateDir, 0o700);
  const stateFile = stateFileForPort(stateDir, port);
  const workspaceFile = join(stateDir, "workspaces.json");
  let state: MixCodeState;
  let restoredFromDisk = true;
  try {
    state = await loadStateFile(stateFile, options.workdir);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") throw error;
    state = createInitialState(options.workdir);
    restoredFromDisk = false;
  }
  const modelBundle = await createPiModelRegistryBundle(options.modelConfigPath);
  registerModels(modelBundle.sources.map((source) => source.model));
  const configuredModels = modelBundle.sources
    .filter((source) => source.authStatus.configured)
    .map((source) => modelToRef(source.model));
  state.availableModels = buildAvailableModelRefs(configuredModels);
  const preferredModel = configuredModels.at(-1) ?? DEFAULT_MODEL_REF;
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
    rootStateDir,
    agentDir,
    authStorage: modelBundle.authStorage,
    modelRegistry: modelBundle.registry,
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
  await runtime.loadExtensionManagerConfig();
  const completionSources = {
    skills: await scanSkillEntries(state.workdir, options.homeDir),
    files: await scanProjectFiles(state.workdir),
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
      tab.status = "idle";
      const sessionName = runtimeTab.session.getSessionName();
      if (sessionName) tab.title = sessionName;
      const repair = modelRepairs.get(tab.sessionId);
      if (repair) {
        runtimeTab.chat.push({
          role: "system",
          text: `Saved model ${repair.from} is unavailable in Pi models; switched to ${repair.to}.`,
        });
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
