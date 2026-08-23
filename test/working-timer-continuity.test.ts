import "./helpers/isolated-agent-dir.js";
// Working-timer continuity across perceived-continuous work.
//
// The spinner elapsed time is derived solely from tab.workingStartedAt
// (src/ui/rendering/chrome.ts formatElapsed). The invariant under test:
// the timer restarts only when the agent actually stopped and a fresh run
// begins; SDK-driven continuations of one user prompt must keep the stamp:
//   - auto-retry continuation (agent_end -> auto_retry_start -> continue)
//   - compact-and-retry continuation (compaction_end willRetry -> continue)
//   - multi-turn tool loops within a single run
//   - a `!shell` command must not clobber a streaming run's timer
//
// These tests drive a real AgentSession through MixCodeRuntime with an
// injected streamFn, so the event sequences are the SDK's own.

import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type ToolCall,
} from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab, type MixCodeModel } from "./helpers/mixcode.js";

function waitForRuntime(predicate: () => boolean, attempts = 200): Promise<void> {
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

function assistantText(text: string, totalTokens = 2): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "timer-test",
    provider: "timer-test",
    model: "timer-test-model",
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

function assistantError(errorMessage: string): AssistantMessage {
  return { ...assistantText(""), content: [], stopReason: "error", errorMessage };
}

function assistantToolCall(toolCall: ToolCall): AssistantMessage {
  return { ...assistantText(""), content: [toolCall], stopReason: "toolUse" };
}

function streamMessage(message: AssistantMessage): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    const first = message.content[0];
    if (first?.type === "toolCall") {
      stream.push({ type: "toolcall_start", contentIndex: 0, partial: message });
      stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: first, partial: message });
    } else if (first?.type === "text") {
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] },
      });
      stream.push({ type: "text_delta", contentIndex: 0, delta: first.text, partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: first.text, partial: message });
    }
    const reason =
      message.stopReason === "toolUse" ? "toolUse" : message.stopReason === "error" ? "error" : "stop";
    stream.push({ type: "done", reason, message } as never);
    stream.end(message);
  });
  return stream;
}

function lastUserText(context: Context): string {
  const last = context.messages.filter((m) => m.role === "user").at(-1);
  if (!last || !("content" in last)) return "";
  if (typeof last.content === "string") return last.content;
  return last.content.map((b) => (b.type === "text" ? b.text : "")).join("\n");
}

type TraceEntry = { type: string; status: string; workingStartedAt: string | undefined };

const TIMER_MODEL: MixCodeModel = {
  ...MIXCODE_FAUX_MODEL,
  provider: "timer-test",
  api: "timer-test",
  id: "timer-test-model",
  contextWindow: 1000,
};

function timerTabConfig() {
  return {
    model: {
      provider: TIMER_MODEL.provider,
      modelId: TIMER_MODEL.id,
      displayName: `${TIMER_MODEL.provider}/${TIMER_MODEL.id}`,
      contextWindow: TIMER_MODEL.contextWindow,
    },
    contextLimit: 1000,
  };
}

function traceRuntime(runtime: MixCodeRuntime, sessionId: string): TraceEntry[] {
  const trace: TraceEntry[] = [];
  runtime.onChange((event, changedTab) => {
    if (changedTab.tab.sessionId !== sessionId) return;
    trace.push({
      type: (event as { type: string }).type,
      status: changedTab.tab.status,
      workingStartedAt: changedTab.tab.workingStartedAt,
    });
  });
  return trace;
}

