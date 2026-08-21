import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { MixCodeTabInfo } from "../src/core/types.js";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ToolCall,
} from "@earendil-works/pi-ai";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  type RuntimeTab,
  createTab,
  parseInput,
  renderQueuePreview,
} from "./helpers/mixcode.js";

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
    api: "follow-up-test",
    provider: "follow-up-test",
    model: "follow-up-model",
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
    api: "follow-up-test",
    provider: "follow-up-test",
    model: "follow-up-model",
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
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
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

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

async function withSlowToolRuntime(
  run: (ctx: {
    runtime: MixCodeRuntime;
    tab: MixCodeTabInfo;
    runtimeTab: RuntimeTab;
    releaseTool: () => void;
    toolRunning: Promise<void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-up-"));
  try {
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    let toolStarted!: () => void;
    const toolRunning = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });

    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "follow-up-test",
      api: "follow-up-test",
      id: "follow-up-model",
    };

    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
        const text = lastUserText(context);
        if (text === "do work") {
          return streamMessage(
            toolCallMessage({ type: "toolCall", id: "tc-1", name: "slow_tool", arguments: {} }),
            options,
          );
        }
        return streamMessage(textMessage(`Echo: ${text}`), options);
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "slow_tool",
            label: "Slow Tool",
            description: "Blocks until released.",
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

    await run({ runtime, tab, runtimeTab, releaseTool, toolRunning });
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
}

test("parseInput recognizes /follow-up as a local command", () => {
  const parsed = parseInput("/follow-up after done summarize");
  assert.equal(parsed.kind, "local-command");
  assert.equal(parsed.command, "follow-up");
  assert.equal(parsed.args, "after done summarize");
});

test("streaming steer and followUp land in separate queues and dual UI", async () => {
  await withSlowToolRuntime(async ({ runtime, tab, runtimeTab, releaseTool, toolRunning }) => {
    // Fire-and-forget turn; the tool blocks until releaseTool() below. The
    // deferred flush can race the test's final tmpdir cleanup under bun (the
    // process no longer owns the directory when the trailing append lands), so
    // surface-but-ignore the rejection instead of leaving it unhandled.
    void runtime.prompt("s1", "do work").catch(() => {});
    await toolRunning;
    assert.equal(runtimeTab.agentSession.isStreaming, true);

    await runtime.prompt("s1", "steer now");
    await runtime.prompt("s1", "follow later", { streamingBehavior: "followUp" });

    await waitForRuntime(
      () =>
        tab.pendingMessages.includes("steer now") && tab.pendingFollowUps.includes("follow later"),
    );

    assert.deepEqual(tab.pendingMessages, ["steer now"]);
    assert.deepEqual(tab.pendingFollowUps, ["follow later"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
    assert.equal(runtimeTab.queuedFollowUpCount, 1);
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], ["steer now"]);
    assert.deepEqual([...runtimeTab.agentSession.getFollowUpMessages()], ["follow later"]);

    const preview = stripAnsi(renderQueuePreview(tab, 80).join("\n"));
    assert.match(preview, /Steer \(1\)/);
    assert.match(preview, /Follow-up \(1\)/);
    assert.match(preview, /steer now/);
    assert.match(preview, /follow later/);
    const followBlock = preview.slice(preview.indexOf("Follow-up"));
    assert.doesNotMatch(followBlock, /Esc->send now/);

    releaseTool();
  });
});

test("explicit Follow-up pop leaves Steer queued", async () => {
  await withSlowToolRuntime(async ({ runtime, tab, runtimeTab, releaseTool, toolRunning }) => {
    // Fire-and-forget turn; the tool blocks until releaseTool() below. The
    // deferred flush can race the test's final tmpdir cleanup under bun (the
    // process no longer owns the directory when the trailing append lands), so
    // surface-but-ignore the rejection instead of leaving it unhandled.
    void runtime.prompt("s1", "do work").catch(() => {});
    await toolRunning;

    await runtime.prompt("s1", "steer now");
    await runtime.prompt("s1", "follow later", { streamingBehavior: "followUp" });
    await waitForRuntime(
      () => tab.pendingMessages.length === 1 && tab.pendingFollowUps.length === 1,
    );

    const popped = runtime.popPendingMessage("s1", "followUp");
    assert.equal(popped, "follow later");
    assert.deepEqual(tab.pendingFollowUps, []);
    assert.deepEqual(tab.pendingMessages, ["steer now"]);
    assert.equal(runtimeTab.queuedFollowUpCount, 0);
    assert.equal(runtimeTab.queuedPromptCount, 1);

    releaseTool();
  });
});

test("flushPendingMessage only drains steer; follow-up survives abort+flush", async () => {
  await withSlowToolRuntime(async ({ runtime, tab, runtimeTab, releaseTool, toolRunning }) => {
    // Fire-and-forget turn; the tool blocks until releaseTool() below. The
    // deferred flush can race the test's final tmpdir cleanup under bun (the
    // process no longer owns the directory when the trailing append lands), so
    // surface-but-ignore the rejection instead of leaving it unhandled.
    void runtime.prompt("s1", "do work").catch(() => {});
    await toolRunning;

    await runtime.prompt("s1", "steer now");
    await runtime.prompt("s1", "follow later", { streamingBehavior: "followUp" });
    await waitForRuntime(
      () => tab.pendingMessages.length === 1 && tab.pendingFollowUps.length === 1,
    );

    const steerCount = runtimeTab.queuedPromptCount;
    runtime.abortTab("s1");
    releaseTool();
    await runtime.flushPendingMessage("s1", steerCount);

    // Follow-up must not have been flushed as steer text.
    assert.ok(
      tab.pendingFollowUps.includes("follow later") ||
        runtimeTab.chat.some(
          (line) => line.role === "user" && line.text.includes("follow later"),
        ) ||
        runtimeTab.chat.some(
          (line) => line.role === "assistant" && line.text.includes("Echo: follow later"),
        ),
      `follow-up lost. pendingFollowUps=${JSON.stringify(tab.pendingFollowUps)} chat=${JSON.stringify(
        runtimeTab.chat.map((l) => ({ role: l.role, text: l.text?.slice?.(0, 80) })),
      )}`,
    );
    // Steer should not still be sitting in the steer queue after flush.
    assert.equal(tab.pendingMessages.includes("steer now"), false);
  });
});

test("abortAllTabs clears both queues", async () => {
  await withSlowToolRuntime(async ({ runtime, tab, runtimeTab, releaseTool, toolRunning }) => {
    // Fire-and-forget turn; the tool blocks until releaseTool() below. The
    // deferred flush can race the test's final tmpdir cleanup under bun (the
    // process no longer owns the directory when the trailing append lands), so
    // surface-but-ignore the rejection instead of leaving it unhandled.
    void runtime.prompt("s1", "do work").catch(() => {});
    await toolRunning;
    await runtime.prompt("s1", "steer now");
    await runtime.prompt("s1", "follow later", { streamingBehavior: "followUp" });
    await waitForRuntime(
      () => tab.pendingMessages.length === 1 && tab.pendingFollowUps.length === 1,
    );

    runtime.abortAllTabs();
    assert.deepEqual(tab.pendingMessages, []);
    assert.deepEqual(tab.pendingFollowUps, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
    assert.equal(runtimeTab.queuedFollowUpCount, 0);
    releaseTool();
  });
});
