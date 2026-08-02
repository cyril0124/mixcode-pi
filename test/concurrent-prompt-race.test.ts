import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab } from "../src/index.js";

function fauxModel(): Model<string> {
  return {
    ...MIXCODE_FAUX_MODEL,
    provider: "concurrent-test",
    api: "concurrent-test",
    id: "concurrent-test-model",
  };
}

// Stream that resolves when signaled, used to control exact timing of run completion
function controlledStream(signal: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "response" }],
      api: "concurrent-test",
      provider: "concurrent-test",
      model: "concurrent-test-model",
      usage: {
        input: 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 20,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    await signal;
    if (options?.signal?.aborted) {
      const aborted = { ...message, stopReason: "aborted" as const, errorMessage: "Aborted" };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "content", content: message.content });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

async function waitFor(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      assert.fail(`waitFor timeout: predicate never became true after ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

for (const [scenario, firstMessage, secondMessage] of [
  ["plain prompts", "first message", "second message"],
  ["slash-prefixed agent turns", "/skill:missing first message", "/skill:missing second message"],
] as const) {
  test(`concurrent ${scenario} are serialized via dispatchTurn gate`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "mixcode-concurrent-"));
    try {
      let releaseFirstRun!: () => void;
      const firstRunSignal = new Promise<void>((resolve) => {
        releaseFirstRun = resolve;
      });
      let callCount = 0;

      const runtime = new MixCodeRuntime({
        sessionsRoot: dir,
        streamFn: (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
          callCount += 1;
          // First call gets controlled stream, subsequent calls use immediate faux
          if (callCount === 1) {
            return controlledStream(firstRunSignal, options);
          }
          // Immediate completion for follow-up
          const stream = createAssistantMessageEventStream();
          queueMicrotask(() => {
            const msg = {
              role: "assistant" as const,
              content: [{ type: "text" as const, text: "follow-up" }],
              api: "concurrent-test",
              provider: "concurrent-test",
              model: "concurrent-test-model",
              usage: {
                input: 5,
                output: 5,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 10,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              stopReason: "stop" as const,
              timestamp: Date.now(),
            };
            stream.push({ type: "start", partial: { ...msg, content: [] } });
            stream.push({ type: "content", content: msg.content });
            stream.push({ type: "done", reason: "stop", message: msg });
            stream.end(msg);
          });
          return stream;
        },
      });

      const tab = createTab(1, "s1", process.cwd());
      const runtimeTab = await runtime.createTab(tab, {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: process.cwd(),
        model: fauxModel(),
      });

      // Submit both before either call can transition the session to streaming.
      const prompt1 = runtime.prompt("s1", firstMessage);
      const prompt2 = runtime.prompt("s1", secondMessage);
      await waitFor(() => runtimeTab.agentSession.isStreaming === true);

      // Release first run to completion
      releaseFirstRun();
      await Promise.all([prompt1, prompt2]);

      const userMessages = runtime.getForkableUserMessages("s1").map((message) => message.text);
      assert.deepEqual(userMessages.slice(-2), [firstMessage, secondMessage]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("flush and user submit at idle boundary do not collide", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-flush-race-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: MIXCODE_FAUX_MODEL,
    });

    // Queue a pending message
    runtimeTab.tab.pendingMessages.push("queued message");
    runtimeTab.queuedPromptCount = 1;

    // Run a prompt to trigger agent_end → scheduleRuntimePendingMessageFlush
    await runtime.prompt("s1", "trigger flush");
    await waitFor(() => runtimeTab.agentSession.isStreaming === false);

    // Immediately fire user submit while flush is scheduled (might race at idle boundary)
    await runtime.prompt("s1", "user message");

    // Flush is fire-and-forget after idle; wait until both user turns land.
    await waitFor(() => {
      const texts = runtime.getForkableUserMessages("s1").map((message) => message.text);
      return texts.includes("queued message") && texts.includes("user message");
    });

    const userMessages = runtime.getForkableUserMessages("s1").map((message) => message.text);
    assert.ok(userMessages.includes("trigger flush"));
    assert.ok(userMessages.includes("queued message"));
    assert.ok(userMessages.includes("user message"));
    assert.equal(runtimeTab.tab.pendingMessages.length, 0);
    assert.equal(runtimeTab.queuedPromptCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
