import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type Provider,
  type SimpleStreamOptions,
  type StreamOptions,
} from "@earendil-works/pi-ai";
import {
  ProviderWatchdog,
  type ProviderCooldownStore,
  type ProviderWatchdogState,
} from "./provider-watchdog.js";

const WATCHDOG_WRAPPED = Symbol.for("mixcode.mpi-stuck-guard.provider-watchdog");
type WatchdogProvider = Provider & { readonly [WATCHDOG_WRAPPED]?: true };

export interface ProviderWrapperOptions {
  enabled: boolean;
  streamStartTimeoutMs: number;
  streamIdleTimeoutMs: number;
  streamRetryStartTimeoutMs: number;
  knownTimeoutCooldownMs: number;
  cooldowns: ProviderCooldownStore;
  onStateChange?: (providerId: string, modelId: string, state: ProviderWatchdogState) => void;
  onTimeout?: (providerId: string, modelId: string, kind: "start" | "idle") => void;
}

function emptyMessage(model: Model<Api>): AssistantMessage {
  return {
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
    stopReason: "pending",
    timestamp: Date.now(),
  };
}

function terminalError(
  model: Model<Api>,
  reason: "error" | "aborted",
  message: string,
  partial: AssistantMessage,
): AssistantMessageEvent {
  return {
    type: "error",
    reason,
    error: {
      ...partial,
      api: model.api,
      provider: model.provider,
      model: model.id,
      stopReason: reason,
      errorMessage: message,
      timestamp: Date.now(),
    },
  };
}

function wrapStream(
  provider: Provider,
  model: Model<Api>,
  _context: Context,
  options: StreamOptions | SimpleStreamOptions | undefined,
  open: (options: StreamOptions | SimpleStreamOptions | undefined) => AssistantMessageEventStream,
  watchdogOptions: ProviderWrapperOptions,
): AssistantMessageEventStream {
  if (!watchdogOptions.enabled) return open(options);
  const output = createAssistantMessageEventStream();
  const parentSignal = options?.signal;
  const requestController = new AbortController();
  const abortRequest = () => requestController.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abortRequest, { once: true });
  if (parentSignal?.aborted) requestController.abort(parentSignal.reason);
  let partial = emptyMessage(model);
  let settled = false;
  let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
  const finish = (event: AssistantMessageEvent): void => {
    if (settled) return;
    settled = true;
    watchdog.dispose();
    parentSignal?.removeEventListener("abort", abortRequest);
    output.push(event);
  };
  const closeIterator = (): void => {
    try {
      const result = iterator?.return?.();
      if (result !== undefined) {
        void result.catch((error) =>
          console.error(
            `Provider stream iterator cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
          ),
        );
      }
    } catch (error) {
      console.error(
        `Provider stream iterator cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const watchdog = new ProviderWatchdog({
    providerId: provider.id,
    modelId: model.id,
    ...watchdogOptions,
    signal: parentSignal,
    onTimeout: (kind) => {
      requestController.abort(new Error(`provider stream ${kind} timeout`));
      closeIterator();
      watchdogOptions.onTimeout?.(provider.id, model.id, kind);
      finish(
        terminalError(
          model,
          "error",
          `Provider stream ${kind} timeout for ${provider.id}/${model.id}`,
          partial,
        ),
      );
    },
    onUserAbort: () => {
      requestController.abort(parentSignal?.reason);
      closeIterator();
      finish(terminalError(model, "aborted", "Provider stream aborted by user", partial));
    },
    onStateChange: (state) => watchdogOptions.onStateChange?.(provider.id, model.id, state),
  });
  const consume = async (): Promise<void> => {
    if (parentSignal?.aborted) {
      watchdog.userAbort();
      return;
    }
    if (!watchdog.beginAttempt()) return;
    try {
      const forwardedOptions = options
        ? { ...options, signal: requestController.signal }
        : { signal: requestController.signal };
      const source = open(forwardedOptions);
      iterator = source[Symbol.asyncIterator]();
      while (!settled) {
        const next = await iterator.next();
        if (next.done) break;
        const event = next.value;
        if (!watchdog.onEvent()) return;
        if ("partial" in event) partial = event.partial;
        if (event.type === "done") {
          watchdog.complete();
          finish(event);
          return;
        }
        if (event.type === "error") {
          watchdog.providerError();
          finish(event);
          return;
        }
        output.push(event);
      }
      if (!settled) {
        watchdog.providerError();
        finish(
          terminalError(model, "error", "Provider stream ended without a terminal event", partial),
        );
      }
    } catch (error) {
      if (settled) return;
      watchdog.providerError();
      finish(
        terminalError(
          model,
          "error",
          error instanceof Error ? error.message : String(error),
          partial,
        ),
      );
    }
  };
  void consume();
  return output;
}

/** Wrap a complete public Provider while preserving all non-stream capabilities. */
export function wrapProvider(provider: Provider, options: ProviderWrapperOptions): Provider {
  const marked = provider as WatchdogProvider;
  if (marked[WATCHDOG_WRAPPED]) return provider;
  const wrapped = Object.create(provider) as WatchdogProvider;
  Object.defineProperty(wrapped, "stream", {
    value: (model: Model<Api>, context: Context, streamOptions?: StreamOptions) =>
      wrapStream(
        provider,
        model,
        context,
        streamOptions,
        (forwarded) => provider.stream(model, context, forwarded as StreamOptions),
        options,
      ),
  });
  Object.defineProperty(wrapped, "streamSimple", {
    value: (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions) =>
      wrapStream(
        provider,
        model,
        context,
        streamOptions,
        (forwarded) => provider.streamSimple(model, context, forwarded as SimpleStreamOptions),
        options,
      ),
  });
  Object.defineProperty(wrapped, WATCHDOG_WRAPPED, { value: true });
  return wrapped;
}

export function isWatchdogWrappedProvider(provider: Provider): boolean {
  return (provider as WatchdogProvider)[WATCHDOG_WRAPPED] === true;
}
