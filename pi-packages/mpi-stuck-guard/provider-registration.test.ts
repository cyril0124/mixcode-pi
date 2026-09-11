import assert from "node:assert/strict";
import { test } from "node:test";
import { ModelRegistry } from "@earendil-works/pi-coding-agent";
import {
  createAssistantMessageEventStream,
  fauxAssistantMessage,
  type Provider,
} from "@earendil-works/pi-ai";
import { wrapProvider } from "./provider-wrapper.js";
import { ProviderCooldownStore } from "./provider-watchdog.js";
import {
  createWatchdogRegistry,
  createWatchdogSession,
  successfulStream,
} from "../../test/helpers/stuck-guard.js";

for (const configured of [false, true]) {
  test(`lifecycle events and SDK refresh keep one watchdog and bounded request work (models.json=${configured})`, async () => {
    const fixture = await createWatchdogRegistry(configured);
    const session = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
    try {
      await session.emit("session_start");
      await fixture.runtime.refresh({ allowNetwork: false });
      let readsBefore = fixture.modelReads;
      assert.equal((await fixture.request(session.session.getSessionId())).stopReason, "stop");
      const initialReads = fixture.modelReads - readsBefore;

      for (let index = 0; index < 3; index++) await session.emit("before_agent_start");
      await fixture.runtime.refresh({ allowNetwork: false });
      readsBefore = fixture.modelReads;
      const message = await fixture.request(session.session.getSessionId());
      assert.equal(message.stopReason, "stop");
      assert.equal(fixture.requests, 2);
      assert.ok(
        fixture.modelReads - readsBefore <= initialReads,
        "request work must not grow with lifecycle events",
      );
      const stats = await session.stats();
      assert.equal(stats.providerAttempts, 2);
      assert.equal(stats.providerCompletions, 2);
    } finally {
      await session.emit("session_shutdown");
      await fixture.dispose();
    }
  });
}

test("sessions sharing a ModelRuntime have separate watchdog statistics", async () => {
  const fixture = await createWatchdogRegistry();
  const first = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  const second = createWatchdogSession(new ModelRegistry(fixture.runtime), {
    providerIds: [fixture.providerId],
  });
  try {
    await first.emit("session_start");
    await second.emit("session_start");
    await fixture.request(first.session.getSessionId());
    assert.equal((await first.stats()).providerCompletions, 1);
    assert.equal((await second.stats()).providerAttempts, 0);
    await fixture.request(second.session.getSessionId());
    assert.equal((await first.stats()).providerCompletions, 1);
    assert.equal((await second.stats()).providerCompletions, 1);
  } finally {
    await first.emit("session_shutdown");
    await second.emit("session_shutdown");
    await fixture.dispose();
  }
});

for (const originalKind of ["native", "config", "models"] as const) {
  test(`disable restores the original ${originalKind} registration and request configuration`, async () => {
    const fixture = await createWatchdogRegistry();
    if (originalKind !== "native") {
      fixture.registry.unregisterProvider(fixture.providerId);
      await fixture.runtime.refresh({ allowNetwork: false });
    }
    if (originalKind === "config") {
      fixture.registry.registerProvider(fixture.providerId, {
        api: fixture.model.api,
        apiKey: "offline-key",
        headers: { "X-Extension": "preserved" },
        streamSimple: () => successfulStream(),
      });
      await fixture.runtime.refresh({ allowNetwork: false });
    }
    const originalNative = fixture.registry.getRegisteredNativeProvider(fixture.providerId);
    const originalConfig = fixture.registry.getRegisteredProviderConfig(fixture.providerId);
    const originalModel = fixture.registry.find(fixture.providerId, "alpha");
    const originalAuth = await fixture.registry.getApiKeyAndHeaders(fixture.model);
    const session = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
    try {
      await session.emit("session_start");
      assert.deepEqual(fixture.registry.find(fixture.providerId, "alpha"), originalModel);
      assert.deepEqual(await fixture.registry.getApiKeyAndHeaders(fixture.model), originalAuth);
      session.updateConfig({ streamWatchdogEnabled: false });
      await session.emit("before_agent_start");
      assert.equal(
        fixture.registry.getRegisteredNativeProvider(fixture.providerId),
        originalNative,
      );
      assert.deepEqual(
        fixture.registry.getRegisteredProviderConfig(fixture.providerId),
        originalConfig,
      );
      assert.deepEqual(fixture.registry.find(fixture.providerId, "alpha"), originalModel);
      assert.deepEqual(await fixture.registry.getApiKeyAndHeaders(fixture.model), originalAuth);
    } finally {
      await session.emit("session_shutdown");
      await fixture.dispose();
    }
  });
}

