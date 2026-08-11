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
  createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
} from "../src/index.js";

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

function fauxModel(): Model<string> {
  return { ...MIXCODE_FAUX_MODEL, provider: "retract-test", api: "retract-test", id: "retract-test-model" };
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
    await waitFor(() => runtimeTab.agent.state.isStreaming === true);
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
      runtimeTab.agent.state.messages.some(
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
    await waitFor(() => runtimeTab.agent.state.isStreaming === false);
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

test("double escape with no assistant output retracts the message into an empty editor", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  let editorText = "";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
    // Eligible: returns text. Retract owns the abort, so the handler must NOT abortTab.
    retractCurrentTurn: async () => ({ editorText: "please retract me" }),
  };
  const editorActions = {
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
  };

  // First Esc arms the abort prompt.
  handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime, undefined, () => false, editorActions);
  assert.equal(tab.pendingEscapeAction, "abort-agent");
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
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
    // Not eligible: returns undefined, so the handler performs a normal abort.
    retractCurrentTurn: async () => undefined,
  };
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
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
    retractCurrentTurn: async () => {
      retractCalls++;
      return { editorText: "please retract me" };
    },
  };
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
    runtime.setExtensionUiHost({
      editor: {
        getText: () => editorText,
        setText: (text: string) => {
          editorText = text;
        },
      },
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
    await waitFor(() => runtimeTab.agent.state.isStreaming === true);

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
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => true,
    // Stay pending so the immediate render cannot be credited to settle-time setText.
    retractCurrentTurn: () => retractStarted,
  };
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
