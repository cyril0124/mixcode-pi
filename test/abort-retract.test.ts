import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
  Type,
  createAssistantMessageEventStream,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  MIXCODE_FAUX_MODEL,
  type MixCodeModel,
  MixCodeRuntime,
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
} from "./helpers/mixcode.js";
import type { ExtensionCustomUiHost, } from "../src/agent/runtime-types.js";
import { testTui } from "./helpers/tui.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";

// RuntimeTab double: member names/signatures stay checked against production;
// agentSession/session are class instances, so they get their own Partial.
// Retract only reaches host.editor; `tui` is required by the interface but never
// touched on this path, so the double omits it while keeping editor checked.
function testExtensionUiHost(stub: Omit<ExtensionCustomUiHost, "tui">): ExtensionCustomUiHost {
  return stub as ExtensionCustomUiHost;
}

// Stream that stays open (never produces text) until aborted or `release` resolves,
// so the run is genuinely mid-flight with zero visible output when we abort it.
function pendingStream(release: Promise<void>, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "retract-test",
      provider: "retract-test",
      model: "retract-test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    // End as soon as the run is aborted (signal fires) or the test releases it.
    await Promise.race([
      release,
      new Promise<void>((resolve) => {
        if (options?.signal?.aborted) return resolve();
        options?.signal?.addEventListener("abort", () => resolve(), { once: true });
      }),
    ]);
    const aborted = {
      ...message,
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return;
    }
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

// Like pendingStream, but after the abort signal the provider still takes delayMs
// to close — models the real-world lag that made double-Esc retract feel sticky.
function delayedAbortStream(delayMs: number, options?: SimpleStreamOptions) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(async () => {
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "retract-test",
      provider: "retract-test",
      model: "retract-test-model",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: Date.now(),
    };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    await new Promise<void>((resolve) => {
      if (options?.signal?.aborted) return resolve();
      options?.signal?.addEventListener("abort", () => resolve(), { once: true });
    });
    if (delayMs > 0) await Bun.sleep(delayMs);
    const aborted = {
      ...message,
      stopReason: "aborted" as const,
      errorMessage: "Request was aborted",
    };
    stream.push({ type: "error", reason: "aborted", error: aborted });
    stream.end(aborted);
  });
  return stream;
}

function fauxModel(): MixCodeModel {
  return { ...MIXCODE_FAUX_MODEL, provider: "retract-test", api: "retract-test", id: "retract-test-model" };
}

function baseAssistantMessage(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "retract-test",
    provider: "retract-test",
    model: "retract-test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

// Completed assistant message stream with the given content blocks.
function completedStream(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop") {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const message: AssistantMessage = { ...baseAssistantMessage(), content, stopReason };
    stream.push({ type: "start", partial: { ...message, content: [] } });
    stream.push({ type: "done", reason: "stop", message });
    stream.end(message);
  });
  return stream;
}

