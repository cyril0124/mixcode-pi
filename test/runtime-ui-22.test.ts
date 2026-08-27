import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { MixCodeRuntime, createTab } from "./helpers/mixcode.js";

test("runtime maps tool and thinking events into tab UI state", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  anyRuntime.applyEvent(runtimeTab, { type: "turn_start" });
  assert.equal(tab.status, "thinking");
  assert.match(tab.workingStartedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  anyRuntime.applyEvent(runtimeTab, { type: "compaction_start", reason: "manual" });
  assert.equal(tab.status, "running");
  assert.match(tab.workingStartedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
  anyRuntime.applyEvent(runtimeTab, { type: "compaction_end" });
  assert.equal(tab.status, "idle");
  assert.equal(tab.workingStartedAt, undefined);
  anyRuntime.applyEvent(runtimeTab, { type: "compaction_end", errorMessage: "compact failed" });
  assert.equal(tab.status, "error");
  anyRuntime.applyEvent(runtimeTab, { type: "turn_start" });
  assert.equal(tab.status, "thinking");
  anyRuntime.applyEvent(runtimeTab, { type: "session_info_changed" });
  anyRuntime.applyEvent(runtimeTab, { type: "session_info_changed", name: "Renamed Session" });
  anyRuntime.applyEvent(runtimeTab, { type: "thinking_level_changed", level: "high" });
  const startedAtBeforeRetry = tab.workingStartedAt;
  anyRuntime.applyEvent(runtimeTab, {
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    delayMs: 4000,
    errorMessage: "rate limited",
  });
  assert.equal(tab.status, "thinking", "status should remain thinking during retry");
  assert.equal(
    tab.workingStartedAt,
    startedAtBeforeRetry,
    "workingStartedAt should be preserved during retry",
  );
  anyRuntime.applyEvent(runtimeTab, { type: "auto_retry_end", success: true });
  assert.equal(tab.status, "thinking", "successful retry keeps the working state");
  anyRuntime.applyEvent(runtimeTab, { type: "auto_retry_end", success: false });
  // A failed/cancelled retry has no continuation: the working state closes.
  assert.equal(tab.status, "idle", "failed retry closes the working state");
  assert.equal(tab.workingStartedAt, undefined);
  anyRuntime.applyEvent(runtimeTab, {
    type: "auto_retry_end",
    success: false,
    finalError: "provider exhausted retries",
  });
  assert.equal(tab.status, "idle", "already-closed state stays idle");
  // Re-enter the working state for the tool-event assertions below.
  anyRuntime.applyEvent(runtimeTab, { type: "turn_start" });
  assert.equal(tab.title, "Renamed Session");
  assert.equal(tab.thinkingLevel, "high");
  // Compaction progress and in-flight retry countdown use the working loader
  // (Pi StatusIndicator), not chat lines. Only terminal failures stay in chat.
  assert.ok(!runtimeTab.chat.some((line) => line.text.includes("Compaction started")));
  assert.ok(!runtimeTab.chat.some((line) => line.text.includes("Error: Retry 2/3")));
  assert.ok(
    runtimeTab.chat.some((line) => line.text.includes("Compaction failed: compact failed")),
  );
  assert.ok(
    runtimeTab.chat.some((line) => line.text.includes("Error: Retry failed: unknown error")),
  );
  assert.ok(
    runtimeTab.chat.some((line) =>
      line.text.includes("Error: Retry failed: provider exhausted retries"),
    ),
  );
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "think" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "think", partial: {} },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "thinking", thinking: "think more" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: " more", partial: {} },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "not thinking" }],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    },
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "ignored",
      partial: {},
    },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_start",
    toolCallId: "1",
    toolName: "todo_write",
    args: {},
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_update",
    toolCallId: "1",
    toolName: "todo_write",
    args: {},
    partialResult: {},
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_update",
    toolCallId: "8",
    toolName: "bash",
    args: {},
    partialResult: "line-1\nline-2\nline-3\nline-4\nline-5",
  });
  const circular: Record<string, unknown> = { name: "circular" };
  circular.self = circular;
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_update",
    toolCallId: "9",
    toolName: "bash",
    args: {},
    partialResult: circular,
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_update",
    toolCallId: "10",
    toolName: "read",
    args: {},
    partialResult: { content: [], details: {}, isError: false },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "1",
    toolName: "todo_write",
    result: {
      details: { todos: [{ id: "t1", content: "Do it", status: "in_progress", priority: "high" }] },
    },
    isError: false,
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "2",
    toolName: "bash",
    result: {},
    isError: true,
  });
  anyRuntime.applyEvent(runtimeTab, { type: "turn_end", message: {}, toolResults: [] });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_start",
    toolCallId: "tc",
    toolName: "read",
    args: { path: "tool.txt" },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "tc",
    toolName: "read",
    result: { content: [{ type: "text", text: "tool text" }] },
    isError: false,
  });
  assert.equal(tab.status, "thinking");
  assert.ok(
    runtimeTab.chat.some((line) => line.role === "thinking" && line.text.includes("think more")),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "todo_write" && line.status === "success",
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "bash" && line.status === "error",
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "read" && line.text.includes("tool text"),
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "bash" && line.text.includes("line-1"),
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) =>
        line.role === "tool" && line.title === "bash" && line.text.includes("[object Object]"),
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "read" && line.text.includes("ok"),
    ),
  );
  tab.workingStartedAt = "not a date";
  anyRuntime.applyEvent(runtimeTab, { type: "agent_end" });
  assert.equal(tab.workingStartedAt, undefined);
  assert.equal(tab.lastWorkedDurationSeconds, undefined);
});

test("runtime surfaces an empty agent run as a system message", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  anyRuntime.applyEvent(runtimeTab, { type: "agent_start" });
  anyRuntime.applyEvent(runtimeTab, { type: "agent_end" });
  assert.equal(runtimeTab.chat.at(-1)?.role, "system");
  assert.equal(runtimeTab.chat.at(-1)?.text, "Agent finished without a response.");
});

test("runtime aborts an active pi agent run", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const mutableSession = runtimeTab.agentSession as unknown as { _isAgentRunActive: boolean };
  const anyAgent = runtimeTab.agentSession.agent as unknown as { abort: () => void };
  let aborted = false;
  mutableSession._isAgentRunActive = true;
  anyAgent.abort = () => {
    aborted = true;
    mutableSession._isAgentRunActive = false;
  };
  tab.pendingEscapeArmedAt = 1_700_000_000_000;
  assert.equal(runtime.abortTab("s1"), true);
  assert.equal(aborted, true);
  assert.equal(tab.pendingEscapeArmedAt, undefined);
  assert.ok(runtimeTab.chat.some((line) => line.text.includes("Abort requested")));
  assert.equal(runtime.abortTab("s1"), false);
});

test("runtime abortTab aborts standalone user bash (Pi Esc parity)", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  let bashAborted = false;
  const session = runtimeTab.agentSession as unknown as {
    isStreaming: boolean;
    isBashRunning: boolean;
    abortBash: () => void;
  };
  Object.defineProperty(session, "isStreaming", { get: () => false, configurable: true });
  Object.defineProperty(session, "isBashRunning", { get: () => !bashAborted, configurable: true });
  session.abortBash = () => {
    bashAborted = true;
  };
  tab.pendingEscapeArmedAt = 1_700_000_000_000;
  tab.status = "running";

  assert.equal(runtime.abortTab("s1"), true);
  assert.equal(bashAborted, true);
  assert.equal(tab.pendingEscapeArmedAt, undefined);
});
