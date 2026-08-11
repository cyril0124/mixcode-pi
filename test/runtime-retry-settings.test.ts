import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "../src/index.js";
import { MIXCODE_RETRY_DEFAULTS } from "../src/agent/retry-settings.js";

test("runtime sessions use MixCode retry defaults without persisting settings", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retry-defaults-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: path.join(dir, "sessions"), agentDir: path.join(dir, "agent") });
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime sessions preserve explicit user retry settings", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retry-explicit-"));
  try {
    // Each tab now gets its own file-backed SettingsManager, so explicit retry
    // settings must live on disk (global settings.json) to be read back.
    const agentDir = path.join(dir, "agent");
    await fsPromises.mkdir(agentDir, { recursive: true });
    await fsPromises.writeFile(
      path.join(agentDir, "settings.json"),
      JSON.stringify({ retry: { maxRetries: 4, baseDelayMs: 1000 } }),
      "utf8",
    );
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir,
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
