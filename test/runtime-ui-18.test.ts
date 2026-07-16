import "./helpers/isolated-agent-dir.js";
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
  getMarkdownTheme,
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

test("runtime surfaces assistant error and abort stop reasons", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-stop-reasons-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const emptyAssistant = {
      role: "assistant" as const,
      content: [] as Array<
        | { type: "text"; text: string }
        | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
      >,
      api: "x" as const,
      provider: "x" as const,
      model: "x",
      usage,
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: { ...emptyAssistant, stopReason: "error" as const, errorMessage: "provider failed" },
    });
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.text.includes("Error: provider failed"),
      ),
    );

    const toolAbort = {
      ...emptyAssistant,
      content: [
        {
          type: "toolCall" as const,
          id: "tc-abort",
          name: "bash",
          arguments: { command: "sleep 10" },
        },
      ],
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...emptyAssistant, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: toolAbort,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    });
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: toolAbort });
    const abortedTool = runtimeTab.chat.find(
      (line) => line.role === "tool" && line.toolCallId === "tc-abort",
    );
    assert.equal(abortedTool?.status, "error");
    assert.match(abortedTool?.text ?? "", /Operation aborted/);

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: { ...emptyAssistant, stopReason: "error" as const },
    });
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.text.includes("Error: Unknown error"),
      ),
    );

    const customAbort = {
      ...toolAbort,
      content: [
        {
          type: "toolCall" as const,
          id: "tc-custom-abort",
          name: "bash",
          arguments: { command: "sleep 20" },
        },
      ],
      errorMessage: "User cancelled run",
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...emptyAssistant, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: customAbort,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    });
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: customAbort });
    const customAbortTool = runtimeTab.chat.find(
      (line) => line.role === "tool" && line.toolCallId === "tc-custom-abort",
    );
    assert.equal(customAbortTool?.text, "User cancelled run");

    const systemCount = runtimeTab.chat.filter((line) => line.role === "system").length;
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: {
        ...emptyAssistant,
        content: [{ type: "text" as const, text: "partial public answer" }],
        stopReason: "error" as const,
        errorMessage: "after text",
      },
    });
    assert.equal(runtimeTab.chat.filter((line) => line.role === "system").length, systemCount);

    const runningTool = {
      ...emptyAssistant,
      content: [
        {
          type: "toolCall" as const,
          id: "tc-error",
          name: "bash",
          arguments: { command: "sleep 30" },
        },
      ],
      stopReason: "error" as const,
      errorMessage: "tool failed",
    };
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...emptyAssistant, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: runningTool,
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    });
    const pendingIndex = runtimeTab.chat.findIndex(
      (line) => line.role === "tool" && line.toolCallId === "tc-error",
    );
    assert.notEqual(pendingIndex, -1);
    runtimeTab.chat[pendingIndex] = { role: "system", text: "not a tool anymore" };
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: runningTool });
    assert.equal(runtimeTab.chat[pendingIndex]?.role, "system");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps assistant thinking out of chat assistant text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-thinking-keep-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: dir });
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  const message = {
    role: "assistant" as const,
    content: [
      { type: "thinking" as const, thinking: "private chain of thought" },
      { type: "text" as const, text: "public answer" },
    ],
    api: "x" as const,
    provider: "x" as const,
    model: "x",
    usage,
    stopReason: "stop" as const,
    timestamp: Date.now(),
  };

  try {
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_start",
      message: { ...message, content: [] },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message,
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "private chain of thought",
        partial: {},
      },
    });
    anyRuntime.applyEvent(runtimeTab, { type: "message_end", message });

    // Thinking lands in chat as a dedicated thinking line, kept out of assistant text.
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["private chain of thought"],
    );
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "assistant").map((line) => line.text),
      ["public answer"],
    );
    assert.deepEqual(
      tab.previewMessages.filter((line) => line.role === "assistant").map((line) => line.text),
      ["public answer"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime streams thinking from partial assistant messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-thinking-stream-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: dir });
  const tab = createTab(1, "s1", process.cwd());
  try {
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyRuntime = runtime as unknown as {
      applyEvent: (runtimeTab: unknown, event: unknown) => void;
    };
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    const baseMessage = {
      role: "assistant" as const,
      content: [] as Array<{ type: "thinking"; thinking: string } | { type: "text"; text: string }>,
      api: "x" as const,
      provider: "x" as const,
      model: "x",
      usage,
      stopReason: "stop" as const,
      timestamp: Date.now(),
    };

    anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: baseMessage });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: { ...baseMessage, content: [{ type: "thinking", thinking: "first" }] },
      assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
    });
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["first"],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: { ...baseMessage, content: [{ type: "thinking", thinking: "first second" }] },
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: " second",
        partial: {},
      },
    });
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["first second"],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: {
        ...baseMessage,
        content: [
          { type: "thinking", thinking: "first second" },
          { type: "text", text: "answer" },
        ],
      },
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "answer", partial: {} },
    });
    assert.deepEqual(
      runtimeTab.chat
        .filter((line) => line.role === "thinking" || line.role === "assistant")
        .map((line) => `${line.role}:${line.text}`),
      ["thinking:first second", "assistant:answer"],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_end",
      message: {
        ...baseMessage,
        content: [
          { type: "thinking", thinking: "final thinking" },
          { type: "text", text: "final answer" },
        ],
      },
    });
    assert.deepEqual(
      runtimeTab.chat
        .filter((line) => line.role === "thinking" || line.role === "assistant")
        .map((line) => `${line.role}:${line.text}`),
      ["thinking:final thinking", "assistant:final answer"],
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
