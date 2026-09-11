import assert from "node:assert/strict";
import { test } from "node:test";
import { isWatchdogWrappedProvider } from "./provider-wrapper.js";
import { createWatchdogRegistry, createWatchdogSession } from "../../test/helpers/stuck-guard.js";

test("wiring wraps selected providers and restores them when disabled", async () => {
  const fixture = await createWatchdogRegistry(false);
  const session = createWatchdogSession(fixture.registry, {
    streamWatchdogEnabled: true,
    providerIds: [fixture.providerId],
    streamStartTimeoutSeconds: 1,
    streamIdleTimeoutSeconds: 1,
    streamRetryStartTimeoutSeconds: 1,
    knownTimeoutCooldownSeconds: 1,
    schemaHintFailureThreshold: 2,
  });
  try {
    await session.emit("session_start");
    assert.equal(
      isWatchdogWrappedProvider(fixture.registry.getProvider(fixture.providerId)!),
      true,
    );
    session.updateConfig({ streamWatchdogEnabled: false });
    await session.emit("before_agent_start");
    assert.equal(fixture.registry.getProvider(fixture.providerId), fixture.provider);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("wiring reports unknown selected providers", async () => {
  const fixture = await createWatchdogRegistry();
  const session = createWatchdogSession(fixture.registry, { providerIds: ["missing"] });
  try {
    await session.emit("session_start");
    assert.deepEqual(session.notifications, ["Error: Unknown provider: missing"]);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});
