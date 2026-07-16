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
  type ToolCall,
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

function runtimeToolCallMessage(toolCall: ToolCall, totalTokens: number): AssistantMessage {
  return {
    role: "assistant",
    content: [toolCall],
    api: "queue-test",
    provider: "queue-test",
    model: "queue-test-model",
    usage: {
      input: totalTokens,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

function streamAssistantMessage(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    stream.push({ type: "start", partial: { ...message, content: [] } });
    const firstContent = message.content[0];
    if (firstContent?.type === "toolCall") {
      stream.push({
        type: "toolcall_start",
        contentIndex: 0,
        partial: message,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex: 0,
        toolCall: firstContent,
        partial: message,
      });
    } else if (firstContent?.type === "text") {
      stream.push({
        type: "text_start",
        contentIndex: 0,
        partial: { ...message, content: [{ type: "text", text: "" }] },
      });
      stream.push({
        type: "text_delta",
        contentIndex: 0,
        delta: firstContent.text,
        partial: message,
      });
      stream.push({
        type: "text_end",
        contentIndex: 0,
        content: firstContent.text,
        partial: message,
      });
    }
    stream.push({
      type: "done",
      reason: message.stopReason === "toolUse" ? "toolUse" : "stop",
      message,
    });
    stream.end(message);
  });
  return stream;
}

function runtimeUserTexts(context: Context): string[] {
  return context.messages
    .filter((message) => message.role === "user")
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      return message.content
        .map((block) => (block.type === "text" ? block.text : "[image]"))
        .join("\n");
    });
}

function lastRuntimeUserText(context: Context): string {
  return runtimeUserTexts(context).at(-1) ?? "";
}

function contextHasCompactionSummary(context: Context, expected: string): boolean {
  return context.messages.some((message) => {
    if (message.role !== "user") return false;
    if (typeof message.content === "string") {
      return message.content.includes("compacted into the following summary") && message.content.includes(expected);
    }
    return message.content.some(
      (block) =>
        block.type === "text" &&
        block.text.includes("compacted into the following summary") &&
        block.text.includes(expected),
    );
  });
}

function contextHasToolResultText(context: Context, expected: string): boolean {
  return context.messages.some((message) => {
    if (message.role !== "toolResult") return false;
    if (typeof message.content === "string") return message.content.includes(expected);
    return message.content.some((block) => block.type === "text" && block.text.includes(expected));
  });
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
    const streamUserTextSnapshots: string[][] = [];
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
        const userTexts = runtimeUserTexts(context);
        const text = userTexts.at(-1) ?? "";
        streamUserTextSnapshots.push(userTexts);
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
    await runtime.prompt("s1", "first queued");
    await runtime.prompt("s1", "second queued");
    assert.deepEqual(tab.pendingMessages, ["first queued", "second queued"]);
    assert.equal(runtimeTab.agent.state.isStreaming, true);
    releaseFirst();
    await firstPrompt;
    await waitForRuntime(
      () => tab.pendingMessages.length === 0 && streamUserTextSnapshots.at(-1)?.includes("second queued") === true,
    );

    assert.deepEqual(tab.pendingMessages, []);
    assert.deepEqual(streamTexts, ["first", "second queued"]);
    assert.deepEqual(streamUserTextSnapshots.at(-1), ["first", "first queued", "second queued"]);
    assert.ok(runtimeTab.chat.some((line) => line.role === "user" && line.text.includes("first queued")));
    assert.ok(runtimeTab.chat.some((line) => line.role === "user" && line.text.includes("second queued")));
    assert.ok(
      runtimeTab.chat.some(
        (line) => line.role === "assistant" && line.text.includes("Echo: second queued"),
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
    // SDK 0.80+ refuses to compact when the whole session fits the keep-recent
    // window. Shrink the window so this single-turn fixture has history to summarize.
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
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
    assert.ok(runtimeTab.chat.some((line) => line.compactionSummary === true));
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
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: 42,
              },
            };
          });
        },
      ],
    });
    const tab = createTab(1, "s1", process.cwd());
    const workingRuntimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    // Shrink the keep-recent window so the single-turn fixture is compactable
    // under SDK 0.80+ (which refuses when nothing falls outside the window).
    workingRuntimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
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

