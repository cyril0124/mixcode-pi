import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CreateAgentSessionServicesOptions,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime } from "../agent/runtime.js";
import { scanSkillEntries } from "../core/attachments.js";
import { createInitialState, createTab, DEFAULT_MODEL_REF } from "../core/defaults.js";
import {
  extensionManagerFile,
  loadExtensionManagerConfig,
  saveExtensionManagerConfig,
} from "../core/extension-manager.js";
import { scanProjectFiles } from "../core/file-picker.js";
import {
  modelRefId,
  modelToRef,
  registerModels,
  setStateModel,
  setTabModel,
} from "../core/models.js";
import { checkPiPackageUpdates } from "../core/package-updates.js";
import { createPiModelRegistryBundle } from "../core/pi-models.js";
import {
  loadStateFile,
  saveStateFile,
  scopedStateDir,
  stateFileForPort,
} from "../core/state-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
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

export function defaultStateDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "mixcode-pi");
}

export async function bootstrapMixCode(options: BootstrapOptions): Promise<{
  state: MixCodeState;
  runtime: MixCodeRuntime;
  stateFile: string;
  workspaceFile: string;
  completionSources: MixCodeCompletionSources;
  packageUpdateCheck: () => Promise<string[]>;
}> {
  const rootStateDir = options.stateDir ?? defaultStateDir();
  const stateDir = scopedStateDir(rootStateDir, options.workdir);
  const port = options.port ?? DEFAULT_STATE_PORT;
  await mkdir(stateDir, { recursive: true });
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
  state.availableModels = [{ ...DEFAULT_MODEL_REF }];
  for (const model of configuredModels)
    state.availableModels = upsertBootstrapModelRef(state.availableModels, model);
  const preferredModel = configuredModels.at(-1) ?? DEFAULT_MODEL_REF;
  const savedStateModelAvailable = isBootstrapModelAvailable(state, state.model);
  if (!restoredFromDisk || !savedStateModelAvailable) {
    setStateModel(state, preferredModel);
  } else {
    setStateModel(state, normalizedBootstrapModelRef(state, state.model));
  }
  if (state.tabs.length === 0) {
    const firstTab = createTab(1, `session-${Date.now()}`, options.workdir, {
      model: { ...state.model },
      contextLimit: state.model.contextWindow,
      thinkingLevel: state.thinkingLevel,
    });
    state.tabs.push(firstTab);
  }
  state.activeTabId = "config";
  const modelRepairs = repairUnavailableTabModels(state);
  const runtime = new MixCodeRuntime({
    sessionsRoot: join(stateDir, "sessions"),
    rootStateDir,
    agentDir: options.agentDir,
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
  for (const tab of state.tabs) {
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: MIXCODE_SYSTEM_PROMPT,
      thinkingLevel: tab.thinkingLevel,
      workdir: tab.workdir,
    });
    // Sync tab title from session file name (persisted via /rename or Ctrl+R)
    const sessionName = runtimeTab.session.getSessionName();
    if (sessionName) tab.title = sessionName;
    const repair = modelRepairs.get(tab.sessionId);
    if (repair) {
      runtimeTab.chat.push({
        role: "system",
        text: `Saved model ${repair.from} is unavailable in Pi models; switched to ${repair.to}.`,
      });
    }
  }
  const completionSources = {
    skills: await scanSkillEntries(state.workdir, options.homeDir),
    files: await scanProjectFiles(state.workdir),
  };
  await saveStateFile(stateFile, state, port);
  return {
    state,
    runtime,
    stateFile,
    workspaceFile,
    completionSources,
    packageUpdateCheck: () =>
      checkPiPackageUpdates({ workdir: state.workdir, agentDir: options.agentDir }),
  };
}

function repairUnavailableTabModels(
  state: MixCodeState,
): Map<string, { from: string; to: string }> {
  const repairs = new Map<string, { from: string; to: string }>();
  for (const tab of state.tabs) {
    if (isBootstrapModelAvailable(state, tab.model)) {
      setTabModel(tab, normalizedBootstrapModelRef(state, tab.model));
      continue;
    }
    const from = modelRefId(tab.model);
    setTabModel(tab, state.model);
    repairs.set(tab.sessionId, { from, to: modelRefId(state.model) });
  }
  return repairs;
}

function isBootstrapModelAvailable(state: MixCodeState, model: MixCodeState["model"]): boolean {
  return state.availableModels.some(
    (item) => item.provider === model.provider && item.modelId === model.modelId,
  );
}

function normalizedBootstrapModelRef(
  state: MixCodeState,
  model: MixCodeState["model"],
): MixCodeState["model"] {
  return (
    state.availableModels.find(
      (item) => item.provider === model.provider && item.modelId === model.modelId,
    ) ?? model
  );
}

function upsertBootstrapModelRef(
  models: MixCodeState["availableModels"],
  model: MixCodeState["model"],
): MixCodeState["availableModels"] {
  return [
    ...models.filter((item) => item.provider !== model.provider || item.modelId !== model.modelId),
    model,
  ];
}
