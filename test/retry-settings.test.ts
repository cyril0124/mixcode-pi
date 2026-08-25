import assert from "node:assert/strict";
import test from "node:test";
import { isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyRetryJitter,
  configureMixCodeRetrySettings,
  MIXCODE_RETRY_DEFAULTS,
} from "../src/agent/retry-settings.js";
import { applyMixCodeSessionDefaults } from "../src/agent/runtime-lifecycle.js";

// Pi reads these modes via syncQueueModesFromSettings(getSteeringMode /
// getFollowUpMode). "all" keeps a queued user message and its extension
// companion messages (e.g. mpi-skill-refs' hidden $ref block) in one
// delivery batch; one-at-a-time splits them across separate runs.
test("applyMixCodeSessionDefaults drains both message queues in 'all' mode", () => {
  const settings = SettingsManager.inMemory();
  applyMixCodeSessionDefaults(settings);

  assert.equal(settings.getSteeringMode(), "all");
  assert.equal(settings.getFollowUpMode(), "all");
});

function classifyRetryable(message: {
  stopReason: AssistantMessage["stopReason"];
  errorMessage?: string;
}): boolean {
  return isRetryableAssistantError(message as AssistantMessage);
}

test("configureMixCodeRetrySettings applies MixCode retry defaults over SDK defaults", () => {
  const settings = SettingsManager.inMemory();
  configureMixCodeRetrySettings(settings);

  const retry = settings.getRetrySettings();
  assert.equal(retry.enabled, true);
  assert.equal(retry.maxRetries, MIXCODE_RETRY_DEFAULTS.maxRetries);
  assert.ok(retry.baseDelayMs >= 180);
  assert.ok(retry.baseDelayMs <= 220);
});

test("configureMixCodeRetrySettings preserves explicit retry settings", () => {
  const settings = SettingsManager.inMemory({
    retry: {
      maxRetries: 5,
      baseDelayMs: 1000,
    },
  });
  configureMixCodeRetrySettings(settings);

  const retry = settings.getRetrySettings();
  assert.equal(retry.enabled, true);
  assert.equal(retry.maxRetries, 5);
  assert.ok(retry.baseDelayMs >= 900);
  assert.ok(retry.baseDelayMs <= 1100);
});

test("configureMixCodeRetrySettings survives settings reloads", async () => {
  const settings = SettingsManager.inMemory();
  configureMixCodeRetrySettings(settings);
  await settings.reload();

  const retry = settings.getRetrySettings();
  assert.equal(retry.enabled, true);
  assert.equal(retry.maxRetries, MIXCODE_RETRY_DEFAULTS.maxRetries);
  assert.ok(retry.baseDelayMs >= 180);
  assert.ok(retry.baseDelayMs <= 220);
});

test("configureMixCodeRetrySettings is idempotent and jitters each read", () => {
  const settings = SettingsManager.inMemory();
  const originalRandom = Math.random;
  const randomValues = [0, 1];
  Math.random = () => randomValues.shift() ?? 0.5;
  try {
    configureMixCodeRetrySettings(settings);
    configureMixCodeRetrySettings(settings);

    assert.equal(settings.getRetrySettings().baseDelayMs, 180);
    assert.equal(settings.getRetrySettings().baseDelayMs, 220);
  } finally {
    Math.random = originalRandom;
  }
});

test("applyRetryJitter applies Codex-style ±10% jitter", () => {
  assert.equal(applyRetryJitter(200, 0), 180);
  assert.equal(applyRetryJitter(200, 0.5), 200);
  assert.equal(applyRetryJitter(200, 1), 220);
});

test("Pi's retry classifier treats proxy upstream errors as retryable without rewriting them", () => {
  const upstreamJson =
    '{"type":"error","error":{"type":"upstream_error","message":"上游: Upstream request failed"}}';
  assert.equal(classifyRetryable({ stopReason: "error", errorMessage: upstreamJson }), true);
  assert.equal(
    classifyRetryable({ stopReason: "error", errorMessage: "Upstream request failed" }),
    true,
  );
});

test("Pi's public retry classifier preserves its allowlist and deny-list", () => {
  assert.equal(classifyRetryable({ stopReason: "error", errorMessage: "500 server error" }), true);
  // SDK deny-list (quota/billing) still wins when wrapped in an upstream error.
  assert.equal(
    classifyRetryable({
      stopReason: "error",
      errorMessage: '{"type":"upstream_error","message":"quota exceeded"}',
    }),
    false,
  );
  // Non-transient errors stay non-retryable.
  assert.equal(classifyRetryable({ stopReason: "error", errorMessage: "invalid api key" }), false);
  assert.equal(classifyRetryable({ stopReason: "error" }), false);
  assert.equal(classifyRetryable({ stopReason: "stop" }), false);
});