async function waitFor(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

test("retractCurrentTurn rewinds the leaf and returns the user message text when no output was produced", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retract-"));
  try {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) =>
        pendingStream(released, options),
    });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: fauxModel(),
    });

    const branchBefore = runtimeTab.session.getBranch().length;
    const pending = runtime.prompt("s1", "please retract me");
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === true);
    // The submitted user message is now part of the branch.
    assert.ok(runtimeTab.session.getBranch().some((e) => e.type === "message" && e.message.role === "user"));

    const result = await runtime.retractCurrentTurn("s1");
    release();
    await pending.catch(() => undefined);

    assert.equal(result?.editorText, "please retract me");
    // Leaf rewound to before the user message: branch is back to its pre-prompt length,
    // and no user message remains on the active branch.
    await waitFor(() => runtimeTab.session.getBranch().length === branchBefore);
    assert.equal(
      runtimeTab.session.getBranch().some((e) => e.type === "message" && e.message.role === "user"),
      false,
    );
    // Context sent to the model no longer contains the retracted message.
    assert.equal(
      runtimeTab.agentSession.agent.state.messages.some(
        (m) => m.role === "user" && JSON.stringify(m.content).includes("please retract me"),
      ),
      false,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("retractCurrentTurn returns undefined once the assistant has produced visible output", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retract-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      // Unmodified faux model (provider "faux") echoes a reply without needing auth.
      model: MIXCODE_FAUX_MODEL,
    });
    // Default faux model echoes a reply, so the turn completes with assistant text.
    await runtime.prompt("s1", "answer me");
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === false);
    assert.ok(runtimeTab.chat.some((line) => line.role === "assistant" && line.text.trim()));

    const result = await runtime.retractCurrentTurn("s1");
    assert.equal(result, undefined);
    // User message stays in history.
    assert.ok(
      runtimeTab.session.getBranch().some((e) => e.type === "message" && e.message.role === "user"),
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("retractCurrentTurn refuses a run triggered by an extension custom message", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retract-custom-"));
  try {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
        calls += 1;
        // Turn 1 (user prompt) completes with text; turn 2 (extension custom
        // message) stays mid-flight with zero output.
        if (calls === 1) return completedStream([{ type: "text", text: "FIRST_TURN_DONE" }]);
        return pendingStream(released, options);
      },
    });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: fauxModel(),
    });

    await runtime.prompt("s1", "hello first turn");
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === false);
    const branchAfterFirstTurn = runtimeTab.session.getBranch().length;

    // Extension-originated prompt: hidden custom message that triggers a turn.
    const customRun = runtimeTab.agentSession.sendCustomMessage(
      { customType: "retract-test", content: "EXTENSION_PROMPT", display: false },
      { triggerTurn: true },
    );
    // Wait until the run marker is armed, not just isStreaming: retract reads
    // currentRunChatStartIndex, which is set when agent_start is applied.
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === true);
    await waitFor(() => runtimeTab.currentRunChatStartIndex !== undefined);

    // This run has no user message of its own; rewinding to "hello first turn"
    // would wipe the completed first turn. Retract must refuse.
    const result = await runtime.retractCurrentTurn("s1");
    assert.equal(result, undefined);
    assert.ok(runtimeTab.session.getBranch().length >= branchAfterFirstTurn);
    assert.ok(
      runtimeTab.session
        .getBranch()
        .some(
          (e) =>
            e.type === "message" &&
            e.message.role === "user" &&
            JSON.stringify(e.message.content).includes("hello first turn"),
        ),
    );

    await runtimeTab.agentSession.abort();
    release();
    await customRun.catch(() => undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("retractCurrentTurn refuses once a tool execution has started, even with no text output", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retract-tool-"));
  try {
    let releaseTool!: () => void;
    const toolReleased = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const slowToolExtension: ExtensionFactory = (pi) => {
      pi.registerTool({
        name: "slow_probe",
        label: "Slow Probe",
        description: "Waits until released or aborted; no partial output.",
        parameters: Type.Object({}),
        async execute(_toolCallId, _params, signal) {
          await Promise.race([
            toolReleased,
            new Promise<void>((resolve) => {
              if (signal?.aborted) return resolve();
              signal?.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
          if (signal?.aborted) throw new Error("slow_probe aborted");
          return { content: [{ type: "text" as const, text: "probe done" }], details: undefined };
        },
      });
    };
    let calls = 0;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      extensionFactories: [slowToolExtension],
      streamFn: (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
        calls += 1;
        // First assistant message: tool call only, no text. Later calls stay
        // pending so the run is still mid-flight if the tool ever finishes.
        if (calls === 1) {
          return completedStream([fauxToolCall("slow_probe", {})], "toolUse");
        }
        return pendingStream(new Promise<void>(() => undefined), options);
      },
    });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: fauxModel(),
    });

    const pending = runtime.prompt("s1", "run the slow tool");
    // Tool call is on screen and executing: visible progress, not a blank turn.
    await waitFor(
      () => runtimeTab.chat.some((line) => line.role === "tool" && line.status === "running"),
      200,
    );

    const result = await runtime.retractCurrentTurn("s1");
    assert.equal(result, undefined);
    // The user prompt survives on the branch.
    assert.ok(
      runtimeTab.session.getBranch().some((e) => e.type === "message" && e.message.role === "user"),
    );

    await runtimeTab.agentSession.abort();
    releaseTool();
    await pending.catch(() => undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("double escape with no assistant output retracts the message into an empty editor", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  let editorText = "";
  const tui = testTui({ hasOverlay: () => false });
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => {
      aborts++;
      return true;
    },
    // Eligible: returns text. Retract owns the abort, so the handler must NOT abortTab.
    retractCurrentTurn: async () => ({ editorText: "please retract me" }),
  });
  const editorActions = {
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
  };

  // First Esc arms the abort prompt.
  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  assert.equal(typeof tab.pendingEscapeArmedAt, "number");
  // Second Esc retracts because the turn produced no output; no separate abort.
  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  await waitFor(() => editorText === "please retract me");
  assert.equal(aborts, 0);
});

test("double escape falls back to plain abort when the turn already has output", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  let editorText = "";
  const tui = testTui({ hasOverlay: () => false });
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => {
      aborts++;
      return true;
    },
    // Not eligible: returns undefined, so the handler performs a normal abort.
    retractCurrentTurn: async () => undefined,
  });
  const editorActions = {
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
  };

  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  await waitFor(() => aborts === 1);
  assert.equal(editorText, "");
});

