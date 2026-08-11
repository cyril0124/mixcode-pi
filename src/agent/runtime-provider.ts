import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type {
  ExtensionFactory,
  InlineExtension,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { MixCodeModel } from "../core/types.js";
import { mixcodeFauxStream } from "./faux-stream.js";
import type { MixCodeStreamFn, SystemPromptOverride } from "./runtime-types.js";

const EXTRA_RETRYABLE_RUNTIME_ERROR_PATTERN = /upstream.?error|upstream request failed/i;
const PI_RETRYABLE_PROVIDER_ERROR_PATTERN = /provider.?returned.?error/i;

export function normalizeRuntimeProviderErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (
    PI_RETRYABLE_PROVIDER_ERROR_PATTERN.test(message) ||
    !EXTRA_RETRYABLE_RUNTIME_ERROR_PATTERN.test(message)
  ) {
    return message;
  }
  return `Provider returned error: ${message}`;
}

/** Map proxy-specific transient errors into Pi's public retry classifier vocabulary. */
export const runtimeRetryNormalizationExtension = {
  name: "mixcode-retry-normalization",
  hidden: true,
  factory: ((pi) => {
    pi.on("message_end", (event) => {
      if (event.message.role !== "assistant" || event.message.stopReason !== "error") return;
      const errorMessage = normalizeRuntimeProviderErrorMessage(event.message.errorMessage ?? "");
      if (errorMessage === event.message.errorMessage) return;
      return { message: { ...event.message, errorMessage } };
    });
  }) satisfies ExtensionFactory,
} satisfies InlineExtension;

export async function registerMixCodeRuntimeProvider(
  modelRuntime: ModelRuntime,
  model: MixCodeModel,
  streamFn?: MixCodeStreamFn,
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,
): Promise<void> {
  const registeredModel = modelRuntime.getModel(model.provider, model.id);
  if (model.provider === "faux") {
    const fauxStreamSimple = mixcodeFauxStream;
    modelRuntime.registerProvider(model.provider, {
      name: "MixCode Faux",
      baseUrl: model.baseUrl,
      apiKey: "mixcode-faux",
      api: model.api,
      streamSimple: fauxStreamSimple,
      models: [providerModelConfig(model)],
    });
    return;
  }
  if (registeredModel || !streamFn) return;
  // Defer streamFn so a synchronous throw becomes a rejection handled by bridgeRuntimeStream.
  const runtimeStreamSimple = (
    requestModel: MixCodeModel,
    context: Context,
    options?: SimpleStreamOptions,
  ) =>
    bridgeRuntimeStream(
      requestModel,
      Promise.resolve().then(() => streamFn(requestModel, context, options)),
    );
  modelRuntime.registerProvider(model.provider, {
    name: model.provider,
    baseUrl: model.baseUrl,
    apiKey: await resolveRuntimeApiKey(model.provider, getApiKey),
    api: model.api,
    streamSimple: runtimeStreamSimple,
    models: [providerModelConfig(model)],
  });
}

function bridgeRuntimeStream(
  model: MixCodeModel,
  // Promise.resolve flattens nested thenables from deferred streamFn invocation.
  streamOrPromise: ReturnType<MixCodeStreamFn> | Promise<ReturnType<MixCodeStreamFn>>,
) {
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

async function resolveRuntimeApiKey(
  provider: string,
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined,
): Promise<string> {
  if (!getApiKey) return "mixcode-runtime";
  const key = await getApiKey(provider);
  if (typeof key === "string" && key.length > 0) return key;
  return "mixcode-runtime";
}

function providerModelConfig(model: MixCodeModel) {
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
  baseOverride: SystemPromptOverride | string | undefined,
  fallbackPrompt?: string,
) {
  return (base: string | undefined) => {
    const overridden =
      typeof baseOverride === "function"
        ? baseOverride(base)
        : typeof baseOverride === "string"
          ? baseOverride
          : base;
    return overridden ?? fallbackPrompt;
  };
}
