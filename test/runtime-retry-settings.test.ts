import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import test from "node:test";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";
import { mixcodeFauxStream } from "../src/agent/faux-stream.js";
import { MIXCODE_RETRY_DEFAULTS } from "../src/agent/retry-settings.js";
import { createErrorContinueExtension } from "../other-pi-packages/mpi-error-continue/index.js";

test("runtime sessions use MixCode retry defaults without persisting settings", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retry-defaults-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir: path.join(dir, "agent"),
    });
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

test("runtime maps proxy upstream errors through Pi's public retry lifecycle", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retry-public-lifecycle-"));
  try {
    let attempts = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir: path.join(dir, "agent"),
      streamFn: (model, context, options) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('{"type":"upstream_error","message":"Upstream request failed"}');
        }
        return mixcodeFauxStream(model, context, options);
      },
    });
    const model = {
      ...MIXCODE_FAUX_MODEL,
      provider: "retry-test",
      id: "retry-test",
      name: "Retry Test",
      api: "retry-test",
    };
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      model,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    runtimeTab.agentSession.settingsManager.getRetrySettings = () => ({
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 1,
      maxAgentDelayMs: 60_000,
    });

    await runtime.prompt("s1", "retry once");

    assert.equal(attempts, 2);
    assert.equal(runtimeTab.agentSession.messages.at(-1)?.role, "assistant");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("error-continue waits for successful host auto-retry", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-retry-error-continue-success-"),
  );
  try {
    let attempts = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir: path.join(dir, "agent"),
      extensionFactories: [createErrorContinueExtension({ gate: async () => "continue" })],
      streamFn: (model, context, options) => {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('{"type":"upstream_error","message":"Upstream request failed"}');
        }
        return mixcodeFauxStream(model, context, options);
      },
    });
    const model = {
      ...MIXCODE_FAUX_MODEL,
      provider: "retry-test",
      id: "retry-test",
      name: "Retry Test",
      api: "retry-test",
    };
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      model,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    runtimeTab.agentSession.settingsManager.getRetrySettings = () => ({
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 1,
      maxAgentDelayMs: 60_000,
    });

    await runtime.prompt("s1", "retry once");

    assert.equal(attempts, 2);
    assert.equal(runtimeTab.agentSession.messages.at(-1)?.role, "assistant");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
test("error-continue takes over after host auto-retry is exhausted", async () => {
  const dir = await fsPromises.mkdtemp(
    path.join(os.tmpdir(), "mixcode-retry-error-continue-exhausted-"),
  );
  try {
    let attempts = 0;
    let gateCalls = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: path.join(dir, "sessions"),
      agentDir: path.join(dir, "agent"),
      extensionFactories: [
        createErrorContinueExtension({
          gate: async () => {
            gateCalls += 1;
            return "continue";
          },
        }),
      ],
      streamFn: (model, context, options) => {
        attempts += 1;
        if (attempts <= 2) {
          throw new Error('{"type":"upstream_error","message":"Upstream request failed"}');
        }
        return mixcodeFauxStream(model, context, options);
      },
    });
    const model = {
      ...MIXCODE_FAUX_MODEL,
      provider: "retry-test",
      id: "retry-test",
      name: "Retry Test",
      api: "retry-test",
    };
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      model,
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
    });
    runtimeTab.agentSession.settingsManager.getRetrySettings = () => ({
      enabled: true,
      maxRetries: 1,
      baseDelayMs: 1,
      maxAgentDelayMs: 60_000,
    });

    await runtime.prompt("s1", "retry then continue");
    // The extension fires from agent_settled and starts a second turn after
    // prompt() resolves; wait for its outcome instead of a fixed sleep, which
    // starves under parallel-worker load.
    const settled = () =>
      attempts >= 3 && runtimeTab.agentSession.messages.at(-1)?.role === "assistant";
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && !settled()) await Bun.sleep(10);

    assert.equal(gateCalls, 1);
    assert.equal(attempts, 3);
    assert.equal(runtimeTab.agentSession.messages.at(-1)?.role, "assistant");
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
