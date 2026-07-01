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

test("rendering exposes header, status, working indicator, and sidebar landmarks", () => {
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
  assert.deepEqual(renderHeader(80), []);
  assert.match(
    renderTabBar({ ...state, activeTabId: "config" }, 80, themeForId("claude-warm"))[0] ?? "",
    /\x1b\[48;2;166;61;32m\x1b\[38;2;255;232;220m MixCode Home /,
  );
  assert.match(
    renderTabBar({ ...state, activeTabId: "config" }, 80, themeForId("tokyo-night"))[0] ?? "",
    /\x1b\[48;2;47;65;117m\x1b\[38;2;125;207;255m MixCode Home /,
  );
  const configSurfaceLine =
    renderConfig(state, 100).find((line) => stripAnsi(line).includes("Agents")) ?? "";
  assert.doesNotMatch(configSurfaceLine, /\x1b\[48;/);
  assert.throws(() => themeForId("missing-theme"), /Unknown theme: missing-theme/);
  assert.match(renderTabBar({ ...state, activeTabId: "config" }, 80)[0] ?? "", /MixCode Home/);
  assert.match(
    renderTabBar({ ...state, activeTabId: "config" }, 80)[0] ?? "",
    /\x1b\[48;2;58;58;74m/,
  );
  const agentActiveState = { ...state, activeTabId: tab.sessionId };
  assert.match(
    renderTabBar(agentActiveState, 80)[0] ?? "",
    /\x1b\[48;2;95;135;255m\x1b\[38;2;24;24;30m MixCode Home /,
  );
  assert.match(renderTabBar(state, 80)[0] ?? "", /\? Agent-01 /);
  assert.doesNotMatch(stripAnsi(renderTabBar(state, 80)[0] ?? ""), /\? Agent-01[!?]/);
  assert.deepEqual(renderStatus(tab, 80), []);
  assert.match(stripAnsi(renderInputMeta(tab, 100).join("\n")), /\?\/200k/);
  assert.match(
    renderSystemToolsText([
      {
        name: "read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
        sourceInfo: {
          source: "builtin",
          scope: "project",
          origin: "top-level",
          path: "<builtin:read>",
        },
      },
    ]),
    /## read[\s\S]*Read a file[\s\S]*source: pi-builtin \| project \| top-level \| <pi-builtin:read>[\s\S]*parameters:/,
  );
  assert.match(
    renderSystemToolsText([
      {
        name: "read",
        description: "Read a file",
        parameters: Type.Object({ path: Type.String() }),
        sourceInfo: {
          source: "builtin",
          scope: "temporary",
          origin: "top-level",
          path: "<builtin:read>",
        },
      },
    ]),
    /source: pi-builtin \| temporary \| top-level \| <pi-builtin:read>/,
  );
  assert.match(renderSystemToolsText([]), /No tools available/);
  assert.deepEqual(renderStatus(tab, 80), []);
  assert.doesNotMatch(
    stripAnsi(renderStatus(createTab(15, "s15", "/repo", { status: "error" }), 80)[0] ?? ""),
    /error/,
  );
  assert.doesNotMatch(
    stripAnsi(renderStatus(createTab(16, "s16", "/repo", { status: "done" }), 80)[0] ?? ""),
    /done/,
  );
  assert.doesNotMatch(
    stripAnsi(renderStatus(createTab(17, "s17", "/repo", { status: "thinking" }), 80)[0] ?? ""),
    /thinking/,
  );
  assert.match(
    renderWorkingIndicator(
      createTab(22, "s22", "/repo", {
        status: "thinking",
        workingStartedAt: "2026-05-10T00:00:00.000Z",
      }),
      80,
      new Date("2026-05-10T00:02:22.000Z"),
    ).join("\n"),
    /Working \(2m 22s . esc to interrupt\)/,
  );
  assert.match(
    renderWorkingIndicator(
      createTab(23, "s23", "/repo", {
        status: "thinking",
        workingStartedAt: "2026-05-10T00:00:00.000Z",
      }),
      80,
      new Date("2026-05-10T00:00:25.000Z"),
    ).join("\n"),
    /Working \(25s . esc to interrupt\)/,
  );
  assert.match(
    renderWorkingIndicator(
      createTab(24, "s24", "/repo", {
        status: "thinking",
        workingStartedAt: "2026-05-10T00:00:00.000Z",
      }),
      80,
      new Date("2026-05-10T00:01:00.000Z"),
    ).join("\n"),
    /Working \(1m 00s . esc to interrupt\)/,
  );
  assert.match(
    renderWorkingIndicator(
      createTab(26, "s26", "/repo", {
        status: "thinking",
        workingStartedAt: "2026-05-10T00:00:00.000Z",
      }),
      80,
      new Date("2026-05-10T01:02:03.000Z"),
    ).join("\n"),
    /Working \(1h 02m 03s . esc to interrupt\)/,
  );
  assert.match(
    stripAnsi(
      renderWorkingIndicator(
        createTab(28, "s28", "/repo", {
          status: "running",
          workingStartedAt: "2026-05-10T00:00:00.000Z",
        }),
        80,
        new Date("2026-05-10T00:00:00.000Z"),
      ).join("\n"),
    ),
    /^⠋ Working/,
  );
  assert.match(
    stripAnsi(
      renderWorkingIndicator(
        createTab(29, "s29", "/repo", {
          status: "running",
          workingStartedAt: "2026-05-10T00:00:00.000Z",
        }),
        80,
        new Date("2026-05-10T00:00:00.080Z"),
      ).join("\n"),
    ),
    /^⠙ Working/,
  );
  assert.match(
    stripAnsi(
      renderWorkingIndicator(
        createTab(30, "s30", "/repo", {
          status: "running",
          workingStartedAt: "2026-05-10T00:00:00.000Z",
        }),
        80,
        new Date("2026-05-10T00:00:00.480Z"),
      ).join("\n"),
    ),
    /^⠦ Working/,
  );
  assert.match(
    renderWorkingIndicator(
      createTab(33, "s33", "/repo", {
        status: "running",
        workingStartedAt: "2026-05-10T00:00:00.000Z",
        pendingEscapeAction: "abort-agent",
        pendingEscapeArmedAt: new Date("2026-05-10T00:00:00.500Z").getTime(),
      }),
      80,
      new Date("2026-05-10T00:00:01.000Z"),
    ).join("\n"),
    /esc again to interrupt/,
  );
  assert.match(
    stripAnsi(
      renderWorkingIndicator(
        createTab(25, "s25", "/repo", {
          status: "running",
          workingStartedAt: "2026-05-10T00:00:00.000Z",
          extensionUi: {
            statuses: [],
            widgets: [],
            toolsExpanded: false,
            workingVisible: true,
            workingIndicatorFrames: ["A", "B"],
            workingIndicatorIntervalMs: 100,
          },
        }),
        80,
        new Date("2026-05-10T00:00:00.100Z"),
      ).join("\n"),
    ),
    /B Working/,
  );
  const ansiIndicator = renderWorkingIndicator(
    createTab(27, "s27", "/repo", {
      status: "running",
      workingStartedAt: "2026-05-10T00:00:00.000Z",
      extensionUi: {
        statuses: [],
        widgets: [],
        toolsExpanded: false,
        workingVisible: true,
        workingIndicatorFrames: ["\x1b[31mR\x1b[39m"],
      },
    }),
    80,
    new Date("2026-05-10T00:00:00.000Z"),
  ).join("\n");
  assert.match(ansiIndicator, /^\x1b\[31mR\x1b\[39m /);
  assert.doesNotMatch(ansiIndicator, /^\x1b\[38;2;217;119;87m/);
  assert.deepEqual(
    renderWorkingIndicator(
      createTab(26, "s26", "/repo", {
        status: "running",
        workingStartedAt: "2026-05-10T00:00:00.000Z",
        extensionUi: {
          statuses: [],
          widgets: [],
          toolsExpanded: false,
          workingVisible: true,
          workingIndicatorFrames: [],
        },
      }),
      80,
    ),
    [],
  );
  assert.deepEqual(renderWorkingIndicator(createTab(23, "s23", "/repo"), 80), []);
  assert.match(
    renderWorkingIndicator(
      createTab(24, "s24", "/repo", { lastWorkedDurationSeconds: 291 }),
      80,
    ).join("\n"),
    /Worked for 4m 51s/,
  );
  // With a completion stamp, the local clock time is appended.
  assert.match(
    renderWorkingIndicator(
      createTab(25, "s25", "/repo", {
        lastWorkedDurationSeconds: 291,
        lastWorkedAt: "2026-06-22T14:23:05.000Z",
      }),
      80,
    ).join("\n"),
    /Worked for 4m 51s · at \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/,
  );
  assert.deepEqual(renderStatus(tab, 120), []);
  assert.match(renderStatus(undefined, 80)[0] ?? "", /no active agent/);
  assert.deepEqual(renderSidebar(tab, 40), []);
  assert.deepEqual(
    renderSidebar(
      createTab(3, "s3", "/repo"),
      40,
    ),
    [],
  );
  assert.deepEqual(
    renderSidebar(
      createTab(4, "s4", "/repo"),
      40,
    ),
    [],
  );
  assert.deepEqual(renderSidebar(createTab(5, "s5", "/repo"), 40), []);
});
