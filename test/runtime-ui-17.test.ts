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

test("runtime restores assistant tool calls and matching tool results as one tool block", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-tool-restore-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtimeTab.session.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-merge",
          name: "read",
          arguments: { path: "package.json" },
        },
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
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "toolResult",
      toolCallId: "tc-merge",
      toolName: "read",
      content: [{ type: "text", text: "merged result" }],
      isError: false,
      timestamp: Date.now(),
    });

    const reopened = new MixCodeRuntime({ sessionsRoot: dir });
    const restored = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const restoredTools = restored.chat.filter(
      (line) => line.role === "tool" && line.toolCallId === "tc-merge",
    );
    assert.equal(restoredTools.length, 1);
    assert.equal(restoredTools[0]?.status, "success");
    assert.equal(restoredTools[0]?.title, "read");
    assert.deepEqual(restoredTools[0]?.args, { path: "package.json" });
    assert.match(restoredTools[0]?.text ?? "", /merged result/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime restores bash tool results through assistant tool call args", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-bash-result-only-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    };
    runtimeTab.session.appendMessage({
      role: "assistant",
      content: [
        {
          type: "toolCall",
          id: "tc-bash-result",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
      api: "x",
      provider: "x",
      model: "x",
      usage,
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "toolResult",
      toolCallId: "tc-bash-result",
      toolName: "bash",
      content: [{ type: "text", text: "bash output" }],
      isError: false,
      timestamp: Date.now(),
    });

    const reopened = new MixCodeRuntime({ sessionsRoot: dir });
    const restored = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    restored.tab.extensionUi.toolsExpanded = true;
    const rendered = stripAnsi(renderChat(restored.chat, 80).join("\n"));
    assert.match(rendered, /bash output/);
    assert.match(rendered, /\$ pwd/);
    assert.doesNotMatch(rendered, /\$ \.\.\./);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime ignores restored orphan tool results like pi interactive rendering", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-orphan-tool-result-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtimeTab.session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "before bash" }],
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
      stopReason: "toolUse",
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "toolResult",
      toolCallId: "tc-orphan",
      toolName: "bash",
      content: [{ type: "text", text: "orphan output" }],
      isError: false,
      timestamp: Date.now(),
    });

    const reopened = new MixCodeRuntime({ sessionsRoot: dir });
    const restored = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const rendered = stripAnsi(renderChat(restored.chat, 80).join("\n"));
    assert.doesNotMatch(rendered, /\$ \.\.\./);
    assert.doesNotMatch(rendered, /orphan output/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime restores bash execution status details", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-bash-status-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    runtimeTab.session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "before bash statuses" }],
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
    runtimeTab.session.appendMessage({
      role: "bashExecution",
      command: "sleep 10",
      output: "cancelled output",
      exitCode: undefined,
      cancelled: true,
      truncated: false,
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "bashExecution",
      command: "cat huge.log",
      output: "failed output",
      exitCode: 2,
      cancelled: false,
      truncated: true,
      fullOutputPath: "/tmp/full-output.log",
      timestamp: Date.now(),
    });

    const reopened = new MixCodeRuntime({ sessionsRoot: dir });
    const restored = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const rendered = stripAnsi(renderChat(restored.chat, 80).join("\n"));
    assert.ok(restored.chat.every((line) => line.role !== "tool" || line.variant === "user-bash"));
    assert.match(rendered, /^─+$/m);
    assert.match(rendered, /\$ sleep 10/);
    assert.match(rendered, /\(cancelled\)/);
    assert.match(rendered, /\$ cat huge\.log/);
    assert.match(rendered, /\(exit 2\)/);
    assert.match(rendered, /Output truncated\. Full output: \/tmp\/full-output\.log/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime does not leave blank assistant placeholders for thinking or tool-only streams", async () => {
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
  const emptyAssistant = {
    role: "assistant" as const,
    content: [] as Array<{ type: "text"; text: string }>,
    api: "x" as const,
    provider: "x" as const,
    model: "x",
    usage,
    stopReason: "toolUse" as const,
    timestamp: Date.now(),
  };
  const thinkingOnly = {
    ...emptyAssistant,
    content: [{ type: "thinking" as const, thinking: "think only" }],
  };
  const toolOnly = {
    ...emptyAssistant,
    content: [
      { type: "toolCall" as const, id: "tc-only", name: "bash", arguments: { command: "pwd" } },
    ],
  };
  const unknownToolOnly = {
    ...emptyAssistant,
    content: [{ type: "toolCall" as const, id: "tc-unknown", name: "", arguments: {} }],
  };

  anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: emptyAssistant });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: thinkingOnly,
    assistantMessageEvent: {
      type: "thinking_delta",
      contentIndex: 0,
      delta: "think only",
      partial: {},
    },
  });
  anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: thinkingOnly });
  anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: emptyAssistant });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: toolOnly,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
  });
  anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: toolOnly });
  anyRuntime.applyEvent(runtimeTab, { type: "message_start", message: emptyAssistant });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_update",
    message: unknownToolOnly,
    assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
  });
  anyRuntime.applyEvent(runtimeTab, { type: "message_end", message: unknownToolOnly });

  assert.equal(
    runtimeTab.chat.some((line) => line.role === "assistant" && !line.text.trim()),
    false,
  );
  assert.ok(runtimeTab.chat.some((line) => line.role === "thinking" && line.text === "think only"));
  assert.ok(runtimeTab.chat.some((line) => line.role === "tool" && line.toolCallId === "tc-only"));
  assert.ok(
    runtimeTab.chat.some(
      (line) =>
        line.role === "tool" && line.toolCallId === "tc-unknown" && line.title === "unknown",
    ),
  );
});

test("runtime keeps streaming tool calls stable when ids arrive after content index", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-late-tool-id-"));
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
    const baseMessage = {
      role: "assistant" as const,
      content: [] as Array<{
        type: "toolCall";
        id: string;
        name: string;
        arguments: Record<string, unknown>;
      }>,
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
      message: {
        ...baseMessage,
        content: [{ type: "toolCall", id: "", name: "bash", arguments: { command: "pwd" } }],
      },
      assistantMessageEvent: { type: "toolcall_start", contentIndex: 0, partial: {} },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "message_update",
      message: {
        ...baseMessage,
        content: [{ type: "toolCall", id: "tc-late", name: "bash", arguments: { command: "pwd" } }],
      },
      assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, partial: {} },
    });
    anyRuntime.applyEvent(runtimeTab, {
      type: "tool_execution_end",
      toolCallId: "tc-late",
      toolName: "bash",
      result: { content: "done" },
      isError: false,
    });

    const toolLines = runtimeTab.chat.filter((line) => line.role === "tool");
    assert.equal(toolLines.length, 1);
    assert.equal(toolLines[0]?.toolCallId, "tc-late");
    assert.equal(toolLines[0]?.status, "success");
    assert.match(toolLines[0]?.text ?? "", /done/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
