import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type ToolCall,
} from "@earendil-works/pi-ai";
import type { ContextUsage } from "@earendil-works/pi-coding-agent";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  renderWorkingIndicator,
  type MixCodeModel,
} from "./helpers/mixcode.js";
import { syncContextUsage } from "../src/agent/runtime-chat.js";
import { contextBarAndPercentText, exactContextUsageText } from "../src/ui/rendering/chrome.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

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

function streamAssistantMessage(message: AssistantMessage, ready?: Promise<void>) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    if (ready) await ready;
    stream.push({ type: "start", partial: { ...message, content: [] } });
    const firstContent = message.content[0];
    if (firstContent?.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: firstContent,
        partial: message,
      });
    } else if (firstContent?.type === "text") {
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: firstContent.text,
        partial: message,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: firstContent.text,
        partial: message,
      });
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

function textContent(message: Context["messages"][number]): string {
  if (!("content" in message)) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
}

function lastRuntimeUserText(context: Context): string {
  const users = context.messages.filter((message) => message.role === "user");
  const last = users.at(-1);
  return last ? textContent(last) : "";
}

test("SDK post-run compaction preserves the original working timer", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-compact-working-timer-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const applyRuntimeEvent = (
      runtime as unknown as {
        applyEvent: (target: unknown, event: unknown) => void;
      }
    ).applyEvent.bind(runtime);
    const startedAt = "2026-06-04T00:00:00.000Z";
    tab.status = "running";
    tab.workingStartedAt = startedAt;

    applyRuntimeEvent(runtimeTab, { type: "agent_end", messages: [], willRetry: false });
    assert.equal(tab.workingStartedAt, undefined);

    applyRuntimeEvent(runtimeTab, { type: "compaction_start", reason: "threshold" });
    assert.equal(tab.status, "running");
    assert.equal(tab.workingStartedAt, startedAt);
    assert.equal(tab.lastWorkedDurationSeconds, undefined);
    assert.match(
      renderWorkingIndicator(tab, 80, new Date("2026-06-04T00:00:03.000Z")).join("\n"),
      /Auto-compacting/,
    );

    applyRuntimeEvent(runtimeTab, { type: "compaction_end" });
    assert.doesNotMatch(
      renderWorkingIndicator(tab, 80, new Date("2026-06-04T00:00:04.000Z")).join("\n"),
      /Compacting/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("pre-prompt auto-compaction starts a fresh working timer", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-compact-pre-prompt-timer-"));
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
    const model: MixCodeModel = {
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects a second manual compaction while one is running", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-compact-concurrent-"));
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
    // Shrink the keep-recent window so the single "hello" turn is compactable
    // under SDK 0.80+ and the manual compaction actually starts.
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
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
    assert.equal(
      runtimeTab.session.getBranch().filter((entry) => entry.type === "compaction").length,
      1,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects manual compaction while the agent is streaming", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-compact-streaming-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "hello");

    const mutableSession = runtimeTab.agentSession as unknown as { _isAgentRunActive: boolean };
    mutableSession._isAgentRunActive = true;
    try {
      await assert.rejects(
        () => runtime.compactSession("s1"),
        /Cannot compact while the agent is streaming/,
      );
    } finally {
      mutableSession._isAgentRunActive = false;
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("core does not terminate a tool loop for mid-turn compaction pressure", async () => {
  // Core must not afterToolCall-terminate and private-continue when usage exceeds
  // the compaction threshold; only Pi-native turn-boundary/overflow paths compact.
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-compact-no-mid-turn-"));
  try {
    const seenContexts: Context[] = [];
    let toolCallTriggered = false;
    let postToolAssistantCalls = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: dir,
      streamFn: (_model: MixCodeModel, context: Context) => {
        seenContexts.push(context);
        if (context.messages.some((message) => message.role === "toolResult")) {
          postToolAssistantCalls += 1;
          return streamAssistantMessage(runtimeAssistantMessage("finished after tool"));
        }
        const text = lastRuntimeUserText(context);
        if (text === "start" && !toolCallTriggered) {
          toolCallTriggered = true;
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-auto", name: "auto_echo", arguments: { text: "first" } },
              990,
            ),
          );
        }
        return streamAssistantMessage(
          runtimeAssistantMessage(`warmup reply ${"history ".repeat(40)}`),
        );
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for no mid-turn terminate.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
        },
      ],
    });
    const model: MixCodeModel = {
      ...MIXCODE_FAUX_MODEL,
      provider: "compact-test",
      api: "compact-test",
      id: "compact-test-model",
      contextWindow: 1000,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 1000,
    });
    tab.contextLimitOverridden = true;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    // Pressure settings that put the tool boundary over the compaction threshold.
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 50 },
    });

    await runtime.prompt("s1", "warmup");
    await waitForRuntime(
      () => runtimeTab.session.getBranch().filter((entry) => entry.type === "message").length >= 2,
    );
    await runtime.prompt("s1", "start");
    await waitForRuntime(() => tab.status === "idle" && postToolAssistantCalls >= 1);

    // Tool loop completed in-process (assistant saw toolResult) without MixCode
    // private continue. Pi-native mid-run compaction fires at the tool boundary
    // (usage 990 > window 1000 - reserve 20) and writes a compaction entry.
    assert.ok(postToolAssistantCalls >= 1);
    assert.equal(
      runtimeTab.session.getBranch().some((entry) => entry.type === "compaction"),
      true,
    );
    assert.ok(
      seenContexts.some((context) =>
        context.messages.some(
          (message) => message.role === "toolResult" && textContent(message).includes("tool:first"),
        ),
      ),
    );
    assert.equal(tab.status, "idle");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

// Pi's interactive footer re-reads getContextUsage() every frame and prints `?`
// when tokens is null. MixCode caches the count on the tab, so the null must be
// written through or the meter keeps showing the stale pre-compaction number.
test("post-compaction null usage clears the meter until real usage returns", () => {
  const tab = createTab(1, "s1", "/repo", { currentContextTokens: 152_000, contextLimit: 200_000 });
  let usage: ContextUsage | undefined = { tokens: null, contextWindow: 200_000, percent: null };
  const runtimeTab = testRuntimeTab({
    tab,
    agentSession: { getContextUsage: () => usage },
  });

  syncContextUsage(runtimeTab);
  assert.equal(exactContextUsageText(tab), "?/200k");
  assert.match(stripAnsi(contextBarAndPercentText(tab, "ascii")), /\?%$/);

  usage = { tokens: 4_100, contextWindow: 200_000, percent: 2.05 };
  syncContextUsage(runtimeTab);
  assert.equal(exactContextUsageText(tab), "4.10k/200k");
  assert.match(stripAnsi(contextBarAndPercentText(tab, "ascii")), /2\.1%$/);
});

// A throw is "cannot compute", not "the number is void" — the two must not
// collapse into the same branch, or a degenerate history entry would blank the meter.
test("unavailable usage keeps the last known count", () => {
  const tab = createTab(1, "s1", "/repo", { currentContextTokens: 152_000, contextLimit: 200_000 });
  const runtimeTab = testRuntimeTab({
    tab,
    agentSession: {
      getContextUsage: () => {
        throw new Error("degenerate toolCall block");
      },
    },
  });

  syncContextUsage(runtimeTab);
  assert.equal(exactContextUsageText(tab), "152k/200k");
});
