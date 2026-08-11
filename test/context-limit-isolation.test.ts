import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";
import { adjustCompactionSettingsForLimit } from "../src/core/context-limit.js";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "../src/index.js";

// Regression: /context-limit must not leak one tab's compaction override into
// other tabs. Each tab owns its own SettingsManager, so adjusting one tab's
// budget leaves sibling tabs (independent services) untouched.
test("context-limit override on one tab does not contaminate another tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-ctx-isolation-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir: path.join(dir, "agent"),
    });
    const tabA = await runtime.createTab(createTab(1, "sA", dir), {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const tabB = await runtime.createTab(createTab(2, "sB", dir), {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });

    // Tab A reflects its own override; Tab B is unchanged.
    const beforeB = tabB.agentSession.settingsManager.getCompactionSettings();
    adjustCompactionSettingsForLimit(tabA.agentSession.settingsManager, 4000, true);
    const afterA = tabA.agentSession.settingsManager.getCompactionSettings();
    const afterB = tabB.agentSession.settingsManager.getCompactionSettings();

    assert.equal(afterA.reserveTokens, 400);
    assert.equal(afterA.keepRecentTokens, 1000);
    assert.deepEqual(afterB, beforeB);
    assert.notDeepEqual(afterA, afterB);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

// Reset restores the tab's own captured baseline, not hardcoded SDK defaults,
// and still does not touch a sibling tab.
test("context-limit reset restores the tab baseline without touching siblings", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-ctx-reset-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir: path.join(dir, "agent"),
    });
    const tabA = await runtime.createTab(createTab(1, "sA", dir), {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    const tabB = await runtime.createTab(createTab(2, "sB", dir), {
      model: MIXCODE_FAUX_MODEL,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });

    const baselineA = tabA.agentSession.settingsManager.getCompactionSettings();
    const beforeB = tabB.agentSession.settingsManager.getCompactionSettings();

    adjustCompactionSettingsForLimit(tabA.agentSession.settingsManager, 4000, true);
    adjustCompactionSettingsForLimit(tabA.agentSession.settingsManager, 4000, false);

    assert.deepEqual(tabA.agentSession.settingsManager.getCompactionSettings(), baselineA);
    assert.deepEqual(tabB.agentSession.settingsManager.getCompactionSettings(), beforeB);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
