import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
} from "./helpers/mixcode.js";
import { createSettingsPanel } from "./helpers/settings-panel.js";

test("a failed warming save cannot roll back the next concurrent selection", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "warming-save-order-"));
  let stored = "{}";
  let rejectFirstWrite = true;
  // Inject a failure at the storage boundary; the manager and runtime remain real.
  const manager = SettingsManager.fromStorage({
    withLock(scope, update) {
      const next = update(scope === "global" ? stored : "{}");
      if (scope !== "global" || next === undefined) return;
      if (rejectFirstWrite) {
        rejectFirstWrite = false;
        throw new Error("storage write rejected");
      }
      stored = next;
    },
  });
  const runtime = new MixCodeRuntime({ sessionsRoot: dir, settingsManager: manager });
  t.after(async () => {
    runtime.beginShutdown();
    await manager.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });

  const [first, second] = await Promise.allSettled([
    runtime.setCacheWarmingMode("off"),
    runtime.setCacheWarmingMode("idle"),
  ]);
  assert.equal(first.status, "rejected");
  if (first.status === "rejected") assert.match(String(first.reason), /storage write rejected/);
  assert.equal(second.status, "fulfilled");
  assert.equal(manager.getCacheWarmingMode(), "idle");
  assert.equal(JSON.parse(stored).cacheWarming, "idle");
});

test("a tab settings write failure does not prevent other tabs from disabling warming", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "warming-tab-save-failure-"));
  const agentDir = path.join(dir, "agent");
  // The global store succeeds while the per-tab file storage fails at the OS boundary.
  const manager = SettingsManager.inMemory();
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir,
    settingsManager: manager,
  });
  t.after(async () => {
    runtime.beginShutdown();
    for (const tab of runtime.listTabs()) {
      tab.agentSession.dispose();
      await tab.agentSession.settingsManager.flush();
    }
    await fs.rm(dir, { recursive: true, force: true });
  });
  const config = { model: MIXCODE_FAUX_MODEL, thinkingLevel: "off" as const, workdir: dir };
  const first = await runtime.createTab(createTab(1, "first", dir), config);
  const second = await runtime.createTab(createTab(2, "second", dir), config);
  await fs.mkdir(path.join(agentDir, "settings.json"), { recursive: true });

  await assert.rejects(runtime.setCacheWarmingMode("off"), /Failed to synchronize cache warming/);
  assert.equal(manager.getCacheWarmingMode(), "off");
  assert.equal(first.agentSession.settingsManager.getCacheWarmingMode(), "off");
  assert.equal(second.agentSession.settingsManager.getCacheWarmingMode(), "off");
  assert.match(second.agentSession.cacheWarmingStatus?.reason ?? "", /disabled/);
});

for (const rows of [10, 12, 13, 14, 24]) {
  test(`warming choices and save error stay visible in a ${rows}-row terminal`, () => {
    const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true });
    try {
      const panel = createSettingsPanel(createInitialState("/repo"), SettingsManager.inMemory());
      panel.handleInput("cache warming");
      panel.handleInput("\r");
      panel.editError = "Error: Failed to save Cache warming";
      const lines = panel.render(120).map(stripTerminalSequences);
      const heightLimit = Math.floor(rows * 0.8);
      assert.ok(lines.length <= heightLimit, `${lines.length} rows exceed ${heightLimit}`);
      // Pi clips from the bottom. The actual visible slice must retain the controls.
      const visible = lines.slice(0, heightLimit).join("\n");
      assert.match(visible, /off: No refresh requests/);
      assert.match(visible, /streaming: During agent runs/);
      assert.match(visible, /idle: Also between runs/);
      assert.match(visible, /may cost money/);
      assert.match(visible, /Error: Failed to save Cache warming.*retry.*esc back/);
    } finally {
      if (originalRows) Object.defineProperty(process.stdout, "rows", originalRows);
      else Reflect.deleteProperty(process.stdout, "rows");
    }
  });
}
