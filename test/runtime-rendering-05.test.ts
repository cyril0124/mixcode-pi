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

test("rendering sanitizes terminal text and paints tool blocks", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    pendingQuestions: [
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
    todoVisible: true,
    todos: [{ id: "t1", content: "Fix bug", status: "completed" }],
    pendingMessages: ["queued extension work"],
    extensionUi: {
      statuses: [{ key: "extension", text: "ready" }],
      widgets: [],
      toolsExpanded: true,
      workingVisible: true,
    },
  });
  state.tabs.push(tab);
  const config = renderConfig(state, 100).join("\n");
  assert.match(config, /▔/);
  assert.match(config, /▁/);
  assert.match(config, /Workdir/);
  assert.match(config, /\/repo/);
  assert.doesNotMatch(config, /Model/);
  assert.doesNotMatch(config, /faux\/faux-1/);
  assert.doesNotMatch(config, /Thinking/);
  assert.doesNotMatch(config, /medium/i);
  assert.match(config, /Sessions/);
  assert.match(config, /Agent-01/);
  assert.match(config, /New Session/);
  assert.match(config, /Theme/);
  assert.match(config, /Save Workspace/);
  assert.match(config, /Restore Workspace/);
  assert.match(config, /Delete Workspace/);
  assert.match(config, /Pi-native ready/);
  assert.match(config, /tabs: 1/);
  assert.doesNotMatch(config, /Package Updates Available/);
  assert.doesNotMatch(config, /Runtime|Pi agent-core local session repository/);
  assert.doesNotMatch(config, /\/new-session/);
  assert.doesNotMatch(config, /\/models/);
  assert.doesNotMatch(config, /\/thinking/);
  assert.doesNotMatch(config, /\/theme/);
  assert.doesNotMatch(config, /\/save-workspace <name>/);
  assert.doesNotMatch(config, /\/restore-workspace <name>/);
  assert.doesNotMatch(config, /\/delete-workspace <name>/);
  assert.doesNotMatch(config, /Connect|Reconnect|Attach Session|opencode/i);
  state.packageUpdates = ["@juicesharp/rpiv-todo", "@juicesharp/rpiv-ask-user-question"];
  const updateConfig = renderConfig(state, 100).join("\n");
  assert.match(updateConfig, /Package Updates Available/);
  assert.match(updateConfig, /Package updates are available\. Run/);
  assert.match(updateConfig, /pi update/);
  assert.match(updateConfig, /@juicesharp\/rpiv-todo/);
  assert.match(updateConfig, /@juicesharp\/rpiv-ask-user-question/);
  state.commandPaletteOpen = true;
  assert.match(renderCommandPalette(state, 100).join("\n"), /Choose Theme/);
  assert.match(renderCommandPalette(state, 100).join("\n"), /Extension Manager/);
  assert.match(renderCommandPalette(state, 100).join("\n"), /\/delete-all-sessions/);
  state.activeTabId = tab.sessionId;
  assert.match(renderCommandPalette(state, 100).join("\n"), /Open System Prompt/);
  assert.match(renderCommandPalette(state, 100).join("\n"), /Extension Manager/);
  assert.doesNotMatch(renderCommandPalette(state, 100).join("\n"), /Toggle Shell/);
  assert.match(renderCommandPalette(state, 100).join("\n"), /\/mark-done/);
  state.commandPalette.query = "missing";
  assert.match(renderCommandPalette(state, 100).join("\n"), /No matching commands/);
  state.commandPaletteOpen = false;
  assert.match(renderExportChooser(state, 80).join("\n"), /Latest Agent Reply/);
  assert.match(renderExportChooser(state, 80).join("\n"), /System Info/);
  assert.deepEqual(renderTabJumpOverlay(state, 80), []);
  assert.deepEqual(renderPickerOverlay(state, 80), []);
});