test("session-start turn is shown as running after runtime subscription", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-startup-"));
  const message = assistantText("startup turn done");
  const stream = createAssistantMessageEventStream();
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => stream,
      extensionFactories: [
        (pi) => {
          pi.on("session_start", (_event, ctx) => {
            if (!ctx.hasUI) return;
            pi.sendMessage(
              { customType: "startup-turn", content: "continue", display: false },
              { triggerTurn: true, deliverAs: "followUp" },
            );
          });
        },
      ],
    });
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    const trace = traceRuntime(runtime, "s1");
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });

    try {
      assert.equal(runtimeTab.agentSession.isStreaming, true);
      assert.equal(trace.find((entry) => entry.type === "agent_start")?.status, "running");
      assert.ok(tab.workingStartedAt);
    } finally {
      stream.push({ type: "start", partial: { ...message, content: [] } });
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
      await runtimeTab.agentSession.waitForIdle();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("auto-retry continuation preserves the working timer stamp", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-retry-"));
  try {
    let call = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => {
        call += 1;
        return streamMessage(call === 1 ? assistantError("overloaded") : assistantText("ok"));
      },
    });
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });
    runtimeTab.agentSession.settingsManager.getRetrySettings = () => ({
      enabled: true,
      maxRetries: 2,
      baseDelayMs: 30,
    });
    const trace = traceRuntime(runtime, "s1");

    await runtime.prompt("s1", "hello");
    await waitForRuntime(() => tab.status === "idle" && call >= 2);

    const starts = trace.filter((t) => t.type === "agent_start");
    const retryStart = trace.find((t) => t.type === "auto_retry_start");
    assert.equal(starts.length, 2);
    assert.ok(starts[0]!.workingStartedAt);
    // auto_retry_start restores the stamp closed by agent_end...
    assert.equal(retryStart?.workingStartedAt, starts[0]!.workingStartedAt);
    // ...and the continuation run keeps it instead of restarting the clock.
    assert.equal(starts[1]!.workingStartedAt, starts[0]!.workingStartedAt);
    // The final duration covers the whole wall-clock span, including retry wait.
    assert.ok(tab.lastWorkedDurationSeconds !== undefined);
    assert.equal(tab.workingStartedAt, undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("overflow compact-and-retry continuation preserves the working timer stamp", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-overflow-"));
  try {
    let overflowFired = false;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      agentDir: dir,
      streamFn: (_model: MixCodeModel, context: Context) => {
        const text = lastUserText(context);
        if (text.includes("start") && !overflowFired) {
          overflowFired = true;
          return streamMessage(assistantError("prompt is too long: 1200 tokens > 1000 maximum"));
        }
        return streamMessage(
          assistantText(text.includes("warmup") ? `warmup ${"filler ".repeat(30)}` : "continued"),
        );
      },
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            await Bun.sleep(10);
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
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    const trace = traceRuntime(runtime, "s1");

    // Warmup gives the compactor history to summarize.
    await runtime.prompt("s1", "warmup");
    await waitForRuntime(() => tab.status === "idle");
    trace.length = 0;

    await runtime.prompt("s1", "start");
    await waitForRuntime(
      () => {
        const branch = runtimeTab.session.getBranch();
        const compactIdx = branch.findLastIndex((e) => e.type === "compaction");
        return (
          tab.status === "idle" &&
          compactIdx >= 0 &&
          branch.slice(compactIdx + 1).some((e) => e.type === "message")
        );
      },
    );

    const starts = trace.filter((t) => t.type === "agent_start");
    const compactionStart = trace.find((t) => t.type === "compaction_start");
    const compactionEnd = trace.find((t) => t.type === "compaction_end");
    assert.equal(starts.length, 2);
    assert.ok(starts[0]!.workingStartedAt);
    // The stamp survives the whole compact-and-retry cycle:
    assert.equal(compactionStart?.workingStartedAt, starts[0]!.workingStartedAt);
    // compaction_end with willRetry keeps the run alive instead of closing it...
    assert.equal(compactionEnd?.status, "running");
    assert.equal(compactionEnd?.workingStartedAt, starts[0]!.workingStartedAt);
    // ...and the continuation run keeps counting from the original stamp.
    assert.equal(starts[1]!.workingStartedAt, starts[0]!.workingStartedAt);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("multi-turn tool loop keeps one stamp for the whole run", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-control-"));
  try {
    let toolIssued = false;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => {
        if (!toolIssued) {
          toolIssued = true;
          return streamMessage(
            assistantToolCall({ type: "toolCall", id: "tc-1", name: "echo_tool", arguments: { text: "x" } }),
          );
        }
        return streamMessage(assistantText("done"));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "echo_tool",
            label: "Echo",
            description: "test tool",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_id, params) => {
              await Bun.sleep(15);
              return { content: [{ type: "text", text: `echo:${params.text}` }], details: params };
            },
          });
        },
      ],
    });
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });
    // Keep compaction thresholds loose relative to the tiny test context window
    // so this case measures timer continuity, not auto-compact side effects.
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 50 },
    });
    const trace = traceRuntime(runtime, "s1");

    await runtime.prompt("s1", "go");
    await waitForRuntime(() => tab.status === "idle" && toolIssued);

    const starts = trace.filter((t) => t.type === "agent_start");
    const turnStarts = trace.filter((t) => t.type === "turn_start");
    assert.equal(starts.length, 1);
    assert.ok(turnStarts.length >= 2);
    const stamp = starts[0]!.workingStartedAt;
    assert.ok(stamp);
    for (const t of turnStarts) assert.equal(t.workingStartedAt, stamp);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("cancelling a retry countdown records the worked duration", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-retry-cancel-"));
  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => streamMessage(assistantError("overloaded")),
    });
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });
    // Long countdown so the abort lands deterministically inside the wait.
    runtimeTab.agentSession.settingsManager.getRetrySettings = () => ({
      enabled: true,
      maxRetries: 3,
      baseDelayMs: 10_000,
    });

    const promptDone = runtime.prompt("s1", "hello");
    await waitForRuntime(() => tab.retryInfo !== undefined);
    // The retry restore keeps the timer alive during the countdown.
    assert.ok(tab.workingStartedAt);

    runtime.abortTab("s1");
    await waitForRuntime(() => tab.status === "idle" && tab.retryInfo === undefined);
    await promptDone;

    // Cancelled retry closes the timer into a duration (abortTab precedent).
    assert.equal(tab.workingStartedAt, undefined);
    assert.ok(tab.lastWorkedDurationSeconds !== undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("!shell during a streaming run does not clobber the agent timer", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-shell-"));
  try {
    let releaseRun!: () => void;
    const releaseRunPromise = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: () => {
        const message = assistantText("slow answer");
        const stream = createAssistantMessageEventStream();
        void (async () => {
          stream.push({ type: "start", partial: { ...message, content: [] } });
          await releaseRunPromise;
          stream.push({ type: "text_start", contentIndex: 0, partial: message });
          stream.push({ type: "text_end", contentIndex: 0, content: "slow answer", partial: message });
          stream.push({ type: "done", reason: "stop", message } as never);
          stream.end(message);
        })();
        return stream;
      },
    });
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });

    const promptDone = runtime.prompt("s1", "go");
    await waitForRuntime(() => tab.workingStartedAt !== undefined);
    const agentStamp = tab.workingStartedAt;

    await runtime.executeShellCommand("s1", "echo shell-ok");
    // The streaming run still owns the status and the stamp.
    assert.notEqual(tab.status, "idle");
    assert.equal(tab.workingStartedAt, agentStamp);

    releaseRun();
    await promptDone;
    await waitForRuntime(() => tab.status === "idle");
    assert.equal(tab.workingStartedAt, undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("!shell from idle still stamps and closes its own timer", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-timer-shell-idle-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd(), timerTabConfig());
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: TIMER_MODEL,
    });

    await runtime.executeShellCommand("s1", "echo shell-ok");
    assert.equal(tab.status, "idle");
    assert.equal(tab.workingStartedAt, undefined);
    assert.ok(tab.lastWorkedDurationSeconds !== undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