test("double escape does not clobber a non-empty editor draft on retract", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  let retractCalls = 0;
  let editorText = "draft I am typing";
  const tui = testTui({ hasOverlay: () => false });
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => {
      aborts++;
      return true;
    },
    retractCurrentTurn: async () => {
      retractCalls++;
      return { editorText: "please retract me" };
    },
  });
  const editorActions = {
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
  };

  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  // Plain abort, no retract attempted, draft untouched.
  assert.equal(aborts, 1);
  await Bun.sleep(20);
  assert.equal(retractCalls, 0);
  assert.equal(editorText, "draft I am typing");
});

test("retractCurrentTurn restores editor text before a delayed abort settles", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-retract-optimistic-"));
  try {
    let editorText = "";
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) =>
        delayedAbortStream(300, options),
    });
    runtime.setExtensionUiHost(
      testExtensionUiHost({
        editor: {
          getText: () => editorText,
          setText: (text: string) => {
            editorText = text;
          },
          pasteToEditor: (text: string) => {
            editorText += text;
          },
        },
      }),
    );
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: fauxModel(),
    });

    const branchBefore = runtimeTab.session.getBranch().length;
    const pending = runtime.prompt("s1", "please retract me");
    await waitFor(() => runtimeTab.agentSession.agent.state.isStreaming === true);

    let settled = false;
    const retractPromise = runtime.retractCurrentTurn("s1").then((result) => {
      settled = true;
      return result;
    });

    // Editor must refill while abort is still in flight — not only after settle.
    await waitFor(() => editorText === "please retract me");
    assert.equal(settled, false, "editor refill must not wait for abort idle");

    const result = await retractPromise;
    await pending.catch(() => undefined);

    assert.equal(result?.editorText, "please retract me");
    await waitFor(() => runtimeTab.session.getBranch().length === branchBefore);
    assert.equal(
      runtimeTab.session.getBranch().some((e) => e.type === "message" && e.message.role === "user"),
      false,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("double escape requests a render immediately when starting retract", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  let resolveRetract!: (value: { editorText: string }) => void;
  const retractStarted = new Promise<{ editorText: string }>((resolve) => {
    resolveRetract = resolve;
  });
  const tui = testTui({
    requestRender: () => {
      renders++;
    },
    hasOverlay: () => false,
  });
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => true,
    // Stay pending so the immediate render cannot be credited to settle-time setText.
    retractCurrentTurn: () => retractStarted,
  });
  const editorActions = {
    getText: () => "",
    setText: () => undefined,
  };

  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  const rendersAfterArm = renders;
  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  assert.ok(renders > rendersAfterArm, "confirming Esc must requestRender before retract settles");
  resolveRetract({ editorText: "please retract me" });
});
