import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai";
import { AuthStorage, ModelRegistry } from "@earendil-works/pi-coding-agent";

export interface PiModelSource {
  provider: string;
  modelId: string;
  model: Model<any>;
  authStatus: ReturnType<ModelRegistry["getProviderAuthStatus"]>;
}

export interface PiModelRuntimeAuth {
  getApiKey: (provider: string) => Promise<string | undefined>;
  stream: (
    model: Model<any>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => ReturnType<typeof streamSimple> | Promise<ReturnType<typeof streamSimple>>;
}

export interface PiModelRegistryBundle {
  authStorage: AuthStorage;
  registry: ModelRegistry;
  sources: PiModelSource[];
  runtimeAuth: PiModelRuntimeAuth;
  modelsPath: string;
  loadError?: string;
}

export function resolveAgentDirEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value === "~") return homedir();
  if (value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\"))) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

export function defaultPiAgentDir(): string {
  return resolveAgentDirEnv(process.env.PI_CODING_AGENT_DIR) ?? join(homedir(), ".pi", "agent");
}

export function defaultPiModelsPath(): string {
  return join(defaultPiAgentDir(), "models.json");
}

export function defaultPiAuthPath(): string {
  return join(defaultPiAgentDir(), "auth.json");
}

export async function createPiModelRegistryBundle(
  modelsPath = defaultPiModelsPath(),
  authPath = defaultPiAuthPath(),
): Promise<PiModelRegistryBundle> {
  await assertPathIsNotDirectory(modelsPath);
  const authStorage = AuthStorage.create(authPath);
  const registry = ModelRegistry.create(authStorage, modelsPath);
  const sources = registry.getAll().map((model) => ({
    provider: model.provider,
    modelId: model.id,
    model,
    authStatus: registry.getProviderAuthStatus(model.provider),
  }));
  const loadError = registry.getError();
  if (loadError) throw new Error(loadError);
  return {
    authStorage,
    registry,
    sources,
    runtimeAuth: createPiModelRuntimeAuth(registry),
    modelsPath,
  };
}

export async function loadPiModelSources(
  modelsPath = defaultPiModelsPath(),
): Promise<PiModelSource[]> {
  return (await createPiModelRegistryBundle(modelsPath)).sources;
}

export function createPiModelRuntimeAuth(registry: ModelRegistry): PiModelRuntimeAuth {
  return {
    getApiKey: async (provider) => registry.getApiKeyForProvider(provider),
    stream: async (model, context, options) => {
      const auth = await registry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      return streamSimple(model, context, {
        ...options,
        apiKey: auth.apiKey ?? options?.apiKey,
        headers: mergeHeaders(options?.headers, auth.headers),
      });
    },
  };
}

async function assertPathIsNotDirectory(path: string): Promise<void> {
  try {
    if ((await stat(path)).isDirectory()) {
      throw Object.assign(new Error(`EISDIR: illegal operation on a directory, read '${path}'`), {
        code: "EISDIR",
      });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function mergeHeaders(
  base: Record<string, string> | undefined,
  extra: Record<string, string> | undefined,
): Record<string, string> | undefined {
  const merged = { ...extra, ...base };
  return Object.keys(merged).length ? merged : undefined;
}