async function assertRuntimeAutoCompactsAndContinuesMidTurn(contextLimitOverridden: boolean): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-auto-compact-continue-"));
  try {
    const seenContexts: Context[] = [];
    const streamTexts: string[] = [];
    let toolCallTriggered = false;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context) => {
        seenContexts.push(context);
        const text = lastRuntimeUserText(context);
        // A prior "warmup" turn gives the session completed history outside the
        // keep-recent window; SDK 0.80+ refuses to compact a lone in-progress
        // turn. The "start" turn's tool call then triggers mid-turn compaction.
        if (text === "start" && !toolCallTriggered) {
          toolCallTriggered = true;
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-auto", name: "auto_echo", arguments: { text: "first" } },
              990,
            ),
          );
        }
        streamTexts.push(text);
        const reply = text === "warmup" ? `warmup reply ${"history ".repeat(40)}` : `continued:${text}`;
        return streamAssistantMessage(runtimeAssistantMessage(reply));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for mid-turn auto-compaction.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "auto summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
      contextWindow: 1000,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 1000,
    });
    tab.contextLimitOverridden = contextLimitOverridden;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 50 },
    });

    // Warmup turn first so the session has completed history outside the
    // keep-recent window; the "start" turn then triggers mid-turn compaction.
    await runtime.prompt("s1", "warmup");
    await waitForRuntime(() => streamTexts.includes("warmup"));
    await runtime.prompt("s1", "start");
    await waitForRuntime(
      () =>
        streamTexts.includes("start") &&
        runtimeTab.session.getBranch().some((entry) => entry.type === "compaction"),
    );

    const userLines = runtimeTab.chat.filter((line) => line.role === "user").map((line) => line.text);
    assert.deepEqual(userLines, ["warmup", "start"]);
    assert.ok(streamTexts.includes("start"));
    // The compaction summary and the tool result both appear in the context the
    // model sees when continuing after the mid-turn compaction.
    const continuationContext = seenContexts.find((context) =>
      contextHasCompactionSummary(context, "auto summary"),
    );
    assert.ok(continuationContext, "expected a post-compaction continuation context");
    assert.ok(contextHasToolResultText(continuationContext, "tool:first"));
    assert.equal(runtimeTab.session.getBranch().at(-1)?.type, "message");
    assert.ok(runtimeTab.session.getBranch().some((entry) => entry.type === "compaction"));
    assert.equal(runtimeTab.chat.some((line) => /finished without a response/i.test(line.text)), false);
    assert.equal(runtimeTab.tab.status, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("runtime auto-compacts and continues mid-turn without empty prompt", async () => {
  await assertRuntimeAutoCompactsAndContinuesMidTurn(true);
});

test("runtime auto-compacts and continues mid-turn without context-limit override", async () => {
  await assertRuntimeAutoCompactsAndContinuesMidTurn(false);
});

test("runtime preserves mid-turn auto-compaction after workdir changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-auto-compact-workdir-"));
  try {
    const oldDir = join(dir, "old");
    const newDir = join(dir, "new");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });

    const seenContexts: Context[] = [];
    const streamTexts: string[] = [];
    let toolCallTriggered = false;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context) => {
        seenContexts.push(context);
        const text = lastRuntimeUserText(context);
        if (text === "start" && !toolCallTriggered) {
          toolCallTriggered = true;
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-workdir", name: "auto_echo", arguments: { text: "first" } },
              990,
            ),
          );
        }
        streamTexts.push(text);
        const reply = text === "warmup" ? `warmup reply ${"history ".repeat(40)}` : `continued:${text}`;
        return streamAssistantMessage(runtimeAssistantMessage(reply));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for mid-turn auto-compaction after workdir changes.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "auto summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
      contextWindow: 1000,
    };
    const tab = createTab(1, "s1", oldDir, {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 1000,
    });
    tab.contextLimitOverridden = true;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: oldDir,
      model,
    });
    await runtime.updateTabWorkdir("s1", newDir, "system");
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 50 },
    });

    await runtime.prompt("s1", "warmup");
    await waitForRuntime(() => streamTexts.includes("warmup"));
    await runtime.prompt("s1", "start");
    await waitForRuntime(
      () =>
        streamTexts.includes("start") &&
        runtimeTab.session.getBranch().some((entry) => entry.type === "compaction"),
    );

    assert.ok(streamTexts.includes("start"));
    const continuationContext = seenContexts.find((context) =>
      contextHasCompactionSummary(context, "auto summary"),
    );
    assert.ok(continuationContext, "expected a post-compaction continuation context");
    assert.ok(contextHasToolResultText(continuationContext, "tool:first"));
    assert.ok(runtimeTab.session.getBranch().some((entry) => entry.type === "compaction"));
    assert.equal(runtimeTab.tab.status, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime auto-compaction skips the matching pending flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-auto-compact-flush-"));
  try {
    const seenContexts: Context[] = [];
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context) => {
        seenContexts.push(context);
        if (seenContexts.length === 1) {
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-flush", name: "auto_echo", arguments: { text: "first" } },
              90,
            ),
          );
        }
        return streamAssistantMessage(runtimeAssistantMessage(`continued:${lastRuntimeUserText(context)}`));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for pending-flush auto-compaction.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", (event) => ({
            compaction: {
              summary: "auto summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
            },
          }));
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
      contextWindow: 100,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 100,
      pendingMessages: ["restored pending"],
    });
    tab.contextLimitOverridden = true;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 1 },
    });

    await runtime.prompt("s1", "start");
    await waitForRuntime(() => seenContexts.length >= 2);

    assert.deepEqual(tab.pendingMessages, ["restored pending"]);
    assert.equal(
      runtimeTab.chat.some((line) => line.role === "user" && line.text.includes("restored pending")),
      false,
    );
    assert.equal(runtimeTab.tab.status, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime waits for SDK post-run compaction before continuing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-auto-compact-race-"));
  try {
    let releaseCompact!: () => void;
    const releaseCompactPromise = new Promise<void>((resolve) => {
      releaseCompact = resolve;
    });
    const seenContexts: Context[] = [];
    let compactionCalls = 0;
    let toolCallTriggered = false;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context) => {
        seenContexts.push(context);
        const text = lastRuntimeUserText(context);
        if (text === "start" && !toolCallTriggered) {
          toolCallTriggered = true;
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-race", name: "auto_echo", arguments: { text: "first" } },
              990,
            ),
          );
        }
        const reply = text === "warmup" ? `warmup reply ${"history ".repeat(40)}` : `continued:${text}`;
        return streamAssistantMessage(runtimeAssistantMessage(reply));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for auto-compaction race handling.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", async (event) => {
            compactionCalls += 1;
            await releaseCompactPromise;
            return {
              compaction: {
                summary: "auto summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: event.preparation.tokensBefore,
              },
            };
          });
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
      contextWindow: 1000,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 1000,
    });
    tab.contextLimitOverridden = true;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 50 },
    });

    // Warmup turn first so the "start" turn's compaction has history to summarize.
    await runtime.prompt("s1", "warmup");

    const promptPromise = runtime.prompt("s1", "start");
    await waitForRuntime(() => compactionCalls === 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(compactionCalls, 1);

    releaseCompact();
    await promptPromise;
    await waitForRuntime(
      () =>
        runtimeTab.session.getBranch().some((entry) => entry.type === "compaction") &&
        runtimeTab.tab.status === "idle",
    );

    assert.equal(compactionCalls, 1);
    const continuationContext = seenContexts.find((context) =>
      contextHasCompactionSummary(context, "auto summary"),
    );
    assert.ok(continuationContext, "expected a post-compaction continuation context");
    assert.ok(contextHasToolResultText(continuationContext, "tool:first"));
    assert.equal(runtimeTab.session.getBranch().filter((entry) => entry.type === "compaction").length, 1);
    assert.equal(runtimeTab.tab.status, "idle");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime surfaces auto-compaction failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-auto-compact-fail-"));
  try {
    let toolCallTriggered = false;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, context: Context) => {
        if (context.messages.some((message) => message.role === "toolResult")) {
          return streamAssistantMessage(runtimeAssistantMessage("should not continue"));
        }
        const text = lastRuntimeUserText(context);
        if (text === "start" && !toolCallTriggered) {
          toolCallTriggered = true;
          return streamAssistantMessage(
            runtimeToolCallMessage(
              { type: "toolCall", id: "tc-fail", name: "auto_echo", arguments: { text: "first" } },
              990,
            ),
          );
        }
        return streamAssistantMessage(runtimeAssistantMessage(`warmup reply ${"history ".repeat(40)}`));
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "auto_echo",
            label: "Auto Echo",
            description: "Test tool for failing auto-compaction.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (_toolCallId, params) => ({
              content: [{ type: "text", text: `tool:${params.text}` }],
              details: params,
            }),
          });
          pi.on("session_before_compact", () => ({ cancel: true }));
        },
      ],
    });
    const model: Model<string> = {
      ...MIXCODE_FAUX_MODEL,
      provider: "queue-test",
      api: "queue-test",
      id: "queue-test-model",
      contextWindow: 1000,
    };
    const tab = createTab(1, "s1", process.cwd(), {
      model: {
        provider: model.provider,
        modelId: model.id,
        displayName: `${model.provider}/${model.id}`,
        contextWindow: model.contextWindow,
      },
      contextLimit: 1000,
    });
    tab.contextLimitOverridden = true;
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 20, keepRecentTokens: 50 },
    });

    // Warmup turn so the session is genuinely compactable; the cancel handler
    // then makes compaction produce nothing, exercising the failure path.
    await runtime.prompt("s1", "warmup");
    await runtime.prompt("s1", "start");
    await waitForRuntime(
      () => tab.status === "idle" && runtimeTab.chat.some((line) => /did not produce/i.test(line.text)),
      100,
    );

    assert.equal(tab.status, "idle");
    assert.ok(runtimeTab.chat.some((line) => /Compaction failed: .*did not produce/i.test(line.text)));
    assert.equal(runtimeTab.chat.some((line) => /Compaction failed: Auto-compaction failed/i.test(line.text)), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects prompt while compaction is running", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-compact-prompt-guard-"));
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
                summary: "summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: 1,
              },
            };
          });
        },
      ],
    });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "hello");
    const compactPromise = runtime.compactSession("s1");
    // Wait until compaction is actually running
    await new Promise<void>((resolve) => {
      const unsub = runtime.onChange((event) => {
        if (event.type === "compaction_start") { unsub(); resolve(); }
      });
    });
    await assert.rejects(
      () => runtime.prompt("s1", "should be rejected"),
      /Cannot prompt while compaction is running/,
    );
    releaseCompact();
    await compactPromise;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime abortTab aborts compaction and leaves status idle", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-compact-abort-"));
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
                summary: "summary",
                firstKeptEntryId: event.preparation.firstKeptEntryId,
                tokensBefore: 1,
              },
            };
          });
        },
      ],
    });
    const tab = createTab(1, "s1", process.cwd());
    const abortRuntimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    // Shrink the keep-recent window so the single-turn fixture is compactable
    // under SDK 0.80+ and actually reaches compaction_start to be aborted.
    abortRuntimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    await runtime.prompt("s1", "hello");
    const compactPromise = runtime.compactSession("s1").catch(() => {});
    // Wait until compaction is running
    await new Promise<void>((resolve) => {
      const unsub = runtime.onChange((event) => {
        if (event.type === "compaction_start") { unsub(); resolve(); }
      });
    });
    // abortTab should abort compaction
    runtime.abortTab("s1");
    releaseCompact();
    await compactPromise;
    assert.equal(tab.status, "idle");
    // Chat should contain cancellation message, not a dangling "started" only
    const chatTexts = runtime.getTab("s1")!.chat.map((l) => l.text);
    assert.ok(chatTexts.some((t) => /[Cc]ancell?ed/.test(t)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
