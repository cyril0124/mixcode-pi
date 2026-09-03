import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  fauxProvider,
  type AssistantMessageEventStream,
  type Provider,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { ProviderCooldownStore } from "./provider-watchdog.js";
import {
  isWatchdogWrappedProvider,
  wrapProvider,
  type ProviderWrapperOptions,
} from "./provider-wrapper.js";

function options(overrides: Partial<ProviderWrapperOptions> = {}): ProviderWrapperOptions {
  return {
    enabled: true,
    streamStartTimeoutMs: 20,
    streamIdleTimeoutMs: 20,
    streamRetryStartTimeoutMs: 10,
    knownTimeoutCooldownMs: 100,
    cooldowns: new ProviderCooldownStore(),
    ...overrides,
  };
}

function makeProvider(
  open: (options?: SimpleStreamOptions) => AssistantMessageEventStream,
): Provider {
  const base = fauxProvider({
    provider: "watchdog-test",
    models: [{ id: "alpha", name: "Watchdog Test", contextWindow: 100_000, maxTokens: 1000 }],
  }).provider;
  const provider = Object.create(base) as Provider;
  Object.defineProperty(provider, "streamSimple", {
    value: (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => open(options),
  });
  Object.defineProperty(provider, "stream", {
    value: (_model: unknown, _context: unknown, options?: SimpleStreamOptions) => open(options),
  });
  return provider;
}

function modelOf(provider: Provider) {
  return provider.getModels()[0]!;
}

const context = { messages: [] };

test("provider wrapper forwards the public stream entry point", async () => {
  const source = createAssistantMessageEventStream();
  const provider = makeProvider(() => source);
  const wrapped = wrapProvider(provider, options({ streamStartTimeoutMs: 100 }));
  const stream = wrapped.stream(modelOf(provider), context, { signal: undefined });
  const message = fauxAssistantMessage("done", { stopReason: "stop" });
  source.push({ type: "done", reason: "stop", message });
  assert.equal((await stream.result()).stopReason, "stop");
});

test("provider wrapper preserves provider capabilities and forwards normal done", async () => {
  const source = createAssistantMessageEventStream();
  const provider = makeProvider(() => source);
  const wrapped = wrapProvider(provider, options({ streamStartTimeoutMs: 100 }));
  assert.equal(wrapped.id, provider.id);
  assert.equal(wrapped.auth, provider.auth);
  assert.deepEqual(wrapped.getModels(), provider.getModels());
  assert.equal(isWatchdogWrappedProvider(wrapped), true);
  assert.equal(wrapProvider(wrapped, options()), wrapped);

  const stream = wrapped.streamSimple(modelOf(provider), context, { signal: undefined });
  const message = fauxAssistantMessage("done", { stopReason: "stop" });
  source.push({ type: "done", reason: "stop", message });
  assert.equal((await stream.result()).stopReason, "stop");
});

test("provider wrapper converts first-event timeout into retryable error and aborts source", async () => {
  let providerSignal: AbortSignal | undefined;
  const provider = makeProvider((providerOptions) => {
    providerSignal = providerOptions?.signal;
    return createAssistantMessageEventStream();
  });
  const wrapped = wrapProvider(provider, options());
  const result = await wrapped.streamSimple(modelOf(provider), context).result();
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /start timeout/);
  assert.equal(providerSignal?.aborted, true);
});

test("provider wrapper converts idle timeout after a received event", async () => {
  const source = createAssistantMessageEventStream();
  const provider = makeProvider(() => source);
  const wrapped = wrapProvider(provider, options({ streamStartTimeoutMs: 100 }));
  const stream = wrapped.streamSimple(modelOf(provider), context);
  const partial = fauxAssistantMessage("partial", { stopReason: "toolUse" });
  source.push({ type: "start", partial });
  await Bun.sleep(2);
  const resultPromise = stream.result();
  const result = await resultPromise;
  assert.equal(result.stopReason, "error");
  assert.match(result.errorMessage ?? "", /idle timeout/);
});
test("provider wrapper turns an already-aborted request into user abort", async () => {
  const controller = new AbortController();
  controller.abort(new Error("cancelled before open"));
  const provider = makeProvider(() => {
    throw new Error("provider should not open");
  });
  const wrapped = wrapProvider(provider, options());
  const result = await wrapped
    .streamSimple(modelOf(provider), context, { signal: controller.signal })
    .result();
  assert.equal(result.stopReason, "aborted");
  assert.match(result.errorMessage ?? "", /aborted by user/);
});

test("provider wrapper forwards partial events before terminal completion", async () => {
  const source = createAssistantMessageEventStream();
  const provider = makeProvider(() => source);
  const wrapped = wrapProvider(provider, options({ streamStartTimeoutMs: 100 }));
  const stream = wrapped.streamSimple(modelOf(provider), context);
  const partial = fauxAssistantMessage("partial", { stopReason: "pending" });
  const iterator = stream[Symbol.asyncIterator]();
  source.push({ type: "start", partial });
  const first = await iterator.next();
  assert.equal(first.value?.type, "start");
  const message = fauxAssistantMessage("done", { stopReason: "stop" });
  source.push({ type: "done", reason: "stop", message });
  const second = await iterator.next();
  assert.equal(second.value?.type, "done");
});

test("provider wrapper keeps user abort distinct from watchdog timeout", async () => {
  const controller = new AbortController();
  const source = createAssistantMessageEventStream();
  const provider = makeProvider(() => source);
  const wrapped = wrapProvider(provider, options());
  const resultPromise = wrapped
    .streamSimple(modelOf(provider), context, { signal: controller.signal })
    .result();
  controller.abort();
  const result = await resultPromise;
  assert.equal(result.stopReason, "aborted");
  assert.match(result.errorMessage ?? "", /aborted by user/);
});
