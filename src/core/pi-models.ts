import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
  AssistantMessageEventStream,
  Context,
  ProviderHeaders,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { getAgentDir, ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { MixCodeModel } from "./types.js";

export interface PiModelSource {
  provider: string;
  modelId: string;
  model: MixCodeModel;
  authStatus: ReturnType<ModelRuntime["getProviderAuthStatus"]>;
}

export interface PiModelRuntimeAuth {
  getApiKey: (provider: string) => Promise<string | undefined>;
  stream: (
    model: MixCodeModel,
    context: Context,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

export interface PiModelRegistryBundle {
  modelRuntime: ModelRuntime;
  /** Extension-facing synchronous facade over modelRuntime. */
  registry: ModelRegistry;
  sources: PiModelSource[];
  runtimeAuth: PiModelRuntimeAuth;
  modelsPath: string;
  loadError?: string;
}

interface DisabledModelRuntimePolicy {
  disabledProviders: Set<string>;
  disabledModels: Set<string>;
}

const disabledModelRuntimePolicies = new WeakMap<ModelRuntime, DisabledModelRuntimePolicy>();

/** Apply MixCode's denylist to extension discovery and every public model execution path. */
export function configureDisabledModelRuntime(
  modelRuntime: ModelRuntime,
  disabledProviders: readonly string[] = [],
  disabledModels: readonly string[] = [],
): void {
  const existing = disabledModelRuntimePolicies.get(modelRuntime);
  if (existing) {
    existing.disabledProviders = new Set(disabledProviders);
    existing.disabledModels = new Set(disabledModels);
    return;
  }

  const policy: DisabledModelRuntimePolicy = {
    disabledProviders: new Set(disabledProviders),
    disabledModels: new Set(disabledModels),
  };
  disabledModelRuntimePolicies.set(modelRuntime, policy);

  const originalGetAvailable = modelRuntime.getAvailable.bind(modelRuntime);
  const originalGetAvailableSnapshot = modelRuntime.getAvailableSnapshot.bind(modelRuntime);
  const originalStream = modelRuntime.stream.bind(modelRuntime) as ModelRuntime["stream"];
  const originalComplete = modelRuntime.complete.bind(modelRuntime) as ModelRuntime["complete"];
  const originalStreamSimple = modelRuntime.streamSimple.bind(
    modelRuntime,
  ) as ModelRuntime["streamSimple"];
  const originalCompleteSimple = modelRuntime.completeSimple.bind(
    modelRuntime,
  ) as ModelRuntime["completeSimple"];

  modelRuntime.getAvailable = (async (providerId?: string) =>
    originalGetAvailable(providerId).then((models) =>
      filterDisabledModels(models, policy),
    )) as ModelRuntime["getAvailable"];
  modelRuntime.getAvailableSnapshot = (() =>
    filterDisabledModels(
      originalGetAvailableSnapshot(),
      policy,
    )) as ModelRuntime["getAvailableSnapshot"];
  modelRuntime.stream = ((...args: Parameters<ModelRuntime["stream"]>) => {
    assertRuntimeModelEnabled(args[0], policy);
    return originalStream(...args);
  }) as ModelRuntime["stream"];
  modelRuntime.complete = ((...args: Parameters<ModelRuntime["complete"]>) => {
    assertRuntimeModelEnabled(args[0], policy);
    return originalComplete(...args);
  }) as ModelRuntime["complete"];
  modelRuntime.streamSimple = ((...args: Parameters<ModelRuntime["streamSimple"]>) => {
    assertRuntimeModelEnabled(args[0], policy);
    return originalStreamSimple(...args);
  }) as ModelRuntime["streamSimple"];
  modelRuntime.completeSimple = ((...args: Parameters<ModelRuntime["completeSimple"]>) => {
    assertRuntimeModelEnabled(args[0], policy);
    return originalCompleteSimple(...args);
  }) as ModelRuntime["completeSimple"];
}

function filterDisabledModels(
  models: readonly MixCodeModel[],
  policy: DisabledModelRuntimePolicy,
): MixCodeModel[] {
  return models.filter((model) => !runtimeModelDisabled(model, policy));
}

function assertRuntimeModelEnabled(model: MixCodeModel, policy: DisabledModelRuntimePolicy): void {
  if (!runtimeModelDisabled(model, policy)) return;
  throw new Error(
    `Model is disabled: ${model.provider}/${model.id}. Enable it in /settings then /reload.`,
  );
}

function runtimeModelDisabled(model: MixCodeModel, policy: DisabledModelRuntimePolicy): boolean {
  return (
    policy.disabledProviders.has(model.provider) ||
    policy.disabledModels.has(`${model.provider}/${model.id}`)
  );
}

/** Expand `~` in optional path values (e.g. session-dir overrides). */
export function resolveAgentDirEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "~") return process.env.HOME || os.homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return path.join(process.env.HOME || os.homedir(), value.slice(2));
  }
  return value;
}

