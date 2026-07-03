import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab } from "../src/index.js";

function waitForRuntime(predicate: () => boolean, attempts = 100): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = () => {
      if (predicate()) return resolve();
      attempt += 1;
      if (attempt >= attempts) return reject(new Error("Timed out waiting for runtime condition"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

function toolCallMessage(toolCall: ToolCall): AssistantMessage {
  return {
    role: "assistant",
    content: [toolCall],
    api: "queue-test",
    provider: "queue-test",
    model: "queue-test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function textMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "queue-test",
    provider: "queue-test",
    model: "queue-test-model",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// Abort-aware stream, mirroring the real provider: when the run signal is
// already aborted, it yields an aborted message instead of producing output.
function streamMessage(message: AssistantMessage, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      const aborted: AssistantMessage = {
        ...message,
        content: [],
        stopReason: "aborted",
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    const firstContent = message.content[0];
    if (firstContent?.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: firstContent, partial: message });
    } else if (firstContent?.type === "text") {
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] },
      });
      stream.push({ type: "text_delta", contentIndex: 0, delta: firstContent.text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: firstContent.text, partial: message });
    }
    stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
    stream.end(message);
  });
  return stream;
}

function textOf(message: Context["messages"][number]): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function lastUserText(context: Context): string {
  const users = context.messages.filter((message) => message.role === "user");
  return users.at(-1) ? textOf(users.at(-1)!) : "";
}

// Regression: while a tool call is executing, the user queues a message, then
// hits Esc (abort + flush). The queued message must be re-sent as a fresh
// prompt, not silently drained into the aborted turn and dropped.
test("escape during a tool call flushes the queued message instead of dropping it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-queue-flush-repro-"));
  try {
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolStarted!: () => void;
    const toolRunning = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const seen: string[] = [];
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
    };

    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
        const text = lastUserText(context);
        seen.push(text);
        // First user turn triggers a long-running tool call.
        if (text === "do work") {
          return streamMessage(
            toolCallMessage({ type: "toolCall", id: "tc-1", name: "slow_tool", arguments: {} }),
            options,
          );
        }
        // Any later turn (including the flushed queued prompt) returns text.
        return streamMessage(textMessage(`Echo: ${text}`), options);
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "slow_tool",
            label: "Slow Tool",
            description: "Blocks until released so we can abort mid-execution.",
            parameters: Type.Object({}),
            execute: async () => {
              toolStarted();
              await toolReleased;
              return { content: [{ type: "text", text: "tool done" }], details: {} };
            },
          });
        },
      ],
    });

    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
    });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });

    // Kick off the tool-call turn.
    void runtime.prompt("s1", "do work");
    await toolRunning;
    assert.equal(runtimeTab.agentSession.isStreaming, true);

    // User types a message while the tool is running -> it queues as steering.
    await runtime.prompt("s1", "please also do this");
    assert.deepEqual(tab.pendingMessages, ["please also do this"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);

    // Simulate the Esc-with-queue path: abort the run, then flush the queue.
    const runtimeQueuedCount = runtimeTab.queuedPromptCount;
    runtime.abortTab("s1");
    // Release the tool so the aborted run can settle (mirrors real tool finishing/cancelling).
    releaseTool();
    await runtime.flushPendingMessage("s1", runtimeQueuedCount);

    await waitForRuntime(() => runtimeTab.agentSession.isStreaming === false);

    // The user's expectation: Esc aborts the in-flight tool turn and the queued
    // message runs as a fresh turn that actually gets an assistant response.
    const echoed = runtimeTab.chat.some(
      (line) => line.role === "assistant" && line.text.includes("Echo: please also do this"),
    );
    assert.ok(
      echoed,
      `queued message produced no assistant response. streamFn saw: ${JSON.stringify(seen)}; ` +
        `pendingMessages=${JSON.stringify(tab.pendingMessages)} queuedPromptCount=${runtimeTab.queuedPromptCount}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
