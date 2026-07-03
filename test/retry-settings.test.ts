import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyRetryJitter,
  configureMixCodeRetryClassification,
  configureMixCodeRetrySettings,
  MIXCODE_RETRY_DEFAULTS,
} from "../src/agent/retry-settings.js";

/** Invoke AgentSession's private retry classifier with a stub `this`. */
function classifyRetryable(message: { stopReason: string; errorMessage?: string }): boolean {
  const proto = AgentSession.prototype as unknown as {
    _isRetryableError(message: unknown): boolean;
  };
  return proto._isRetryableError.call({ model: undefined }, message);
}

test("configureMixCodeRetrySettings applies MixCode retry defaults over SDK defaults", () => {
  const settings = SettingsManager.inMemory();
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    configureMixCodeRetrySettings(settings);

    assert.deepEqual(settings.getRetrySettings(), {
      enabled: true,
      maxRetries: MIXCODE_RETRY_DEFAULTS.maxRetries,
      baseDelayMs: MIXCODE_RETRY_DEFAULTS.baseDelayMs,
    });
  } finally {
    Math.random = originalRandom;
  }
});

test("configureMixCodeRetrySettings preserves explicit retry settings", () => {
  const settings = SettingsManager.inMemory({
    retry: {
      maxRetries: 5,
      baseDelayMs: 1000,
    },
  });
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    configureMixCodeRetrySettings(settings);

    assert.deepEqual(settings.getRetrySettings(), {
      enabled: true,
      maxRetries: 5,
      baseDelayMs: 1000,
    });
  } finally {
    Math.random = originalRandom;
  }
});

test("configureMixCodeRetrySettings survives settings reloads", async () => {
  const settings = SettingsManager.inMemory();
  const originalRandom = Math.random;
  Math.random = () => 0.5;
  try {
    configureMixCodeRetrySettings(settings);
    await settings.reload();

    assert.deepEqual(settings.getRetrySettings(), {
      enabled: true,
      maxRetries: MIXCODE_RETRY_DEFAULTS.maxRetries,
      baseDelayMs: MIXCODE_RETRY_DEFAULTS.baseDelayMs,
    });
  } finally {
    Math.random = originalRandom;
  }
});

test("configureMixCodeRetrySettings is idempotent and jitters once per read", () => {
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

test("configureMixCodeRetryClassification treats proxy upstream errors as retryable", () => {
  configureMixCodeRetryClassification();

  assert.equal(
    classifyRetryable({
      stopReason: "error",
      errorMessage:
        '{"type":"error","error":{"type":"upstream_error","message":"上游: Upstream request failed"}}',
    }),
    true,
  );
});

test("configureMixCodeRetryClassification is idempotent and preserves SDK classification", () => {
  configureMixCodeRetryClassification();
  configureMixCodeRetryClassification();

  // SDK allowlist still works through the wrapper.
  assert.equal(classifyRetryable({ stopReason: "error", errorMessage: "500 server error" }), true);
  // SDK deny-list (quota/billing) still wins over generic wording.
  assert.equal(classifyRetryable({ stopReason: "error", errorMessage: "quota exceeded" }), false);
  // Non-transient errors stay non-retryable.
  assert.equal(classifyRetryable({ stopReason: "error", errorMessage: "invalid api key" }), false);
  assert.equal(classifyRetryable({ stopReason: "error" }), false);
  assert.equal(classifyRetryable({ stopReason: "stop" }), false);
});