export function defaultPiModelsPath(): string {
  return path.join(getAgentDir(), "models.json");
}

export function defaultPiAuthPath(): string {
  return path.join(getAgentDir(), "auth.json");
}

export async function createPiModelRegistryBundle(
  modelsPath = defaultPiModelsPath(),
  authPath = defaultPiAuthPath(),
  options: { allowModelNetwork?: boolean } = {},
): Promise<PiModelRegistryBundle> {
  await assertPathIsNotDirectory(modelsPath);
  // Network catalog refresh is opt-in; interactive bootstrap enables it explicitly.
  const modelRuntime = await ModelRuntime.create({
    authPath,
    modelsPath,
    allowModelNetwork: options.allowModelNetwork ?? false,
  });
  const registry = new ModelRegistry(modelRuntime);
  const sources = modelRuntime.getModels().map((model) => ({
    provider: model.provider,
    modelId: model.id,
    model,
    authStatus: modelRuntime.getProviderAuthStatus(model.provider),
  }));
  const loadError = modelRuntime.getError();
  if (loadError) throw new Error(loadError);
  return {
    modelRuntime,
    registry,
    sources,
    runtimeAuth: createPiModelRuntimeAuth(modelRuntime, registry),
    modelsPath,
  };
}

export function createPiModelRuntimeAuth(
  modelRuntime: ModelRuntime,
  registry: ModelRegistry = new ModelRegistry(modelRuntime),
): PiModelRuntimeAuth {
  // Use the extension-facing registry facade so stream auth matches
  // getApiKeyAndHeaders semantics (ok without apiKey for no-auth-header models).
  return {
    getApiKey: async (provider) => registry.getApiKeyForProvider(provider),
    stream: async (model, context, options) => {
      const policy = disabledModelRuntimePolicies.get(modelRuntime);
      if (policy) {
        assertRuntimeModelEnabled(model, policy);
      }
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      // Route through ModelRuntime so custom providers registered via
      // modelRuntime.registerProvider (faux, streamFn bridges) are reached the
      // same way pi-coding-agent's own AgentSession streams them.
      return modelRuntime.streamSimple(model, context, {
        ...options,
        // Caller-provided key wins; the resolved credential is the fallback,
        // mirroring ModelRuntime.prepareRequest precedence.
        apiKey: options?.apiKey ?? auth.apiKey,
        headers: mergeHeaders(options?.headers, auth.headers),
        // Provider-scoped credentials (e.g. Bedrock profiles) travel in env.
        env: auth.env ?? options?.env,
      });
    },
  };
}

async function assertPathIsNotDirectory(filePath: string): Promise<void> {
  try {
    if ((await fs.stat(filePath)).isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${filePath}'`), {
        code: "EISDIR",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function mergeHeaders(
  base: ProviderHeaders | undefined,
  extra: ProviderHeaders | undefined,
): ProviderHeaders | undefined {
  const merged = {
    ...(extra
      ? Object.fromEntries(Object.entries(extra).filter((entry) => entry[1] !== null))
      : undefined),
    ...base,
  };
  return Object.keys(merged).length ? merged : undefined;
}
