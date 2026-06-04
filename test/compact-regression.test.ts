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
  type ToolCall,
} from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab } from "../src/index.js";

function waitForRuntime(predicate: () => boolean, attempts = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempt = 0;
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      attempt += 1;
      if (attempt >= attempts) {
        reject(new Error("Timed out waiting for runtime condition"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function delay(ms: number): Promise<"pending"> {
  return new Promise((resolve) => setTimeout(() => resolve("pending"), ms));
}

function runtimeAssistantMessage(text: string, totalTokens = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "compact-test",
    provider: "compact-test",
    model: "compact-test-model",
    usage: {
      input: Math.max(1, totalTokens - 1),
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function runtimeToolCallMessage(toolCall: ToolCall, totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [toolCall],
    api: "compact-test",
    provider: "compact-test",
    model: "compact-test-model",
    usage: {
      input: totalTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function streamAssistantMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
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

function textContent(message: Context["messages"][number]): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

test("SDK post-run compaction preserves the original working timer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-compact-working-timer-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const applyRuntimeEvent = (runtime as unknown as {
      applyEvent: (target: unknown, event: unknown) => void;
    }).applyEvent.bind(runtime);
    const startedAt = "2026-06-04T00:00:00.000Z";
    tab.status = "running";
    tab.workingStartedAt = startedAt;

    applyRuntimeEvent(runtimeTab, { type: "agent_end", messages: [], willRetry: false });
    assert.equal(tab.workingStartedAt, undefined);

    applyRuntimeEvent(runtimeTab, { type: "compaction_start", reason: "threshold" });
    assert.equal(tab.status, "running");
    assert.equal(tab.workingStartedAt, startedAt);
    assert.equal(tab.lastWorkedDurationSeconds, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("pre-prompt auto-compaction starts a fresh working timer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-compact-pre-prompt-timer-"));
  try {
    let releaseCompact!: () => void;
    const releaseCompactPromise = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    let firstRunStartedAt: string | undefined;
    let compactionStartedAt: string | undefined;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => streamAssistantMessage(runtimeAssistantMessage("ok", 90)),
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            await releaseCompactPromise;
            return {
              compaction: {
                summary: "auto summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "compact-test",
      api: "compact-test",
      id: "compact-test-model",
      contextWindow: 100,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 100,
    });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    runtime.onChange((event, changedTab) => {
      if (changedTab.tab.sessionId !== "s1") return;
      if (event.type === "agent_start" && !firstRunStartedAt) {
        firstRunStartedAt = changedTab.tab.workingStartedAt;
      }
      if (event.type === "compaction_start" && !compactionStartedAt) {
        compactionStartedAt = changedTab.tab.workingStartedAt;
      }
    });

    await runtime.prompt("s1", "first");
    await delay(25);
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 1 },
    });
    const secondPrompt = runtime.prompt("s1", "second");
    try {
      await waitForRuntime(() => Boolean(compactionStartedAt));
      assert.ok(firstRunStartedAt);
      assert.ok(compactionStartedAt);
      assert.notEqual(compactionStartedAt, firstRunStartedAt);
    } finally {
      releaseCompact();
      await secondPrompt;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects a second manual compaction while one is running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-compact-concurrent-"));
  try {
    let releaseCompact!: () => void;
    const releaseCompactPromise = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            await releaseCompactPromise;
            return {
              compaction: {
                summary: "manual summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
    });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "hello");

    const firstStarted = new Promise<void>((resolve) => {
      const unsubscribe = runtime.onChange((event) => {
        if (event.type !== "compaction_start") return;
        unsubscribe();
        resolve();
      });
    });
    const firstCompact = runtime.compactSession("s1");
    await firstStarted;

    const secondCompact = runtime.compactSession("s1").then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
    const secondResult = await Promise.race([secondCompact, delay(25)]);

    releaseCompact();
    await Promise.allSettled([firstCompact, secondCompact]);

    assert.match(secondResult, /Cannot compact while compaction is running/);
    assert.equal(runtimeTab.session.getBranch().filter((entry) => entry.type === "compaction").length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects manual compaction while the agent is streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-compact-streaming-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "hello");

    const mutableAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };
    mutableAgent._state.isStreaming = true;
    try {
      await assert.rejects(
        () => runtime.compactSession("s1"),
        /Cannot compact while the agent is streaming/,
      );
    } finally {
      mutableAgent._state.isStreaming = false;
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mid-turn auto-compaction keeps running state until continuation finishes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-compact-auto-state-"));
  try {
    const seenContexts: Context[] = [];
    const compactionEndStates: Array<{ status: string; unreadDone: boolean }> = [];
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context) => {
        seenContexts.push(context);
        if (seenContexts.length === 1) {
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-auto", name: "auto_echo", arguments: { text: "first" } },
              90,
            ),
          );
        }
        return streamAssistantMessage(runtimeAssistantMessage("continued"));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for auto-compaction state.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "auto summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "compact-test",
      api: "compact-test",
      id: "compact-test-model",
      contextWindow: 100,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 100,
    });
    tab.contextLimitOverridden = true;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 1 },
    });
    runtime.onChange((event, changedTab) => {
      if (event.type !== "compaction_end" || changedTab.tab.sessionId !== "s1") return;
      compactionEndStates.push({ status: changedTab.tab.status, unreadDone: changedTab.tab.unreadDone });
    });

    await runtime.prompt("s1", "start");
    await waitForRuntime(() =>
      seenContexts.length >= 2 && runtimeTab.session.getBranch().at(-1)?.type === "message",
    );

    assert.deepEqual(compactionEndStates, [{ status: "running", unreadDone: false }]);
    const continuedMessages = seenContexts[1]!.messages;
    assert.ok(continuedMessages.some((message) => message.role === "toolResult" && textContent(message).includes("tool:first")));
    assert.equal(tab.status, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
