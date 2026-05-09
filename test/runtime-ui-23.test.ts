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

test("runtime summarizes long tool results instead of flooding chat", async () => {
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
  const longOutput = Array.from({ length: 80 }, (_, index) => `tool-line-${index}`).join("\n");

  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_start",
    toolCallId: "tc-long",
    toolName: "bash",
    args: { command: "printf long" },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "tc-long",
    toolName: "bash",
    result: { content: [{ type: "text", text: longOutput }] },
    isError: false,
  });

  const toolLine = runtimeTab.chat.find((line) => line.role === "tool" && line.title === "bash");
  assert.ok(toolLine);
  assert.match(toolLine.text, /tool-line-0/);
  assert.match(toolLine.text, /truncated/);
  assert.doesNotMatch(toolLine.text, /tool-line-79/);

  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_start",
    toolCallId: "tc-single-line-long",
    toolName: "read",
    args: { path: "long.txt" },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "tc-single-line-long",
    toolName: "read",
    result: { content: [{ type: "text", text: "x".repeat(900) }] },
    isError: false,
  });
  const singleLineTool = runtimeTab.chat.find(
    (line) => line.role === "tool" && line.toolCallId === "tc-single-line-long",
  );
  assert.ok(singleLineTool);
  assert.match(singleLineTool.text, /truncated/);
  assert.equal(singleLineTool.text.includes("x".repeat(700)), false);
});

test("runtime queues prompts while busy, pops them, and flushes when idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };

    anyAgent._state.isStreaming = true;
    await runtime.prompt("s1", "first queued");
    await runtime.prompt("s1", "second queued");
    await runtime.prompt("s1", "  ");
    assert.deepEqual(tab.pendingMessages, ["first queued", "second queued"]);
    assert.match(runtimeTab.chat.at(-1)?.text ?? "", /queued \(2\)/);
    assert.equal(runtimeTab.chat.at(-1)?.role, "system");

    assert.equal(runtime.popPendingMessage("s1"), "second queued");
    assert.deepEqual(tab.pendingMessages, ["first queued"]);
    anyAgent._state.isStreaming = false;
    tab.pendingMessages.unshift("preexisting pending");
    await runtime.flushPendingMessage("s1", 1);
    assert.deepEqual(tab.pendingMessages, ["preexisting pending"]);
    assert.ok(runtimeTab.chat.some((line) => line.text.includes("first queued")));
    assert.equal(
      runtimeTab.chat.some((line) => line.text.includes("preexisting pending")),
      false,
    );
    await runtime.flushPendingMessage("s1");
    assert.deepEqual(tab.pendingMessages, []);
    assert.ok(runtimeTab.chat.some((line) => line.text.includes("preexisting pending")));
    await runtime.flushPendingMessage("s1");
    assert.deepEqual(tab.pendingMessages, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime pop removes matching Pi follow-up queue entries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-pop-follow-up-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtimeTab.agentSession.followUp("first queued");
    await runtimeTab.agentSession.followUp("second queued");

    assert.equal(runtime.popPendingMessage("s1"), "second queued");

    assert.deepEqual(tab.pendingMessages, ["first queued"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
    assert.deepEqual(runtimeTab.agentSession.getFollowUpMessages(), ["first queued"]);
    assert.equal(
      (runtimeTab.agent as unknown as { followUpQueue: { messages: unknown[] } }).followUpQueue
        .messages.length,
      1,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime waits for idle before flushing queued prompts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-wait-idle-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    tab.pendingMessages.push("queued prompt");
    runtimeTab.queuedPromptCount = 1;
    const events: string[] = [];
    const anyAgent = runtimeTab.agent as unknown as {
      _state: { isStreaming: boolean };
      waitForIdle: () => Promise<void>;
    };
    anyAgent._state.isStreaming = true;
    anyAgent.waitForIdle = async () => {
      events.push("wait");
      anyAgent._state.isStreaming = false;
    };
    (
      runtimeTab.agent as unknown as {
        prompt: (messages: Array<{ content: Array<{ text?: string }> }>) => Promise<void>;
      }
    ).prompt = async (messages) => {
      events.push(
        messages
          .map((message) => message.content.map((block) => block.text ?? "").join("\n"))
          .join("\n\n"),
      );
    };

    await runtime.flushPendingMessage("s1", runtimeTab.queuedPromptCount);

    assert.deepEqual(events, ["wait", "queued prompt"]);
    assert.deepEqual(tab.pendingMessages, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps queued prompts when flush prompt fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-fail-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    tab.pendingMessages.push("restored pending", "queued prompt");
    runtimeTab.queuedPromptCount = 1;
    let promptText = "";
    (
      runtimeTab.agent as unknown as {
        prompt: (messages: Array<{ content: Array<{ text?: string }> }>) => Promise<void>;
      }
    ).prompt = async (messages) => {
      promptText = messages
        .map((message) => message.content.map((block) => block.text ?? "").join("\n"))
        .join("\n\n");
      throw new Error("queued prompt failed");
    };

    await assert.rejects(
      runtime.flushPendingMessage("s1", runtimeTab.queuedPromptCount),
      /queued prompt failed/,
    );

    assert.equal(promptText, "queued prompt");
    assert.deepEqual(tab.pendingMessages, ["restored pending", "queued prompt"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime flush syncs pending messages from Pi follow-up queue first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-sync-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtimeTab.agentSession.followUp("queued prompt");
    assert.deepEqual(tab.pendingMessages, ["queued prompt"]);
    tab.pendingMessages = [];
    runtimeTab.queuedPromptCount = 0;
    let promptText = "";
    (
      runtimeTab.agent as unknown as {
        prompt: (messages: Array<{ content: Array<{ text?: string }> }>) => Promise<void>;
      }
    ).prompt = async (messages) => {
      promptText = messages
        .map((message) => message.content.map((block) => block.text ?? "").join("\n"))
        .join("\n\n");
    };

    await runtime.flushPendingMessage("s1", 1);

    assert.equal(promptText, "queued prompt");
    assert.deepEqual(tab.pendingMessages, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime exposes Pi follow-up queue internal changes instead of silently dropping sent queue items", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-internals-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    tab.pendingMessages.push("queued prompt");
    runtimeTab.queuedPromptCount = 1;
    (runtimeTab.agentSession as unknown as { _followUpMessages?: unknown })._followUpMessages =
      undefined;

    await assert.rejects(
      runtime.flushPendingMessage("s1", runtimeTab.queuedPromptCount),
      /follow-up queue internals changed/,
    );

    assert.deepEqual(tab.pendingMessages, ["queued prompt"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime restores queued prompts when Pi agent follow-up queue internals change", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-agent-queue-internals-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    tab.pendingMessages.push("queued prompt");
    runtimeTab.queuedPromptCount = 1;
    (runtimeTab.agent as unknown as { followUpQueue?: unknown }).followUpQueue = undefined;

    await assert.rejects(
      runtime.flushPendingMessage("s1", runtimeTab.queuedPromptCount),
      /Agent follow-up queue internals changed/,
    );

    assert.deepEqual(tab.pendingMessages, ["queued prompt"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
