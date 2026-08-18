import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
import { Markdown, Text, TuiMainScreen, visibleWidth, type AutocompleteProvider, type Component, type OverlayOptions, type Terminal } from "@earendil-works/pi-tui";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeCompletionProvider,
  MixCodeRoot,
  MixCodeRuntime,
  box,
  createInitialState,
  createTab,
  createMixCodeTui,
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
  renderInputMeta,
  renderAgentSurface,
  renderPickerOverlay,
  renderQueuePreview,
  renderTabBar,
  renderTabJumpOverlay,
  renderWorkingIndicator,
  fitHeadLines,
  fitTailLines,
  themeForId,
} from "./helpers/mixcode.js";

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
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

async function waitFor(predicate: () => boolean, attempts = 25): Promise<void> {
  await waitForRuntime(predicate, attempts);
}

let blockedQueueRuntimeSequence = 0;

function createBlockedQueueRuntime(sessionsRoot: string) {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const suffix = ++blockedQueueRuntimeSequence;
  const model: Model<string> = {
    ...MIXCODE_FAUX_MODEL,
    provider: `queue-${suffix}`,
    api: `queue-${suffix}`,
    id: `queue-${suffix}`,
  };
  const runtime = new MixCodeRuntime({
    sessionsRoot,
    streamFn: (_model, context, options) =>
      delayedAssistantStream(lastRuntimeUserText(context), ready, options),
  });
  return { runtime, release, model };
}

async function startBlockedQueuePrompt(
  runtime: MixCodeRuntime,
  sessionId: string,
): Promise<{ prompt: Promise<void> }> {
  const prompt = runtime.prompt(sessionId, "busy");
  await waitFor(() => runtime.getTab(sessionId)?.agentSession.isStreaming === true);
  return { prompt };
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

test("runtime summarizes long tool results instead of flooding chat", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  const longOutput = Array.from({ length: 80 }, (_, index) => `tool-line-${index}`).join("\n");

  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_start",
    toolCallId: "tc-long",
    toolName: "bash",
    args: { command: "printf long" },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "tc-long",
    toolName: "bash",
    result: { content: [{ type: "text", text: longOutput }] },
    isError: false,
  });

  const toolLine = runtimeTab.chat.find((line) => line.role === "tool" && line.title === "bash");
  assert.ok(toolLine);
  assert.match(toolLine.text, /tool-line-0/);
  assert.match(toolLine.text, /truncated/);
  assert.doesNotMatch(toolLine.text, /tool-line-79/);

  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_start",
    toolCallId: "tc-single-line-long",
    toolName: "read",
    args: { path: "long.txt" },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "tool_execution_end",
    toolCallId: "tc-single-line-long",
    toolName: "read",
    result: { content: [{ type: "text", text: "x".repeat(900) }] },
    isError: false,
  });
  const singleLineTool = runtimeTab.chat.find(
    (line) => line.role === "tool" && line.toolCallId === "tc-single-line-long",
  );
  assert.ok(singleLineTool);
  assert.match(singleLineTool.text, /truncated/);
  assert.equal(singleLineTool.text.includes("x".repeat(700)), false);
});

