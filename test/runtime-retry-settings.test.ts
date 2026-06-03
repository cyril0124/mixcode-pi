import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "../src/index.js";
import { MIXCODE_RETRY_DEFAULTS } from "../src/agent/retry-settings.js";

test("runtime sessions use MixCode retry defaults without persisting settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-retry-defaults-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, "sessions"), agentDir: join(dir, "agent") });
    const tab = createTab(1, "s1", dir);

    const runtimeTab = await runtime.createTab(tab, {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });

    const retry = runtimeTab.agentSession.settingsManager.getRetrySettings();
    assert.equal(retry.maxRetries, MIXCODE_RETRY_DEFAULTS.maxRetries);
    assert.ok(retry.baseDelayMs >= 180);
    assert.ok(retry.baseDelayMs <= 220);
    assert.equal(runtimeTab.agentSession.settingsManager.getGlobalSettings().retry, undefined);
    assert.equal(runtimeTab.agentSession.settingsManager.getProjectSettings().retry, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime sessions preserve explicit user retry settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-retry-explicit-"));
  try {
    const agentDir = join(dir, "agent");
    const settingsManager = SettingsManager.inMemory({
      retry: {
        maxRetries: 4,
        baseDelayMs: 1000,
      },
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: join(dir, "sessions"),
      agentDir,
      settingsManager,
    });
    const tab = createTab(1, "s1", dir);

    const runtimeTab = await runtime.createTab(tab, {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });

    const retry = runtimeTab.agentSession.settingsManager.getRetrySettings();
    assert.equal(retry.maxRetries, 4);
    assert.ok(retry.baseDelayMs >= 900);
    assert.ok(retry.baseDelayMs <= 1100);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
