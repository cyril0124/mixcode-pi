import assert from "node:assert/strict";
import { test } from "node:test";
import { fauxProvider, type Provider } from "@earendil-works/pi-ai";
import { isWatchdogWrappedProvider } from "./provider-wrapper.js";
import { wireStuckGuard } from "./index.js";

function makeProvider(providerId: string): Provider {
  return fauxProvider({
    provider: providerId,
    models: [{ id: "alpha", name: providerId, contextWindow: 100_000, maxTokens: 1000 }],
  }).provider;
}

function makeHarness() {
  const handlers = new Map<string, ((event: unknown, context: unknown) => unknown)[]>();
  const providers = new Map<string, Provider>();
  const notifications: string[] = [];
  const registry = {
    getRegisteredProviderIds: () => [...providers.keys()],
    getAll: () => [...providers.values()].flatMap((provider) => provider.getModels()),
    getAvailable: () => [...providers.values()].flatMap((provider) => provider.getModels()),
    getProvider: (id: string) => providers.get(id),
    registerProvider: (provider: Provider) => providers.set(provider.id, provider),
  };
  const pi = {
    on(event: string, handler: (event: unknown, context: unknown) => unknown) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerCommand() {},
  };
  const context = {
    modelRegistry: registry,
    hasUI: true,
    ui: { notify: (message: string) => notifications.push(message) },
  };
  async function emit(event: string): Promise<void> {
    for (const handler of handlers.get(event) ?? []) await handler({}, context);
  }
  return {
    pi,
    providers,
    notifications,
    emit,
    register(provider: Provider) {
      providers.set(provider.id, provider);
    },
  };
}

test("wiring wraps selected providers and restores them when disabled", async () => {
  const harness = makeHarness();
  const provider = makeProvider("watchdog-test");
  harness.register(provider);
  let config = {
    streamWatchdogEnabled: true,
    providerIds: ["watchdog-test"],
    streamStartTimeoutSeconds: 1,
    streamIdleTimeoutSeconds: 1,
    streamRetryStartTimeoutSeconds: 1,
    knownTimeoutCooldownSeconds: 1,
    schemaHintFailureThreshold: 2,
  };
  wireStuckGuard(harness.pi as never, () => ({ ok: true as const, config, path: "test" }));
  await harness.emit("session_start");
  assert.equal(isWatchdogWrappedProvider(harness.providers.get("watchdog-test")!), true);
  config = { ...config, streamWatchdogEnabled: false };
  await harness.emit("before_agent_start");
  assert.equal(harness.providers.get("watchdog-test"), provider);
});

test("wiring reports unknown selected providers", async () => {
  const harness = makeHarness();
  wireStuckGuard(harness.pi as never, () => ({
    ok: true as const,
    config: {
      streamWatchdogEnabled: true,
      providerIds: ["missing"],
      streamStartTimeoutSeconds: 1,
      streamIdleTimeoutSeconds: 1,
      streamRetryStartTimeoutSeconds: 1,
      knownTimeoutCooldownSeconds: 1,
      schemaHintFailureThreshold: 2,
    },
    path: "test",
  }));
  await harness.emit("session_start");
  assert.deepEqual(harness.notifications, ["Error: Unknown provider: missing"]);
});
