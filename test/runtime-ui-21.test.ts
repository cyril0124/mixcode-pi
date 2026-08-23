import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  type MixCodeModel,
} from "./helpers/mixcode.js";

test("runtime lets Pi resource loader discover project system prompt before MixCode fallback", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-system-resource-"));
  const repo = path.join(dir, "repo");
  try {
    await fsPromises.mkdir(path.join(repo, ".pi"), { recursive: true });
    await fsPromises.writeFile(path.join(repo, ".pi", "SYSTEM.md"), "Project system prompt", "utf8");
    await fsPromises.writeFile(path.join(repo, ".pi", "APPEND_SYSTEM.md"), "Append prompt", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: path.join(dir, "sessions") });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", repo), {
      systemPrompt: "Fallback prompt",
      thinkingLevel: "medium",
      workdir: repo,
    });

    assert.match(runtimeTab.agentSession.agent.state.systemPrompt, /Project system prompt/);
    assert.match(runtimeTab.agentSession.agent.state.systemPrompt, /Append prompt/);
    assert.doesNotMatch(runtimeTab.agentSession.agent.state.systemPrompt, /Fallback prompt/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime creation and events sync tab model, usage, and done status", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd(), { status: "done" });
  const explicit: MixCodeModel = {
    ...MIXCODE_FAUX_MODEL,
    id: "refresh-model",
    contextWindow: 1234,
  };
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "high",
    workdir: process.cwd(),
    model: explicit,
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "usage" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 7,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 12,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  });

  assert.equal(tab.status, "done");
  assert.equal(tab.model.modelId, "refresh-model");
  assert.equal(tab.contextLimit, 1234);
  assert.equal(tab.thinkingLevel, "high");
  assert.equal(tab.currentContextTokens, 12);
});

test("runtime tab reflects Pi thinking clamp after creation", async () => {
  const runtime = new MixCodeRuntime();
  const model: MixCodeModel = {
    ...MIXCODE_FAUX_MODEL,
    id: "no-reasoning-model",
    reasoning: false,
  };
  const tab = createTab(1, "s1", process.cwd(), { thinkingLevel: "max" });

  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "",
    thinkingLevel: "max",
    workdir: process.cwd(),
    model,
  });

  assert.equal(runtimeTab.agentSession.thinkingLevel, "off");
  assert.equal(tab.thinkingLevel, "off");
});

test("runtime thinking update delegates to Pi agent session", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd(), { thinkingLevel: "high" });
  const model: MixCodeModel = {
    ...MIXCODE_FAUX_MODEL,
    id: "max-model",
    reasoning: true,
    thinkingLevelMap: { max: "max" },
  };
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "",
    thinkingLevel: "high",
    workdir: process.cwd(),
    model,
  });

  const effective = runtime.updateTabThinkingLevel("s1", "max");

  assert.equal(effective, "max");
  assert.equal(runtimeTab.agentSession.agent.state.thinkingLevel, "max");
  assert.equal(runtimeTab.agentSession.thinkingLevel, "max");
  assert.equal(tab.thinkingLevel, "max");
});
