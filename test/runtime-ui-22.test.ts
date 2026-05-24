import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  Type,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  AuthStorage,
  getMarkdownTheme,
  ModelRegistry,
  SettingsManager,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  Text,
  TUI,
  visibleWidth,
  type AutocompleteProvider,
  type Component,
  type OverlayOptions,
  type Terminal,
} from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
  MIXCODE_KEYMAP,
  describeScopedKeymap,
  describeKeymap,
  handleSubmittedInput,
  mixcodeFauxStream,
  padLine,
  renderChat,
  renderCommandPalette,
  renderConfig,
  renderExportChooser,
  renderExportText,
  renderSystemToolsText,
  renderExtensionFooter,
  renderExtensionHeader,
  renderExtensionWidgets,
  renderHeader,
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderSidebar,
  renderStatus,
  renderTabBar,
  renderTabJumpOverlay,
  renderThinking,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
  titledBox,
  themeForId,
} from "../src/index.js";

function delayedAssistantStream(text: string, ready: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message = runtimeAssistantMessage(`Echo: ${text}`);
    await ready;
    if (options?.signal?.aborted) {
      const aborted = {
        ...message,
        content: [],
        stopReason: "aborted" as const,
        errorMessage: "Request was aborted",
      };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({
      type: "text_start",
      contentIndex: 0,
      partial: { ...message, content: [{ type: "text", text: "" }] },
    });
    stream.push({
      type: "text_delta",
      contentIndex: 0,
      delta: message.content[0]!.text,
      partial: message,
    });
    stream.push({
      type: "text_end",
      contentIndex: 0,
      content: message.content[0]!.text,
      partial: message,
    });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

function runtimeAssistantMessage(text: string): AssistantMessage {
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

function lastRuntimeUserText(context: Context): string {
  for (const message of [...context.messages].reverse()) {
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : "[image]"))
      .join("\n");
  }
  return "";
}

async function waitForRuntime(predicate: () => boolean, attempts = 25): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(predicate(), true);
}

async function waitFor(predicate: () => boolean, attempts = 25): Promise<void> {
  await waitForRuntime(predicate, attempts);
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
  anyRuntime.applyEvent(runtimeTab, {
    type: "auto_retry_start",
    attempt: 2,
    maxAttempts: 3,
    errorMessage: "rate limited",
  });
  anyRuntime.applyEvent(runtimeTab, { type: "auto_retry_end", success: true });
  anyRuntime.applyEvent(runtimeTab, { type: "auto_retry_end", success: false });
  anyRuntime.applyEvent(runtimeTab, {
    type: "auto_retry_end",
    success: false,
    finalError: "provider exhausted retries",
  });
  assert.equal(tab.title, "Renamed Session");
  assert.equal(tab.thinkingLevel, "high");
  assert.ok(runtimeTab.chat.some((line) => line.text.includes("Compaction started (manual)")));
  assert.ok(
    runtimeTab.chat.some((line) => line.text.includes("Compaction failed: compact failed")),
  );
  assert.ok(runtimeTab.chat.some((line) => line.text.includes("Retry 2/3: rate limited")));
  assert.ok(runtimeTab.chat.some((line) => line.text.includes("Retry failed: unknown error")));
  assert.ok(
    runtimeTab.chat.some((line) => line.text.includes("Retry failed: provider exhausted retries")),
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
  assert.equal(tab.pendingDialogs.length, 0);
  assert.equal(runtimeTab.reasoning.filter((line) => line.includes("think")).length, 1);
  assert.ok(runtimeTab.reasoning.join("\n").includes("think more"));
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
  assert.equal(tab.previewMessages.at(-1)?.text, "Agent finished without a response.");
});

test("runtime aborts an active pi agent run", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyAgent = runtimeTab.agent as unknown as {
    _state: { isStreaming: boolean };
    abort: () => void;
  };
  let aborted = false;
  anyAgent._state.isStreaming = true;
  anyAgent.abort = () => {
    aborted = true;
    anyAgent._state.isStreaming = false;
  };
  tab.pendingEscapeAction = "abort-agent";
  assert.equal(runtime.abortTab("s1"), true);
  assert.equal(aborted, true);
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.ok(runtimeTab.chat.some((line) => line.text.includes("Abort requested")));
  assert.equal(runtime.abortTab("s1"), false);
});
