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

test("runtime extension fork covers root and at-position branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-fork-branches-"));
  const events: string[] = [];
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "root prompt");
    const rootUserId = runtimeTab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(rootUserId);
    runtime.setExtensionUiHost({
      tui: new TUI(silentTerminal()),
      editor: {
        getText: () => "occupied",
        setText: (text) => events.push(`editor:${text}`),
        pasteToEditor: () => undefined,
      },
    });

    const beforeRootSessionFile = runtimeTab.session.getSessionFile();
    const forkRoot = await runtime.extensionFork("s1", rootUserId);
    const afterRootFork = runtime.listTabs()[0]!;
    assert.deepEqual(forkRoot, { cancelled: false });
    assert.notEqual(afterRootFork.tab.sessionId, "s1");
    assert.notEqual(afterRootFork.session.getSessionFile(), beforeRootSessionFile);
    assert.equal(afterRootFork.session.getHeader()?.parentSession, beforeRootSessionFile);
    assert.equal(afterRootFork.chat.length, 0);
    assert.ok(events.includes("editor:root prompt"));

    await runtime.prompt(afterRootFork.tab.sessionId, "at prompt");
    const atUserId = afterRootFork.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(atUserId);
    const beforeAtSession = afterRootFork.tab.sessionId;
    const beforeAtSessionFile = afterRootFork.session.getSessionFile();
    events.length = 0;
    const forkAt = await runtime.extensionFork(beforeAtSession, atUserId, { position: "at" });
    const afterAtFork = runtime.listTabs()[0]!;
    assert.deepEqual(forkAt, { cancelled: false });
    assert.notEqual(afterAtFork.tab.sessionId, beforeAtSession);
    assert.notEqual(afterAtFork.session.getSessionFile(), beforeAtSessionFile);
    assert.deepEqual(events, ["editor:"]);
    runtime.setExtensionUiHost(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension fork treats visible non-user entries as prior conversation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-fork-visible-prior-"));
  try {
    const cases: Array<{
      name: string;
      append: (runtimeTab: Awaited<ReturnType<MixCodeRuntime["createTab"]>>) => void;
      expected: string;
    }> = [
      {
        name: "custom-message",
        append: (runtimeTab) =>
          runtimeTab.session.appendCustomMessageEntry("visible", "visible custom", true),
        expected: "visible custom",
      },
      {
        name: "assistant",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "assistant prior" }],
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
          }),
        expected: "assistant prior",
      },
      {
        name: "tool-result",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "toolResult",
            toolCallId: "tc",
            toolName: "bash",
            content: [{ type: "text", text: "tool result" }],
            isError: false,
            timestamp: Date.now(),
          }),
        expected: "tool result",
      },
      {
        name: "bash-execution",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "bashExecution",
            command: "pwd",
            output: "bash output",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: Date.now(),
          }),
        expected: "bash output",
      },
      {
        name: "custom-message-role",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "custom",
            customType: "note",
            content: "custom message",
            display: true,
            timestamp: Date.now(),
          }),
        expected: "custom message",
      },
    ];
    for (const item of cases) {
      const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, item.name) });
      const runtimeTab = await runtime.createTab(createTab(1, `s-${item.name}`, process.cwd()), {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: process.cwd(),
      });
      item.append(runtimeTab);
      runtimeTab.session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: item.expected }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
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
      const userId = runtimeTab.session.appendMessage({
        role: "user",
        content: `after ${item.name}`,
        timestamp: Date.now(),
      });
      const beforeFile = runtimeTab.session.getSessionFile();

      const result = await runtime.extensionFork(runtimeTab.tab.sessionId, userId);
      const afterFork = runtime.listTabs()[0]!;
      assert.deepEqual(result, { cancelled: false });
      assert.notEqual(afterFork.session.getSessionFile(), beforeFile);
      assert.equal(
        afterFork.chat.some((line) => line.text.includes(item.expected)),
        true,
      );
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension command shutdown surfaces host shutdown request", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-shutdown-request-"));
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("shutdown-smoke", {
      description: "Request host shutdown",
      handler: async (_args, ctx) => {
        ctx.shutdown();
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "/shutdown-smoke");
    assert.equal(
      runtimeTab.chat.some(
        (line) => line.role === "system" && line.text === "Extension requested shutdown.",
      ),
      true,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
