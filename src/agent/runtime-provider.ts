import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Model,
  registerApiProvider,
  getApiProvider,
} from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { mixcodeFauxStream } from "./faux-stream.js";
import type { MixCodeStreamFn, SystemPromptOverride } from "./runtime-types.js";

export function registerMixCodeRuntimeProvider(
  registry: ModelRegistry,
  model: Model<any>,
  streamFn?: MixCodeStreamFn,
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,
): void {
  const registeredModel = registry.find(model.provider, model.id);
  if (model.provider === "faux") {
    const fauxStreamSimple = mixcodeFauxStream;
    registry.registerProvider(model.provider, {
      name: "MixCode Faux",
      baseUrl: model.baseUrl,
      apiKey: "mixcode-faux",
      api: model.api,
      streamSimple: fauxStreamSimple,
      models: [providerModelConfig(model)],
    });
    ensureApiRegistered(model.api, fauxStreamSimple);
    return;
  }
  if (registeredModel || !streamFn) return;
  const runtimeStreamSimple = (requestModel: Model<any>, context: any, options: any = {}) =>
    bridgeRuntimeStream(requestModel, streamFn(requestModel, context, options));
  registry.registerProvider(model.provider, {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey: asyncRuntimeApiKeyResolver(model.provider, getApiKey),
    api: model.api,
    streamSimple: runtimeStreamSimple,
    models: [providerModelConfig(model)],
  });
  ensureApiRegistered(model.api, runtimeStreamSimple);
}

// Register a custom api in the global pi-ai api-registry if not already present.
// This is required since v0.75 where streamSimple resolves providers from the global registry.
function ensureApiRegistered(api: string, streamSimple: (...args: any[]) => any): void {
  if (getApiProvider(api)) return;
  registerApiProvider({
    api,
    stream: streamSimple,
    streamSimple,
  });
}

function bridgeRuntimeStream(model: Model<any>, streamOrPromise: ReturnType<MixCodeStreamFn>) {
  const out = createAssistantMessageEventStream();
  void Promise.resolve(streamOrPromise)
    .then(async (stream) => {
      for await (const event of stream) {
        out.push(event);
      }
      out.end(await stream.result());
    })
    .catch((error: unknown) => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
      };
      out.push({ type: "error", reason: "error", error: message });
      out.end(message);
    });
  return out;
}

function asyncRuntimeApiKeyResolver(
  provider: string,
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,
): string {
  if (!getApiKey) return "mixcode-runtime";
  const key = getApiKey(provider);
  if (typeof key === "string" && key.length > 0) return key;
  return "mixcode-runtime";
}

function providerModelConfig(model: Model<any>) {
  return {
    id: model.id,
    name: model.name || model.id,
    api: model.api,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    headers: model.headers,
    compat: model.compat,
  };
}

export function buildMixCodeSystemPromptOverride(
  baseOverride: SystemPromptOverride,
  fallbackPrompt?: string,
) {
  return (base: string | undefined) => {
    const overridden = typeof baseOverride === "function" ? baseOverride(base) : base;
    return overridden ?? fallbackPrompt;
  };
}
