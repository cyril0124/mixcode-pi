import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  applyContextLimitToSession,
  captureCompactionBaseline,
} from "../src/core/context-limit.js";
import {
  createTab,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  type RuntimeTab,
} from "./helpers/mixcode.js";

/** Apply a /context-limit value through `applyContextLimitToSession` for one tab. */
function applyLimit(runtimeTab: RuntimeTab, value: number | "reset"): void {
  applyContextLimitToSession(runtimeTab.tab, value, {
    model: runtimeTab.agentSession.model,
    settingsManager: runtimeTab.agentSession.settingsManager,
  });
}

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
    applyLimit(tabA, 4000);
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

    applyLimit(tabA, 4000);
    applyLimit(tabA, "reset");

    assert.deepEqual(tabA.agentSession.settingsManager.getCompactionSettings(), baselineA);
    assert.deepEqual(tabB.agentSession.settingsManager.getCompactionSettings(), beforeB);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("context-limit overrides model-specific budgets and reset restores every model baseline", () => {
  const manager = SettingsManager.inMemory({
    compaction: {
      reserveTokens: 5000,
      keepRecentTokens: 8000,
      modelOverrides: {
        "provider/model-a": { reserveTokens: 12000, keepRecentTokens: 20000 },
        "provider/model-b": { reserveTokens: 6000 },
      },
    },
  });
  captureCompactionBaseline(manager);
  const first = { provider: "provider", id: "model-a" };
  const second = { provider: "provider", id: "model-b" };
  const baseline = manager.getGlobalSettings();
  const tab = createTab(1, "context-limit-overrides", process.cwd());
  applyContextLimitToSession(tab, 4000, { settingsManager: manager });
  for (const model of [first, second]) {
    assert.deepEqual(manager.getCompactionSettings(model), {
      enabled: true,
      reserveTokens: 400,
      keepRecentTokens: 1000,
    });
  }
  applyContextLimitToSession(tab, 10000, { settingsManager: manager });
  assert.equal(manager.getCompactionSettings(second).reserveTokens, 1000);
  applyContextLimitToSession(tab, "reset", { settingsManager: manager });
  assert.deepEqual(manager.getCompactionSettings(first), {
    enabled: true,
    reserveTokens: 12000,
    keepRecentTokens: 20000,
  });
  assert.deepEqual(manager.getCompactionSettings(second), {
    enabled: true,
    reserveTokens: 6000,
    keepRecentTokens: 8000,
  });
  assert.deepEqual(manager.getGlobalSettings(), baseline);
});
