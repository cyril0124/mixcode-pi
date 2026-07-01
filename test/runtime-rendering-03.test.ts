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

test("rendering exposes input metadata and tab bar landmarks", () => {
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
  const many = Array.from({ length: 16 }, (_, index) => ({
    role: "user" as const,
    text: `line-${index}`,
  }));
  tab.pendingEscapeAction = "abort-agent";
  tab.pendingEscapeArmedAt = Date.now();
  assert.match(renderInputMeta(tab, 100).join("\n"), /Esc again: stop/);
  tab.pendingEscapeAction = undefined;
  tab.pendingEscapeArmedAt = undefined;
  assert.match(
    titledBox("Title", ["meta", "with a very long right side"], ["body"], 24).join("\n"),
    /Title/,
  );
  const agentSurface = renderAgentSurface(
    tab,
    { chat: many } as never,
    100,
  ).join("\n");
  assert.doesNotMatch(agentSurface, /TODO Board/);
  assert.doesNotMatch(agentSurface, /\[x\] Fix bug/);
  assert.deepEqual(renderStatus(tab, 120), []);
  assert.match(agentSurface, /line-15/);
  // A thinking line in chat renders exactly once (no duplicate top summary).
  const piThinkingSurface = renderAgentSurface(
    createTab(18, "s18", "/repo"),
    {
      chat: [
        { role: "thinking", text: "same thought" },
        { role: "assistant", text: "done" },
      ],
    } as never,
    100,
  ).join("\n");
  assert.equal((piThinkingSurface.match(/same thought/g) ?? []).length, 1);
  const narrowAgentSurfaceLines = renderAgentSurface(
    createTab(14, "s14", "/repo"),
    { chat: [{ role: "assistant", text: "main" }] } as never,
    55,
  );
  const narrowAgentSurface = narrowAgentSurfaceLines.join("\n");
  assert.doesNotMatch(narrowAgentSurface, /TODO Board/);
  assert.match(narrowAgentSurface, /main/);
  assert.equal(
    narrowAgentSurfaceLines.every((line) => visibleWidth(line) <= 55),
    true,
  );
  assert.doesNotMatch(
    renderAgentSurface(createTab(6, "s6", "/repo"), undefined, 80).join("\n"),
    /badges:/,
  );
  const noSidebarSurface = renderAgentSurface(
    createTab(7, "s7", "/repo"),
    { chat: [] } as never,
    100,
  ).join("\n");
  assert.doesNotMatch(noSidebarSurface, /badges:/);
  const queuedSurface = renderAgentSurface(
    createTab(11, "s11", "/repo", { pendingMessages: ["first queued message"] }),
    { chat: [] } as never,
    80,
  ).join("\n");
  assert.match(queuedSurface, /Queue \(1\)/);
  assert.match(queuedSurface, /Esc->send now {2}Ctrl\+U->edit/);
  assert.match(queuedSurface, /first queued message/);
  const multiQueue = renderQueuePreview(
    createTab(12, "s12", "/repo", { pendingMessages: ["1", "2", "3", "4", "5", "6"] }),
    80,
  ).join("\n");
  assert.match(multiQueue, /Queue \(6, latest 5\)/);
  assert.doesNotMatch(multiQueue, /↳ 1/);
  assert.match(multiQueue, /↳ 6/);
  const scrollTab = createTab(19, "s19", "/repo", { chatScrollOffset: 32 });
  const scrollChat = Array.from({ length: 30 }, (_, index) => ({
    role: "assistant" as const,
    text: `scroll-${index}`,
  }));
  const scrolledSurface = renderAgentSurface(
    scrollTab,
    { chat: scrollChat } as never,
    80,
    6,
  ).join("\n");
  assert.match(scrolledSurface, /scroll-1[0-9]/);
  assert.doesNotMatch(scrolledSurface, /scroll-29/);
  assert.ok(scrolledSurface.split("\n").some((line) => /█\x1b\[39m$/.test(line)));
  const latestSurface = renderAgentSurface(
    createTab(20, "s20", "/repo"),
    { chat: scrollChat } as never,
    80,
    6,
  );
  assert.ok(latestSurface.some((line) => /scroll-29/.test(line)));
  assert.ok(latestSurface.at(-1)?.includes("█"));
  assert.equal(latestSurface.every((line) => visibleWidth(line) === 80), true);
  const strippedLatestSurface = latestSurface.map(stripAnsi);
  assert.equal(strippedLatestSurface.every((line) => !line.slice(0, 79).endsWith("...")), true);
  assert.deepEqual(renderQueuePreview(createTab(12, "s12", "/repo"), 80), []);
  assert.match(
    renderQueuePreview(
      createTab(13, "s13", "/repo", { pendingMessages: ["queued\nwith spacing"] }),
      80,
    ).join("\n"),
    /queued with spacing/,
  );
});

test("agent surface clamps extension-rendered tool lines with tabs to terminal width", () => {
  const width = 136;
  const tab = createTab(21, "s21", "/repo");
  const lines = renderAgentSurface(
    tab,
    {
      chat: [
        {
          role: "tool",
          title: "grep",
          text: "",
          status: "success",
          renderToolResult: () => [
            `ZhuJiang/src/test/lua/common/CHI.lua:11: \t${"MakeReadUnique = 0x01 + lshift(1, 6),".repeat(8)}`,
          ],
        },
      ],
    } as never,
    width,
  );

  assert.equal(
    lines.every((line) => visibleWidth(line) <= width),
    true,
  );
});

// Regression: after a /tree revert the chat is rebuilt from getBranch(). A
// rebuilt chat with no thinking line must not surface any stale thinking text
// at the top of the tab. Previously a separate accumulating `reasoning` store
// (never cleared on rebuild) leaked the prior turn's thinking into the summary.
test("agent surface shows no thinking content when rebuilt chat has none", () => {
  const tab = createTab(30, "s30", "/repo");
  const surface = renderAgentSurface(
    tab,
    { chat: [{ role: "user", text: "hello again" }] } as never,
    80,
  ).join("\n");
  assert.match(surface, /hello again/);
  assert.doesNotMatch(surface, /thinking|thought|Pondering|Analyzing/i);
});
