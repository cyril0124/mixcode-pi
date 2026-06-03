import assert from "node:assert/strict";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyRetryJitter,
  configureMixCodeRetrySettings,
  MIXCODE_RETRY_DEFAULTS,
} from "../src/agent/retry-settings.js";

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
