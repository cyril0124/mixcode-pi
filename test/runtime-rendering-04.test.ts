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

test("rendering exposes config, command, picker, and chooser overlays", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    pendingDialogs: [
      {
        requestId: "q",
        sessionId: "s1",
        questions: [],
        currentQuestionIndex: 0,
        highlightedOptionIndices: [],
        selectedAnswers: [],
        customAnswers: [],
        dirty: false,
      },
    ],
    unreadDone: true,
    pendingMessages: ["queued extension work"],
    extensionUi: {
      statuses: [{ key: "extension", text: "ready" }],
      widgets: [],
      toolsExpanded: true,
      workingVisible: true,
    },
  });
  state.tabs.push(tab);
  const statusTabs = stripAnsi(
    renderTabBar(
      {
        ...state,
        tabs: [
          createTab(8, "run", "/repo", { status: "running" }),
          createTab(9, "err", "/repo", { status: "error" }),
          createTab(10, "done", "/repo", { status: "done" }),
        ],
      },
      120,
    ).join("\n"),
  );
  assert.match(statusTabs, /\* Agent-08/);
  assert.match(statusTabs, /x Agent-09/);
  assert.match(statusTabs, /! Agent-10/);
  const busyTabs = stripAnsi(
    renderTabBar(
      {
        ...state,
        activeTabId: "config",
        tabs: [
          createTab(8, "run", "/repo", { status: "running" }),
          createTab(9, "think", "/repo", { status: "thinking" }),
          createTab(10, "idle", "/repo"),
        ],
      },
      120,
    ).join("\n"),
  );
  assert.match(busyTabs, /\* Agent-08/);
  assert.match(busyTabs, /\* Agent-09/);
  assert.match(busyTabs, /- Agent-10/);
  const doneTabs = stripAnsi(
    renderTabBar(
      {
        ...state,
        activeTabId: "config",
        tabs: [
          createTab(11, "done", "/repo", { status: "done" }),
          createTab(12, "idle-done", "/repo", { unreadDone: true }),
          createTab(13, "idle", "/repo"),
          createTab(14, "err-done", "/repo", { status: "error", unreadDone: true }),
        ],
      },
      160,
    ).join("\n"),
  );
  assert.match(doneTabs, /! Agent-11/);
  assert.match(doneTabs, /! Agent-12 /);
  assert.match(doneTabs, /- Agent-13/);
  assert.match(doneTabs, /x Agent-14 /);
  assert.match(
    renderTabBar(
      {
        ...state,
        tabs: [createTab(20, "err-done", "/repo", { status: "error", unreadDone: true })],
      },
      120,
    ).join("\n"),
    /x Agent-20 /,
  );
  const meta = renderInputMeta(tab, 100).join("\n");
  assert.match(meta, /󰚩/);
  assert.match(meta, /Medium/);
  assert.match(meta, /✦/);
  assert.match(meta, //);
  assert.match(stripAnsi(meta), /\?\/200k/);
  const oldHome = process.env.HOME;
  process.env.HOME = "/repo";
  assert.match(
    renderInputMeta(createTab(18, "s18", "/repo/project"), 100).join("\n"),
    /~\/project/,
  );
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  assert.doesNotMatch(
    renderInputMeta({ ...tab, pendingMessages: ["queued"] }, 100).join("\n"),
    /queued: 1/,
  );
});

test("extension status text preserves SGR colors and never leaks bare ANSI", () => {
  // Reproduces the status-bar ESC-strip bug: status text carries 24-bit SGR
  // color sequences; the cleaner must keep them intact (with the ESC byte) and
  // must not print bare "[38;2;...m" tokens (ESC removed) into the status line.
  const colored = "\x1b[38;2;250;249;245m\u26a1  FULL\x1b[39m";
  const tab = createTab(30, "s30", "/repo", {
    extensionUi: {
      statuses: [{ key: "ponytail", text: colored }],
      widgets: [],
      toolsExpanded: false,
      workingVisible: false,
    },
  });
  const meta = renderInputMeta(tab, 120).join("\n");
  // The intact SGR sequence (ESC + CSI) must survive the cleaner.
  assert.match(meta, /\x1b\[38;2;250;249;245m/);
  // A bare CSI with the ESC stripped must never appear.
  assert.doesNotMatch(meta, /(?<!\x1b)\[38;2;250;249;245m/);
});
