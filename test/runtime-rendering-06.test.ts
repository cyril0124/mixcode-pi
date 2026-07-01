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

test("rendering exposes fitting helpers and keymap export text", () => {
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
  assert.equal(padLine("abcdef", 3).includes("..."), true);
  assert.equal(padLine("abcdef", 3).includes("\x1b[0m...\x1b[0m"), false);
  assert.equal(
    renderChat(
      [
        {
          role: "tool",
          title: "bash",
          status: "success",
          args: { command: "echo one\necho two" },
          text: "ok",
        },
      ],
      24,
    ).every((line) => !/[\r\n]/.test(line) && visibleWidth(line) <= 24),
    true,
  );
  assert.equal(
    renderChat(
      [
        {
          role: "tool",
          title: "read",
          status: "success",
          args: { path: "a".repeat(120) },
          text: "ok",
        },
      ],
      24,
    ).some((line) => line.includes("\x1b[0m...\x1b[0m")),
    false,
  );
  assert.equal(
    renderChat(
      [
        {
          role: "tool",
          title: "bash",
          status: "success",
          args: { command: "\x1b[2J\x1b[Hprintf ok" },
          text: "\x1b]0;title\x07ok\x1b_Gbad\x07",
        },
      ],
      40,
    )
      .join("\n")
      .includes("\x1b[2J"),
    false,
  );
  assert.equal(padLine("\x01ok\x02", 6), "ok    ");
  assert.equal(padLine("\x1b[31broken", 10), "roken     ");
  assert.equal(padLine("\x1b]0;title", 10), "          ");
  assert.match(padLine("\x1bPpayload\x1b\\ok", 6), /ok/);
  const tabbedLine = padLine("interactive-mode.ts:664:\t\t\tthis.ui.invalidate();", 40);
  assert.equal(tabbedLine.includes("\t"), false);
  assert.equal(visibleWidth(tabbedLine), 40);
  const toolBlock = renderChat(
    [
      {
        role: "tool",
        title: "bash",
        status: "success",
        args: { command: "cat package.json" },
        text: '{\n  "name": "mixcode-pi",\n  "version": "0.1.0"\n}',
      },
    ],
    48,
  );
  assert.equal(
    toolBlock.every((line) => visibleWidth(line) === 48),
    true,
  );
  const toolText = toolBlock.join("\n");
  assert.equal(toolText.includes("\x1b[48;2;22;26;31m"), false);
  assert.equal(toolText.includes("\x1b[48;2;29;33;41m"), false);
  assert.equal(toolText.includes("\x1b[48;2;40;50;40m"), true);
  assert.equal(toolText.includes("\x1b[39m\x1b[48;2;40;50;40m"), true);
  assert.match(toolText, /\x1b\[38;2;181;189;104m/);
  const capturedCustomToolWidths: number[] = [];
  const customRendererBlock = renderChat(
    [
      {
        role: "tool",
        title: "custom",
        status: "success",
        text: "fallback",
        renderToolCall: (width) => {
          capturedCustomToolWidths.push(width);
          return ["call\tone\ncall two"];
        },
        renderToolResult: (width) => {
          capturedCustomToolWidths.push(width);
          return ["result\tone"];
        },
      },
    ],
    24,
  );
  assert.deepEqual(capturedCustomToolWidths, [22, 22]);
  const customRendererText = customRendererBlock.join("\n");
  assert.deepEqual(stripAnsi(customRendererBlock[0] ?? "").trim(), "");
  assert.deepEqual(stripAnsi(customRendererBlock.at(-1) ?? "").trim(), "");
  assert.match(stripAnsi(customRendererBlock.find((line) => line.includes("call")) ?? ""), /^ /);
  assert.equal(
    stripAnsi(customRendererBlock.find((line) => line.includes("call")) ?? "").includes("call"),
    true,
  );
  assert.doesNotMatch(customRendererText, /\u00a0/);
  assert.match(stripAnsi(customRendererText), /call {2}one/);
  assert.match(customRendererText, /call two/);
  assert.match(customRendererText, /\x1b\[48;2;40;50;40m/);
  assert.match(stripAnsi(customRendererText), /result {2}one/);
  const selfRendererBlock = renderChat(
    [
      {
        role: "tool",
        title: "self-rendered",
        status: "success",
        text: "fallback",
        toolRenderShell: "self",
        renderToolCall: () => ["self call"],
        renderToolResult: () => ["self result"],
      },
    ],
    24,
  );
  assert.match(stripAnsi(selfRendererBlock[0] ?? ""), /^self call/);
  assert.match(stripAnsi(selfRendererBlock.at(-1) ?? ""), /^self result/);
  assert.doesNotMatch(selfRendererBlock.join("\n"), /\x1b\[48;2;40;50;40m/);
  const extensionFallback = renderChat(
    [{ role: "extension", text: "", customType: "empty" }],
    40,
  ).join("\n");
  assert.match(extensionFallback, /extension empty/);
  assert.equal(
    stripAnsi(
      renderInputMeta(
        createTab(28, "s28", "/repo", {
          model: { provider: "x", modelId: "m", displayName: "", contextWindow: 1 },
        }),
        30,
      ).join("\n"),
    ).includes("󰚩 -"),
    true,
  );
  const narrowMetaTab = createTab(29, "s29", "/repo/" + "long/".repeat(8), {
    pendingMessages: ["queued"],
    pendingEscapeAction: "abort-agent",
  });
  const narrowMetaLine = renderInputMeta(narrowMetaTab, 28).join("\n");
  assert.equal(visibleWidth(narrowMetaLine), 27);
  assert.deepEqual(
    narrowMetaTab.inputMetaHitRegions.map((region) => region.action),
    ["models"],
  );
  assert.match(stripAnsi(narrowMetaLine), /\?\//);
  const wideMetaLine = renderInputMeta(
    createTab(32, "s32", "/repo", {
      model: {
        provider: "jw",
        modelId: "proxy-gpt-5.4-high",
        displayName: "jw-proxy-gpt-5.4-high",
        contextWindow: 256_000,
      },
      thinkingLevel: "high",
      contextLimit: 256_000,
    }),
    120,
  ).join("\n");
  assert.match(stripAnsi(wideMetaLine), /jw-proxy-gpt-5\.4-high/);
  assert.match(
    stripAnsi(
      renderWorkingIndicator(
        createTab(30, "s30", "/repo", { status: "idle", lastWorkedDurationSeconds: 3661 }),
        80,
      ).join("\n"),
    ),
    /1h 01m/,
  );
  assert.match(
    stripAnsi(
      renderWorkingIndicator(
        createTab(31, "s31", "/repo", {
          status: "running",
          extensionUi: {
            statuses: [],
            widgets: [],
            toolsExpanded: false,
            workingVisible: true,
            workingMessage: "   ",
          },
        }),
        80,
        new Date("2026-05-10T00:00:00.000Z"),
      ).join("\n"),
    ),
    /Working \(0s/,
  );
  assert.match(
    renderAgentSurface(
      createTab(32, "s32", "/repo", { chatScrollOffset: 1 }),
      {
        chat: [
          { role: "assistant", text: "a" },
          { role: "assistant", text: "b" },
        ],
      } as never,
      40,
      1,
    ).join("\n"),
    /\.\.\./,
  );
  assert.match(
    renderChat([{ role: "system", text: "multi\nline" }], 20).join("\n"),
    /\[System\]:[\s\S]*multi[\s\S]*line/,
  );
  const systemMarkdown = stripAnsi(
    renderChat(
      [
        {
          role: "system",
          text: ["**Hotkeys**", "", "| Key | Action |", "|-----|--------|", "| `/` | Slash commands |"].join(
            "\n",
          ),
        },
      ],
      60,
    ).join("\n"),
  );
  assert.match(systemMarkdown, /\[System\]:/);
  assert.match(systemMarkdown, /Hotkeys/);
  assert.match(systemMarkdown, /│ Key │ Action/);
  assert.match(systemMarkdown, /│ \/\s+│ Slash commands │/);
  assert.doesNotMatch(systemMarkdown, /\|-----\|--------\|/);
});