test("runtime queues prompts while busy, pops them, and flushes when idle", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    const { prompt } = await startBlockedQueuePrompt(runtime, "s1");
    await runtime.prompt("s1", "first queued");
    await runtime.prompt("s1", "second queued");
    await runtime.prompt("s1", "  ");
    assert.deepEqual(tab.pendingMessages, ["first queued", "second queued"]);

    assert.equal(runtime.popPendingMessage("s1"), "second queued");
    assert.deepEqual(tab.pendingMessages, ["first queued"]);
    release();
    await prompt;
    assert.ok(runtimeTab.chat.some((line) => line.text.includes("first queued")));
    tab.pendingMessages.push("preexisting pending");
    await runtime.flushPendingMessage("s1");
    assert.deepEqual(tab.pendingMessages, []);
    assert.ok(runtimeTab.chat.some((line) => line.text.includes("preexisting pending")));
    await runtime.flushPendingMessage("s1");
    assert.deepEqual(tab.pendingMessages, []);
  } finally {
    release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime pop removes matching Pi steering queue entries", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-pop-steer-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    const { prompt } = await startBlockedQueuePrompt(runtime, "s1");
    await runtime.prompt("s1", "first queued");
    await runtime.prompt("s1", "second queued");

    assert.equal(runtime.popPendingMessage("s1"), "second queued");
    assert.deepEqual(tab.pendingMessages, ["first queued"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], ["first queued"]);
    release();
    await prompt;
  } finally {
    release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime pop prefers follow-up over steer (Ctrl+U edit order)", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-pop-prefer-follow-up-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    const { prompt } = await startBlockedQueuePrompt(runtime, "s1");
    await runtime.prompt("s1", "steer queued");
    await runtimeTab.agentSession.followUp("follow-up from extension");

    // Ctrl+U edits the more-deferred follow-up first; steer stays queued.
    assert.equal(runtime.popPendingMessage("s1"), "follow-up from extension");
    assert.deepEqual(tab.pendingFollowUps, []);
    assert.equal(runtimeTab.queuedFollowUpCount, 0);
    assert.deepEqual([...runtimeTab.agentSession.getFollowUpMessages()], []);
    assert.deepEqual(tab.pendingMessages, ["steer queued"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], ["steer queued"]);

    assert.equal(runtime.popPendingMessage("s1"), "steer queued");
    assert.deepEqual(tab.pendingMessages, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], []);

    release();
    await prompt;
  } finally {
    release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime consecutive pops remove every returned steering message", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-pop-consecutive-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  let prompt: Promise<void> | undefined;
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    ({ prompt } = await startBlockedQueuePrompt(runtime, "s1"));
    await runtime.prompt("s1", "first queued");
    await runtime.prompt("s1", "second queued");
    await runtime.prompt("s1", "third queued");

    assert.deepEqual(
      [runtime.popPendingMessage("s1"), runtime.popPendingMessage("s1")],
      ["third queued", "second queued"],
    );
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.deepEqual(tab.pendingMessages, ["first queued"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], ["first queued"]);
  } finally {
    release();
    await prompt?.catch(() => undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime pop tolerates agent queue already drained for a tracked steer", async () => {
  // Pi drains agent.steeringQueue before message_start clears _steeringMessages.
  // Pop during that window must not throw or re-surface the delivered text.
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-pop-drained-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  let prompt: Promise<void> | undefined;
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    ({ prompt } = await startBlockedQueuePrompt(runtime, "s1"));
    await runtime.prompt("s1", "already drained");

    const session = runtimeTab.agentSession as unknown as {
      _steeringMessages: string[];
      agent: { steeringQueue: { messages: unknown[] } };
    };
    assert.deepEqual(session._steeringMessages, ["already drained"]);
    assert.equal(session.agent.steeringQueue.messages.length, 1);
    session.agent.steeringQueue.messages.splice(0); // simulate drain before message_start

    assert.equal(runtime.popPendingMessage("s1"), "already drained");
    assert.deepEqual(tab.pendingMessages, []);
    assert.deepEqual(session._steeringMessages, []);
    assert.deepEqual(session.agent.steeringQueue.messages, []);
  } finally {
    release();
    await prompt?.catch(() => undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime pop preserves an unrelated custom follow-up", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-pop-custom-follow-up-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  let prompt: Promise<void> | undefined;
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    ({ prompt } = await startBlockedQueuePrompt(runtime, "s1"));
    await runtime.prompt("s1", "edit me");
    await runtimeTab.agentSession.sendCustomMessage(
      {
        customType: "queue-test",
        content: [{ type: "text", text: "must survive" }],
        display: true,
        details: {},
      },
      { deliverAs: "followUp" },
    );

    assert.equal(runtimeTab.agentSession.agent.hasQueuedMessages(), true);
    assert.equal(runtime.popPendingMessage("s1"), "edit me");
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], []);
    assert.equal(runtimeTab.agentSession.agent.hasQueuedMessages(), true);
  } finally {
    release();
    await prompt?.catch(() => undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime waits for idle before flushing queued prompts", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-wait-idle-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    const { prompt } = await startBlockedQueuePrompt(runtime, "s1");
    tab.pendingMessages.push("queued prompt");
    runtimeTab.queuedPromptCount = 1;

    let flushed = false;
    const flush = runtime.flushPendingMessage("s1", 1).then(() => {
      flushed = true;
    });
    await Bun.sleep(20);
    assert.equal(flushed, false);

    release();
    await prompt;
    await flush;
    assert.equal(flushed, true);
    assert.deepEqual(tab.pendingMessages, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
    assert.ok(runtimeTab.chat.some((line) => line.text.includes("queued prompt")));
  } finally {
    release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime flush preserves unrelated Pi follow-up queue entries", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-flush-preserve-follow-up-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyAgent = runtimeTab.agentSession.agent as unknown as { _state: { isStreaming: boolean } };
    anyAgent._state.isStreaming = true;
    await runtime.prompt("s1", "steer queued");
    await runtimeTab.agentSession.followUp("follow-up from extension");
    anyAgent._state.isStreaming = false;
    (
      runtimeTab.agentSession.agent as unknown as {
        prompt: (messages: Array<{ content: Array<{ text?: string }> }>) => Promise<void>;
      }
    ).prompt = async () => {};

    await runtime.flushPendingMessage("s1", 1);

    assert.deepEqual(tab.pendingMessages, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
    assert.deepEqual([...runtimeTab.agentSession.getSteeringMessages()], []);
    assert.deepEqual([...runtimeTab.agentSession.getFollowUpMessages()], [
      "follow-up from extension",
    ]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime keeps queued prompts when flush prompt fails", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-fail-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    tab.pendingMessages.push("restored pending", "queued prompt");
    runtimeTab.queuedPromptCount = 1;
    let promptText = "";
    (
      runtimeTab.agentSession.agent as unknown as {
        prompt: (messages: Array<{ content: Array<{ text?: string }> }>) => Promise<void>;
      }
    ).prompt = async (messages) => {
      promptText = messages
        .map((message) => message.content.map((block) => block.text ?? "").join("\n"))
        .join("\n\n");
      throw new Error("queued prompt failed");
    };

    await assert.rejects(
      runtime.flushPendingMessage("s1", runtimeTab.queuedPromptCount),
      /queued prompt failed/,
    );

    assert.equal(promptText, "queued prompt");
    assert.deepEqual(tab.pendingMessages, ["restored pending", "queued prompt"]);
    assert.equal(runtimeTab.queuedPromptCount, 1);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime flush syncs pending messages from Pi steering queue first", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-queue-sync-"));
  const { runtime, release, model } = createBlockedQueueRuntime(dir);
  try {
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model,
    });
    const { prompt } = await startBlockedQueuePrompt(runtime, "s1");
    await runtime.prompt("s1", "queued prompt");
    assert.deepEqual(tab.pendingMessages, ["queued prompt"]);
    // Simulate local state getting out of sync.
    tab.pendingMessages = [];
    runtimeTab.queuedPromptCount = 0;

    const flush = runtime.flushPendingMessage("s1", 1);
    release();
    await prompt;
    await flush;

    assert.ok(runtimeTab.chat.some((line) => line.text.includes("queued prompt")));
    assert.deepEqual(tab.pendingMessages, []);
    assert.equal(runtimeTab.queuedPromptCount, 0);
  } finally {
    release();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
