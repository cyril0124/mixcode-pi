import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
import { Markdown, Text, TuiMainScreen, visibleWidth, type AutocompleteProvider, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
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
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderTabBar,
  renderTabJumpOverlay,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
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
    await Bun.sleep(10);
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

test("runtime restores redacted thinking and unknown assistant content explicitly", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  runtimeTab.session.appendMessage({
    role: "assistant",
    content: [
      { type: "text", text: "   " },
      { type: "thinking", thinking: "", redacted: true },
      { type: "thinking", thinking: "   " },
      { type: "toolCall", id: "tc-restored-unknown", name: "", arguments: undefined as never },
      { type: "unknown", text: "" } as never,
    ],
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
  });
  const reopened = new MixCodeRuntime({
    sessionsRoot: (runtime as unknown as { sessionsRoot: string }).sessionsRoot,
  });
  const restored = await reopened.createTab(createTab(1, "s1", process.cwd()), {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });

  assert.ok(
    restored.chat.some((line) => line.role === "thinking" && line.text.includes("redacted")),
  );
  assert.ok(
    restored.chat.some(
      (line) =>
        line.role === "tool" &&
        line.toolCallId === "tc-restored-unknown" &&
        line.title === "unknown",
    ),
  );
  assert.deepEqual(
    restored.chat
      .filter((line) => line.role === "assistant")
      .map((line) => line.text.trim())
      .filter(Boolean),
    [],
  );
  assert.equal(
    restored.chat.some((line) => line.text.includes("unknown")),
    false,
  );
});

test("runtime ignores blank thinking and updates streaming thinking in place", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-thinking-blank-"));
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
  const message = (thinking: string) => ({
    role: "assistant" as const,
    content: [{ type: "thinking" as const, thinking }],
    api: "x" as const,
    provider: "x" as const,
    model: "x",
    usage,
    stopReason: "stop" as const,
    timestamp: Date.now(),
  });

  try {
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: message("   "),
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "   ", partial: {} },
    });
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      [],
    );

    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: message("first thought"),
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "first thought",
        partial: {},
      },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: message("second thought"),
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "second thought",
        partial: {},
      },
    });

    // Same content index updates the existing thinking line in place (no duplicate).
    assert.deepEqual(
      runtimeTab.chat.filter((line) => line.role === "thinking").map((line) => line.text),
      ["second thought"],
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime updates existing streaming thinking and tool call blocks", async () => {
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
    content: [] as Array<
      | { type: "thinking"; thinking: string }
      | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
    >,
    api: "x" as const,
    provider: "x" as const,
    model: "x",
    usage,
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };

  anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: baseMessage });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: { ...baseMessage, content: [{ type: "thinking", thinking: "first thinking" }] },
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "first thinking",
      partial: {},
    },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: { ...baseMessage, content: [{ type: "thinking", thinking: "second thinking" }] },
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "second thinking",
      partial: {},
    },
  });

  assert.equal(
    runtimeTab.chat.filter((line) => line.role === "thinking").at(-1)?.text,
    "second thinking",
  );

  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: baseMessage,
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: {
      ...baseMessage,
      content: [{ type: "toolCall", id: "tc-update", name: "bash", arguments: { command: "pwd" } }],
    },
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: {
      ...baseMessage,
      content: [{ type: "toolCall", id: "tc-update", name: "bash", arguments: { command: "ls" } }],
    },
    assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "ls", partial: {} },
  });

  const toolLines = runtimeTab.chat.filter(
    (line) => line.role === "tool" && line.toolCallId === "tc-update",
  );
  assert.equal(toolLines.length, 1);
  assert.deepEqual(toolLines[0]?.args, { command: "ls" });
});

test("runtime applies assistant usage outside streaming state", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  (
    runtime as unknown as {
      applyEvent: (
        runtimeTab: typeof runtimeTab,
        event: Parameters<Parameters<typeof runtimeTab.agentSession.agent.subscribe>[0]>[0],
      ) => void;
    }
  ).applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "usage only" }],
      usage: { input: 4, output: 2 },
      provider: "faux",
      model: "faux-1",
      timestamp: Date.now(),
    },
  });
  assert.equal(tab.tokenInput, 4);
  assert.equal(tab.tokenOutput, 2);
  (
    runtime as unknown as {
      applyEvent: (
        runtimeTab: typeof runtimeTab,
        event: Parameters<Parameters<typeof runtimeTab.agentSession.agent.subscribe>[0]>[0],
      ) => void;
    }
  ).applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "usage defaults" }],
      usage: {},
      provider: "faux",
      model: "faux-1",
      timestamp: Date.now(),
    },
  });
  assert.equal(tab.tokenInput, 4);
  assert.equal(tab.tokenOutput, 2);
});

