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

test(undefined, () => {
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
  assert.equal(box("X", ["body"], 10).length, 3);
  assert.match(box("", ["body"], 10).join("\n"), /┌/);
  assert.deepEqual(fitTailLines(["a", "b"], 3, 10), ["a", "b"]);
  assert.deepEqual(fitTailLines(["a", "b"], 0, 10), []);
  assert.match(fitTailLines(["a", "b"], 1, 10)[0] ?? "", /\.\.\./);
  assert.match(fitTailLines(["a", "b", "c"], 2, 10).join("\n"), /\.\.\.[\s\S]*c/);
  assert.deepEqual(
    renderAgentSurface(
      createTab(21, "s21", "/repo", { chatScrollOffset: 2 }),
      { chat: [{ role: "assistant", text: "a" }] } as never,
      80,
      20,
    ).some((line) => line.includes("a")),
    true,
  );
  assert.deepEqual(fitHeadLines(["a", "b"], 3, 10), ["a", "b"]);
  assert.deepEqual(fitHeadLines(["a", "b"], 0, 10), []);
  assert.match(fitHeadLines(["a", "b"], 1, 10)[0] ?? "", /\.\.\./);
  assert.match(fitHeadLines(["a", "b", "c"], 2, 10).join("\n"), /a[\s\S]*\.\.\./);
  assert.ok(describeKeymap().some((line) => line.includes("ctrl")));
  assert.ok(describeKeymap().some((line) => line.startsWith("ctrl+q:")));
  assert.deepEqual(
    new Set(MIXCODE_KEYMAP.map((item) => item.scope ?? "global")).has("global"),
    true,
  );
  for (const scope of ["picker", "command-palette", "tab-jump", "preview"]) {
    assert.equal(
      MIXCODE_KEYMAP.some((item) => item.scope === scope),
      true,
      `${scope} scope should be documented`,
    );
    assert.equal(
      describeScopedKeymap().some((line) => line.startsWith(`${scope} `)),
      true,
    );
  }
  assert.ok(MIXCODE_KEYMAP.some((item) => item.scope === "preview" && item.key === "g/G"));
});