test("a fresh factory can disable and re-enable an earlier native watchdog", async () => {
  const fixture = await createWatchdogRegistry();
  const first = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  const second = createWatchdogSession(new ModelRegistry(fixture.runtime), {
    providerIds: [fixture.providerId],
    streamWatchdogEnabled: false,
  });
  try {
    await first.emit("session_start");
    await second.emit("session_start");
    assert.equal(
      fixture.registry.getRegisteredNativeProvider(fixture.providerId),
      fixture.provider,
    );
    await fixture.request(second.session.getSessionId());
    assert.equal((await second.stats()).providerAttempts, 0);
    second.updateConfig({ streamWatchdogEnabled: true });
    await second.emit("before_agent_start");
    await fixture.request(second.session.getSessionId());
    assert.equal((await second.stats()).providerAttempts, 1);
    assert.equal((await first.stats()).providerAttempts, 0);
  } finally {
    await first.emit("session_shutdown");
    await second.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("an external provider replacement is preserved on disable and adopted on re-enable", async () => {
  const fixture = await createWatchdogRegistry();
  const session = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  const replacement = Object.create(fixture.provider) as Provider;
  try {
    await session.emit("session_start");
    fixture.registry.registerProvider(replacement);
    await fixture.runtime.refresh({ allowNetwork: false });
    session.updateConfig({ streamWatchdogEnabled: false });
    await session.emit("before_agent_start");
    assert.equal(fixture.registry.getRegisteredNativeProvider(fixture.providerId), replacement);
    session.updateConfig({ streamWatchdogEnabled: true });
    await session.emit("before_agent_start");
    await fixture.request(session.session.getSessionId());
    assert.equal((await session.stats()).providerAttempts, 1);
    session.updateConfig({ streamWatchdogEnabled: false });
    await session.emit("before_agent_start");
    assert.equal(fixture.registry.getRegisteredNativeProvider(fixture.providerId), replacement);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("provider deselection restores owned registrations without deleting foreign wrappers", async () => {
  const fixture = await createWatchdogRegistry();
  const session = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  try {
    await session.emit("session_start");
    session.updateConfig({ providerIds: ["missing"] });
    await session.emit("before_agent_start");
    assert.equal(
      fixture.registry.getRegisteredNativeProvider(fixture.providerId),
      fixture.provider,
    );
    session.updateConfig({ providerIds: [fixture.providerId] });
    await session.emit("before_agent_start");
    const guarded = fixture.registry.getRegisteredNativeProvider(fixture.providerId);
    assert.ok(guarded);
    const foreign = Object.create(guarded) as Provider;
    fixture.registry.registerProvider(foreign);
    session.updateConfig({ streamWatchdogEnabled: false });
    await session.emit("before_agent_start");
    assert.equal(fixture.registry.getRegisteredNativeProvider(fixture.providerId), foreign);
    const result = await fixture.request(session.session.getSessionId());
    assert.equal(result.stopReason, "stop");
    assert.equal((await session.stats()).providerAttempts, 0);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("replacement sessions retain their own statistics after stale shutdown and in-flight completion", async () => {
  const fixture = await createWatchdogRegistry();
  const first = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  const second = createWatchdogSession(
    new ModelRegistry(fixture.runtime),
    { providerIds: [fixture.providerId] },
    first.session,
  );
  const pending = createAssistantMessageEventStream();
  const opened = Promise.withResolvers<void>();
  fixture.setOpen(() => {
    opened.resolve();
    return pending;
  });
  try {
    await first.emit("session_start");
    const originalRequest = fixture.request(first.session.getSessionId());
    await opened.promise;
    await second.emit("session_start");
    await first.emit("session_shutdown");
    pending.push({
      type: "done",
      reason: "stop",
      message: fauxAssistantMessage("old", { stopReason: "stop" }),
    });
    assert.equal((await originalRequest).stopReason, "stop");
    assert.equal((await second.stats()).providerCompletions, 0);
    fixture.setOpen(() => successfulStream());
    await fixture.request(second.session.getSessionId());
    assert.equal((await second.stats()).providerCompletions, 1);
    assert.equal((await second.stats()).providerAttempts, 1);
  } finally {
    await first.emit("session_shutdown");
    await second.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("unknown, missing, and closed session IDs do not charge another session", async () => {
  const fixture = await createWatchdogRegistry();
  const session = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  try {
    await session.emit("session_start");
    await fixture.request();
    await fixture.request("unrelated-summary-id");
    assert.equal((await session.stats()).providerAttempts, 0);
    await session.emit("session_shutdown");
    await fixture.request(session.session.getSessionId());
    assert.equal((await session.stats()).providerAttempts, 0);
  } finally {
    await session.emit("session_shutdown");
    await fixture.dispose();
  }
});

test("boolean-only watchdog registrations request restart instead of gaining another layer", async () => {
  const fixture = await createWatchdogRegistry();
  const cooldowns = new ProviderCooldownStore();
  const previous = wrapProvider(fixture.registry.getProvider(fixture.providerId)!, {
    enabled: true,
    streamStartTimeoutMs: 0,
    streamIdleTimeoutMs: 0,
    streamRetryStartTimeoutMs: 0,
    knownTimeoutCooldownMs: 0,
    cooldowns,
  });
  fixture.registry.registerProvider(previous);
  const session = createWatchdogSession(fixture.registry, { providerIds: [fixture.providerId] });
  try {
    await session.emit("session_start");
    await session.emit("before_agent_start");
    assert.equal(fixture.registry.getRegisteredNativeProvider(fixture.providerId), previous);
    assert.deepEqual(session.notifications, [
      "Error: Restart the host to replace an older watchdog registration",
    ]);
  } finally {
    await session.emit("session_shutdown");
    cooldowns.dispose();
    await fixture.dispose();
  }
});
