import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream,
  createFauxCore,
  fauxAssistantMessage,
  fauxToolCall,
  Type,
} from "@earendil-works/pi-ai";
import { SettingsManager, type ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  createInitialState,
  createTab,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
} from "./helpers/mixcode.js";
import { createSettingsPanel } from "./helpers/settings-panel.js";

async function fixture(t: TestContext, extensionFactories: ExtensionFactory[] = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-cache-warming-"));
  const agentDir = path.join(dir, "agent");
  const projectDir = path.join(dir, "project");
  await Bun.write(
    path.join(projectDir, ".pi/settings.json"),
    JSON.stringify({ cacheWarming: "idle" }),
  );
  const settingsManager = SettingsManager.create(dir, agentDir, { projectTrusted: true });
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir,
    settingsManager,
    extensionFactories,
  });
  t.after(async () => {
    runtime.beginShutdown();
    for (const tab of runtime.listTabs()) {
      await tab.agentSession.abort();
      tab.agentSession.dispose();
      await tab.agentSession.settingsManager.flush();
    }
    await settingsManager.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const config = { model: MIXCODE_FAUX_MODEL, thinkingLevel: "off" as const };
  const first = await runtime.createTab(createTab(1, "a", dir), { ...config, workdir: dir });
  const second = await runtime.createTab(createTab(2, "b", projectDir), {
    ...config,
    workdir: projectDir,
  });
  return { dir, agentDir, projectDir, settingsManager, runtime, first, second, config };
}

test("cache warming uses Pi's global default and persists changes to all live and future tabs", async (t) => {
  const { dir, agentDir, projectDir, settingsManager, runtime, first, second, config } =
    await fixture(t);
  assert.equal(settingsManager.getCacheWarmingMode(), "streaming");
  assert.equal(second.agentSession.settingsManager.getProjectSettings().cacheWarming, "idle");
  assert.equal(second.agentSession.settingsManager.getCacheWarmingMode(), "streaming");
  first.agentSession.settingsManager.applyOverrides({ compaction: { reserveTokens: 123 } });
  for (const mode of ["off", "idle", "streaming"] as const) {
    await runtime.setCacheWarmingMode(mode);
    assert.equal(settingsManager.getCacheWarmingMode(), mode);
    assert.equal(first.agentSession.settingsManager.getCacheWarmingMode(), mode);
    assert.equal(second.agentSession.settingsManager.getCacheWarmingMode(), mode);
    assert.equal(first.agentSession.settingsManager.getCompactionSettings().reserveTokens, 123);
    assert.equal((await Bun.file(path.join(agentDir, "settings.json")).json()).cacheWarming, mode);
    assert.equal(SettingsManager.create(projectDir, agentDir).getCacheWarmingMode(), mode);
  }
  await runtime.setCacheWarmingMode("off");
  const third = await runtime.createTab(createTab(3, "c", dir), { ...config, workdir: dir });
  assert.equal(third.agentSession.settingsManager.getCacheWarmingMode(), "off");
  assert.equal(
    (await Bun.file(path.join(projectDir, ".pi/settings.json")).json()).cacheWarming,
    "idle",
  );
});

test("settings panel chooses cache warming without changing the mode during option browsing", async (t) => {
  const { dir, agentDir, settingsManager, runtime, first } = await fixture(t);
  const state = createInitialState(dir);
  const panel = createSettingsPanel(state, settingsManager, {
    piSettingsFile: path.join(agentDir, "settings.json"),
    setCacheWarmingMode: runtime.setCacheWarmingMode.bind(runtime),
  });
  panel.handleInput("cache warming");
  assert.match(panel.render(120).join("\n"), /streaming/);
  assert.match(panel.render(120).join("\n"), /Cache warming/);
  panel.handleInput("\r");
  panel.handleInput("\x1b[A");
  assert.equal(settingsManager.getCacheWarmingMode(), "streaming");
  panel.handleInput("\x1b");
  assert.equal(settingsManager.getCacheWarmingMode(), "streaming");
  panel.handleInput("\r");
  panel.handleInput("\x1b[A");
  panel.handleInput("\r");
  await waitFor(() => !panel.enumOpen);
  assert.equal(first.agentSession.settingsManager.getCacheWarmingMode(), "off");
  assert.equal((await Bun.file(path.join(agentDir, "settings.json")).json()).cacheWarming, "off");
});

test("cache warming save failure is surfaced and does not change other sessions", async (t) => {
  const { agentDir, settingsManager, runtime, first } = await fixture(t);
  await fs.mkdir(path.join(agentDir, "settings.json"));
  await assert.rejects(runtime.setCacheWarmingMode("off"), /Error:.*cache warming/i);
  assert.equal(first.agentSession.settingsManager.getCacheWarmingMode(), "streaming");
  assert.equal(settingsManager.getCacheWarmingMode(), "streaming");
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000;
  while (!predicate() && Date.now() < deadline) await Bun.sleep(10);
  assert.equal(predicate(), true);
}

test("off aborts an in-flight cache refresh without aborting the agent's tool", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-warming-abort-"));
  const agentDir = path.join(dir, "agent");
  const settingsManager = SettingsManager.create(dir, agentDir);
  const model = {
    ...MIXCODE_FAUX_MODEL,
    provider: "warming-test",
    api: "warming-test",
    promptCache: { short: 11 },
    cost: { input: 10, output: 1, cacheRead: 1, cacheWrite: 10 },
  };
  const core = createFauxCore({ provider: model.provider, api: model.api });
  core.setResponses([
    fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("Finished."),
  ]);
  const toolStarted = Promise.withResolvers<void>();
  const releaseTool = Promise.withResolvers<void>();
  const refreshStarted = Promise.withResolvers<void>();
  const refreshAborted = Promise.withResolvers<void>();
  let toolAborted = false;
  let refreshes = 0;
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir,
    settingsManager,
    extensionFactories: [
      (pi) => {
        pi.on("cache_warming_decision", () => ({ action: "warm" }));
        pi.registerTool({
          name: "hold",
          label: "Hold",
          description: "Hold the active tool",
          parameters: Type.Object({}),
          execute: async (_id, _args, signal) => {
            signal?.addEventListener(
              "abort",
              () => {
                toolAborted = true;
                releaseTool.resolve();
              },
              { once: true },
            );
            toolStarted.resolve();
            await releaseTool.promise;
            return { content: [{ type: "text", text: "released" }], details: {} };
          },
        });
      },
    ],
    streamFn: (requestModel, context, options) => {
      if (options?.maxTokens !== 1) return core.stream(requestModel, context, options);
      refreshes++;
      const stream = createAssistantMessageEventStream();
      const abort = () => {
        const message = fauxAssistantMessage([], { stopReason: "aborted" });
        stream.push({ type: "error", reason: "aborted", error: message });
        stream.end(message);
        refreshAborted.resolve();
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      refreshStarted.resolve();
      return stream;
    },
  });
  t.after(async () => {
    releaseTool.resolve();
    runtime.beginShutdown();
    for (const tab of runtime.listTabs()) {
      await tab.agentSession.abort();
      tab.agentSession.dispose();
      await tab.agentSession.settingsManager.flush();
    }
    await settingsManager.flush();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const tab = await runtime.createTab(createTab(1, "live", dir), {
    model,
    workdir: dir,
    thinkingLevel: "off",
  });
  const running = runtime.prompt("live", "hold until released");
  await toolStarted.promise;
  assert.equal(tab.agentSession.cacheWarmingStatus?.state, "scheduled");
  await refreshStarted.promise;
  assert.equal(tab.agentSession.cacheWarmingStatus?.state, "refreshing");
  await runtime.setCacheWarmingMode("off");
  await refreshAborted.promise;
  assert.equal(tab.agentSession.cacheWarmingStatus?.state, "inactive");
  assert.match(tab.agentSession.cacheWarmingStatus?.reason ?? "", /disabled/);
  assert.equal(toolAborted, false);
  releaseTool.resolve();
  await running;
  assert.equal(refreshes, 1);
  assert.equal(tab.agentSession.messages.at(-1)?.role, "assistant");
  assert.deepEqual(
    tab.session.getEntries().filter((entry) => entry.type === "usage"),
    [],
  );
});

test("failed cache warming choice stays open with an error and restores the saved mode", async (t) => {
  const { dir, agentDir, settingsManager, runtime, first } = await fixture(t);
  const panel = createSettingsPanel(createInitialState(dir), settingsManager, {
    setCacheWarmingMode: runtime.setCacheWarmingMode.bind(runtime),
  });
  await fs.mkdir(path.join(agentDir, "settings.json"));
  panel.handleInput("cache warming");
  panel.handleInput("\r");
  panel.handleInput("\x1b[A");
  panel.handleInput("\r");
  await waitFor(() => Boolean(panel.editError));
  assert.equal(panel.enumOpen, true);
  assert.match(panel.render(160).join("\n"), /Error: Failed to save Cache warming/);
  assert.equal(settingsManager.getCacheWarmingMode(), "streaming");
  assert.equal(first.agentSession.settingsManager.getCacheWarmingMode(), "streaming");
});
