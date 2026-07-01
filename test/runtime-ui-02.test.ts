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

test("MixCodeRoot renders config and agent views", () => {
  const state = createInitialState("/repo");
  const runtime = new MixCodeRuntime();
  const root = new MixCodeRoot(state, runtime);
  assert.match(root.render(100).join("\n"), /MixCode Home/);
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  assert.match(root.render(100).join("\n"), /No messages yet/);
  state.activeTabId = "config";
  assert.match(root.render(100).join("\n"), /Agents/);
  const compactRoot = new MixCodeRoot(state, runtime, () => 8);
  const compactLines = compactRoot.render(100);
  assert.match(compactLines.join("\n"), /MixCode Home/);
  assert.ok(compactLines.length <= 7);
  state.activeTabId = "s1";
  const busyTab = state.tabs[0]!;
  busyTab.previewMessages = Array.from({ length: 50 }, (_, index) => ({
    role: "assistant" as const,
    text: `message ${index}`,
  }));
  const compactAgentLines = compactRoot.render(100);
  assert.match(compactAgentLines[0] ?? "", /Agent-01/);
  assert.equal(stripAnsi(compactAgentLines[1] ?? "").trim(), "");
  assert.match(compactAgentLines[2] ?? "", /\.\.\. older above/);
  assert.equal(compactAgentLines.length, 6);
  const headerOnlyRoot = new MixCodeRoot(state, runtime, () => 2);
  const headerOnlyLines = headerOnlyRoot.render(100);
  assert.equal(headerOnlyLines.length, 0);
  const topOnlyRoot = new MixCodeRoot(state, runtime, () => 4);
  const topOnlyLines = topOnlyRoot.render(100);
  assert.equal(topOnlyLines.length, 2);
  assert.match(topOnlyLines[0] ?? "", /Agent-01/);
  root.invalidate();
});

test("createMixCodeTui wires a pi-tui instance without starting it", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const changedThemes: string[] = [];
  const runtime = new MixCodeRuntime();
  const tui = createMixCodeTui(state, runtime, {
    terminal: silentTerminal(),
    onStateChanged: (nextState) => {
      changedThemes.push(nextState.theme);
    },
  });
  assert.equal(typeof tui.start, "function");
  const host = (
    runtime as unknown as {
      extensionUiHost?: {
        themes?: {
          getTheme: () => string;
          setTheme: (themeId: string) => void;
          requestRender?: () => void;
        };
      };
    }
  ).extensionUiHost;
  assert.equal(host?.themes?.getTheme(), "claude-warm");
  host?.themes?.setTheme("terminal");
  assert.equal((tui as unknown as { renderRequested?: boolean }).renderRequested, true);
  assert.equal(state.theme, "terminal");
  assert.deepEqual(changedThemes, ["terminal"]);
  tui.stop();
});
