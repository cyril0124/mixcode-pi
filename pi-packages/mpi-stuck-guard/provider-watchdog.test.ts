import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderCooldownStore,
  ProviderWatchdog,
  type ProviderWatchdogOptions,
} from "./provider-watchdog.js";

function options(overrides: Partial<ProviderWatchdogOptions> = {}): ProviderWatchdogOptions {
  return {
    providerId: "watchdog-test",
    modelId: "alpha",
    streamStartTimeoutMs: 100,
    streamIdleTimeoutMs: 100,
    streamRetryStartTimeoutMs: 10,
    knownTimeoutCooldownMs: 40,
    cooldowns: new ProviderCooldownStore(),
    ...overrides,
  };
}

test("timeout marks provider/model cooldown and shortens the next start window", async () => {
  const cooldowns = new ProviderCooldownStore();
  const first = new ProviderWatchdog(options({ cooldowns }));
  first.beginAttempt();
  first.timeout("start");
  const events: string[] = [];
  const next = new ProviderWatchdog(options({ cooldowns, onTimeout: (kind) => events.push(kind) }));
  next.beginAttempt();
  await Bun.sleep(20);
  assert.deepEqual(events, ["start"]);
  next.dispose();
  cooldowns.clearAll();
});

test("zero cooldown keeps the short-window state until explicitly cleared", () => {
  const cooldowns = new ProviderCooldownStore();
  const watchdog = new ProviderWatchdog(options({ cooldowns, knownTimeoutCooldownMs: 0 }));
  watchdog.beginAttempt();
  watchdog.timeout("start");
  const next = new ProviderWatchdog(options({ cooldowns, streamRetryStartTimeoutMs: 10 }));
  assert.equal(next.state, "cooldown_short_window");
  next.dispose();
  watchdog.dispose();
  cooldowns.clearAll();
});

test("cooldown store is instance-local", () => {
  const a = new ProviderCooldownStore();
  const b = new ProviderCooldownStore();
  const first = new ProviderWatchdog(options({ cooldowns: a }));
  first.beginAttempt();
  first.timeout("start");
  const nextA = new ProviderWatchdog(options({ cooldowns: a }));
  const nextB = new ProviderWatchdog(options({ cooldowns: b }));
  assert.equal(nextA.state, "cooldown_short_window");
  assert.equal(nextB.state, "idle");
  first.dispose();
  nextA.dispose();
  nextB.dispose();
  a.clearAll();
  b.clearAll();
});
