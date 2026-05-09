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

test("runtime drains queued prompts automatically after agent_end reaches idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-auto-"));
  try {
    const streamTexts: string[] = [];
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const releaseFirstPromise = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
        const text = lastRuntimeUserText(context);
        streamTexts.push(text);
        if (streamTexts.length === 1) {
          firstStarted();
          return delayedAssistantStream(text, releaseFirstPromise, options);
        }
        return delayedAssistantStream(text, Promise.resolve(), options);
      },
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
    };
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });

    const firstPrompt = runtime.prompt("s1", "first");
    await firstStartedPromise;
    await runtime.prompt("s1", "queued");
    assert.deepEqual(tab.pendingMessages, ["queued"]);
    assert.equal(runtimeTab.agent.state.isStreaming, true);
    releaseFirst();
    await firstPrompt;
    await waitForRuntime(() => tab.pendingMessages.length === 0 && streamTexts.includes("queued"));

    assert.deepEqual(tab.pendingMessages, []);
    assert.deepEqual(streamTexts, ["first", "queued"]);
    assert.ok(runtimeTab.chat.some((line) => line.role === "user" && line.text.includes("queued")));
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "assistant" && line.text.includes("Echo: queued"),
      ),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime leaves restored pending messages queued when no runtime prompt was queued", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-queue-restored-"));
  try {
    const streamTexts: string[] = [];
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context, options?: SimpleStreamOptions) => {
        const text = lastRuntimeUserText(context);
        streamTexts.push(text);
        return delayedAssistantStream(text, Promise.resolve(), options);
      },
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
    };
    const tab = createTab(1, "s1", process.cwd(), { pendingMessages: ["restored pending"] });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });

    await runtime.prompt("s1", "first");
    await waitForRuntime(() => streamTexts.length === 1 && tab.pendingMessages.length === 1);

    assert.deepEqual(tab.pendingMessages, ["restored pending"]);
    assert.deepEqual(streamTexts, ["first"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime compacts without custom instructions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-compact-default-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "compact me");
    await runtime.compactSession("s1");
    const compactedContext = runtimeTab.session.buildSessionContext();
    const summary =
      compactedContext.messages[0]?.role === "compactionSummary"
        ? compactedContext.messages[0].summary
        : "";
    assert.doesNotMatch(summary, /Extractive summary/);
    assert.doesNotMatch(summary, /Custom compaction instruction/);
    assert.ok(runtimeTab.chat.some((line) => line.text.includes("Compaction complete.")));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime shows working state while compaction runs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-compact-working-"));
  try {
    let releaseCompact!: () => void;
    const releaseCompactPromise = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      extensionFactories: [
        (pi) => {
          pi.on("session_before_compact", async (event) => {
            await releaseCompactPromise;
            return {
              compaction: {
                summary: `delayed summary ${event.customInstructions ?? ""}`.trim(),
                firstKeptEntryId: event.preparation.firstKeptEntry?.id,
                tokensBefore: 42,
              },
            };
          });
        },
      ],
    });
    const tab = createTab(1, "s1", process.cwd());
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "compact working");
    const statuses: Array<{ status: string; workingStartedAt?: string }> = [];
    runtime.onChange((_event, runtimeTab) => {
      if (runtimeTab.tab.sessionId === "s1") {
        statuses.push({
          status: runtimeTab.tab.status,
          workingStartedAt: runtimeTab.tab.workingStartedAt,
        });
      }
    });

    const compactPromise = runtime.compactSession("s1", "manual");
    await waitForRuntime(() =>
      statuses.some((status) => status.status === "running" && Boolean(status.workingStartedAt)),
    );
    assert.equal(tab.status, "running");
    assert.match(tab.workingStartedAt ?? "", /^\d{4}-\d{2}-\d{2}T/);
    releaseCompact();
    await compactPromise;
    assert.equal(tab.status, "idle");
    assert.equal(tab.workingStartedAt, undefined);
    assert.equal(typeof tab.lastWorkedDurationSeconds, "number");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("faux stream emits assistant text without external provider", async () => {
  const stream = mixcodeFauxStream(MIXCODE_FAUX_MODEL, {
    systemPrompt: "",
    messages: [{ role: "user", content: [{ type: "text", text: "ping" }], timestamp: Date.now() }],
  });
  const eventTypes: string[] = [];
  for await (const event of stream) eventTypes.push(event.type);
  const result = await stream.result();
  assert.deepEqual(eventTypes, [
    "start",
    "thinking_start",
    "thinking_delta",
    "thinking_end",
    "text_start",
    "text_delta",
    "text_end",
    "done",
  ]);
  assert.match(
    result.content[0]?.type === "thinking" ? result.content[0].thinking : "",
    /Inspecting/,
  );
  assert.match(result.content[1]?.type === "text" ? result.content[1].text : "", /ping/);
  const noUser = mixcodeFauxStream(MIXCODE_FAUX_MODEL, { systemPrompt: "", messages: [] });
  await noUser.result();
  const stringUser = mixcodeFauxStream(MIXCODE_FAUX_MODEL, {
    systemPrompt: "",
    messages: [{ role: "user", content: "plain", timestamp: Date.now() }],
  });
  const stringResult = await stringUser.result();
  assert.match(
    stringResult.content[1]?.type === "text" ? stringResult.content[1].text : "",
    /plain/,
  );
  const afterSystem = mixcodeFauxStream(MIXCODE_FAUX_MODEL, {
    systemPrompt: "",
    messages: [
      { role: "user", content: "before system", timestamp: Date.now() },
      { role: "system", content: "ignored", timestamp: Date.now() },
    ] as never,
  });
  const afterSystemResult = await afterSystem.result();
  assert.match(
    afterSystemResult.content[1]?.type === "text" ? afterSystemResult.content[1].text : "",
    /before system/,
  );
  const imageUser = mixcodeFauxStream(MIXCODE_FAUX_MODEL, {
    systemPrompt: "",
    messages: [
      {
        role: "user",
        content: [{ type: "image", mimeType: "image/png", data: "x" }],
        timestamp: Date.now(),
      },
    ],
  });
  const imageResult = await imageUser.result();
  assert.match(
    imageResult.content[1]?.type === "text" ? imageResult.content[1].text : "",
    /\[image\]/,
  );
});
