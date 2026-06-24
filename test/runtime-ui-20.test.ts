import "./helpers/isolated-agent-dir.js";
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

test("runtime restores a session whose filename id differs from its header id", async () => {
  // Repro for the "Agent Tab empty after restart while Home preview still shows
  // the conversation" bug. Some persisted session files have a filename id
  // (the MixCode tab sessionId) that no longer matches the JSONL header id
  // (created by SessionManager.create before newSession rewrote it). Looking
  // sessions up purely by header id makes openOrCreateSession miss the real
  // file and create an empty session, dropping the whole conversation.
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-id-mismatch-"));
  try {
    const workdir = join(dir, "wd");
    await mkdir(workdir, { recursive: true });
    const sessionFile = join(dir, "2026-06-04T00-00-00-000Z_session-12345.jsonl");
    const entries = [
      {
        type: "session",
        version: 3,
        id: "019e0000-aaaa-7000-8000-000000000000",
        timestamp: "2026-06-04T00:00:00.000Z",
        cwd: workdir,
      },
      {
        type: "message",
        id: "m1",
        parentId: null,
        timestamp: "2026-06-04T00:00:01.000Z",
        message: { role: "user", content: "recover me please", timestamp: 1 },
      },
      {
        type: "message",
        id: "m2",
        parentId: "m1",
        timestamp: "2026-06-04T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "the real answer" }],
          provider: "faux",
          model: "faux-1",
          timestamp: 2,
        },
      },
    ];
    await writeFile(sessionFile, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`, "utf8");

    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const restored = await runtime.createTab(createTab(1, "session-12345", workdir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir,
    });

    assert.equal(restored.session.getSessionFile(), sessionFile);
    assert.match(restored.chat.map((line) => line.text).join("\n"), /the real answer/);
    assert.equal(
      restored.session.getBranch().filter((entry) => entry.type === "message").length,
      2,
    );
    await runtime.closeAllTabs();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime clear replaces the active pi session and resets tab state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-clear-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd(), {
      pendingMessages: ["queued"],
      previewMessages: [{ role: "assistant", text: "old preview" }],
      previewIndex: 0,
      previewScrollOffset: 4,
      previewHint: "old hint",
      unreadDone: true,
      status: "done",
    });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.equal(runtime.getTab("s1")?.chat[0]?.role, "startup");
    await runtime.prompt("s1", "old message");

    const cleared = await runtime.clearTab("s1", {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      newSessionId: "s1-clear",
    });

    assert.equal(cleared.tab.sessionId, "s1-clear");
    assert.equal(runtime.getTab("s1"), undefined);
    assert.equal(runtime.getTab("s1-clear"), cleared);
    assert.deepEqual(cleared.chat, []);
    assert.equal(
      cleared.chat.some((line) => line.role === "startup"),
      false,
    );
    assert.deepEqual(cleared.reasoning, []);
    assert.deepEqual(tab.pendingMessages, []);
    assert.deepEqual(tab.previewMessages, []);
    assert.equal(tab.previewScrollOffset, 0);
    assert.equal(tab.previewHint, "");
    assert.equal(tab.unreadDone, false);
    assert.equal(tab.status, "idle");
    await assert.rejects(runtime.prompt("s1", "after clear"), /Unknown tab session/);
    await runtime.prompt("s1-clear", "");
    assert.equal(
      cleared.chat.some((line) => line.role === "user" && line.text.trim() === ""),
      false,
    );
    await runtime.prompt("s1-clear", "new message");
    assert.match(cleared.chat.map((line) => line.text).join("\n"), /new message/);
    assert.ok(
      !cleared.chat
        .map((line) => line.text)
        .join("\n")
        .includes("old message"),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime clear rejects active streaming sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-clear-busy-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const anyAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };
    anyAgent._state.isStreaming = true;
    await assert.rejects(
      runtime.clearTab("s1", {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: process.cwd(),
      }),
      /Cannot clear a session while it is streaming/,
    );
    await assert.rejects(
      () => runtime.extensionNewSession("s1"),
      /Cannot replace a session while the agent is streaming: new/,
    );
    anyAgent._state.isStreaming = false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime rejects compaction when there is no useful history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "empty", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await assert.rejects(runtime.compactSession("empty"), /Nothing to compact/);
    // After compacting once, re-compacting immediately should be rejected.
    // Shrink the keep-recent window so the single "hello" turn is compactable
    // under SDK 0.80+ (which otherwise refuses a session that fits the window).
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    await runtime.prompt("empty", "hello");
    await runtime.compactSession("empty");
    await assert.rejects(runtime.compactSession("empty"), /already compacted/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime deletes all tracked tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.createTab(createTab(2, "s2", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.equal(runtime.listTabs().length, 2);
    await runtime.deleteAllTabs();
    assert.equal(runtime.listTabs().length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime accepts an explicit model and renders pi content blocks as separate UI messages", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const explicit: Model<string> = { ...MIXCODE_FAUX_MODEL, id: "explicit" };
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
    model: explicit,
  });
  assert.equal(runtimeTab.agent.state.model.id, "explicit");
  const anyRuntime = runtime as unknown as {
    applyEvent: (runtimeTab: unknown, event: unknown) => void;
  };
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "assistant text" },
        { type: "thinking", thinking: "hmm" },
        { type: "thinking", thinking: "", redacted: true },
        { type: "toolCall", id: "tc", name: "img", arguments: {} },
        { type: "toolCall", id: "tc2", name: "plain", arguments: {} },
        { type: "toolCall", id: "1", name: "read", arguments: { filePath: "src/index.ts" } },
        { type: "toolCall", id: "2", arguments: {} } as never,
      ],
      api: "x",
      provider: "x",
      model: "x",
      usage: {
        input: 1,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 3,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "toolUse",
      timestamp: Date.now(),
    },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "toolResult",
      toolCallId: "tc",
      toolName: "img",
      content: [{ type: "image", mimeType: "image/png", data: "x" }],
      isError: false,
      timestamp: Date.now(),
    },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "toolResult",
      toolCallId: "tc2",
      toolName: "",
      content: "plain text",
      isError: false,
      timestamp: Date.now(),
    },
  });
  anyRuntime.applyEvent(runtimeTab, {
    type: "message_start",
    message: {
      role: "toolResult",
      toolCallId: "missing-tool-call",
      toolName: "",
      content: [{ type: "text", text: "ignored orphan" }],
      isError: true,
      timestamp: Date.now(),
    },
  });
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "img" && line.text.includes("[image]"),
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "plain" && line.text.includes("plain text"),
    ),
  );
  assert.equal(
    runtimeTab.chat.some((line) => line.role === "tool" && line.text.includes("ignored orphan")),
    false,
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "assistant" && line.text.includes("assistant text"),
    ),
  );
  assert.ok(runtimeTab.chat.some((line) => line.role === "thinking" && line.text.includes("hmm")));
  assert.ok(
    runtimeTab.chat.some((line) => line.role === "thinking" && line.text.includes("redacted")),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) =>
        line.role === "tool" &&
        line.title === "read" &&
        line.status === "pending" &&
        (line.args as { filePath?: string }).filePath === "src/index.ts",
    ),
  );
  assert.ok(
    runtimeTab.chat.some(
      (line) => line.role === "tool" && line.title === "unknown" && line.status === "pending",
    ),
  );
  assert.equal(
    runtimeTab.chat.some((line) => line.role === "assistant" && line.text.includes("[tool:")),
    false,
  );
  assert.equal(runtime.resolveModel("openai", "missing"), undefined);
});

test("runtime leaves streamFn unset for non-faux explicit models", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const explicit: Model<string> = {
    ...MIXCODE_FAUX_MODEL,
    provider: "custom",
    api: "custom",
    id: "custom-model",
  };
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
    model: explicit,
  });
  assert.equal(runtimeTab.agent.state.model.provider, "custom");
});

test("runtime updates tab model and rejects changes while streaming", async () => {
  const runtime = new MixCodeRuntime();
  const tab = createTab(1, "s1", process.cwd());
  const runtimeTab = await runtime.createTab(tab, {
    systemPrompt: "system",
    thinkingLevel: "medium",
    workdir: process.cwd(),
  });
  const model: Model<string> = {
    ...MIXCODE_FAUX_MODEL,
    provider: "custom",
    api: "custom",
    id: "custom-model",
    contextWindow: 12345,
  };
  runtime.updateTabModel("s1", model);
  assert.equal(runtimeTab.agent.state.model.id, "custom-model");
  assert.equal(tab.model.displayName, "custom/custom-model");
  assert.equal(tab.contextLimit, 12345);

  const anyAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };
  anyAgent._state.isStreaming = true;
  assert.throws(() => runtime.updateTabModel("s1", model), /Cannot change model/);
  anyAgent._state.isStreaming = false;
});

test("runtime updates workdir, system prompt, and tool closures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-"));
  const oldDir = join(dir, "old");
  const newDir = join(dir, "new");
  try {
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeFile(join(oldDir, "marker.txt"), "old", "utf8");
    await writeFile(join(newDir, "marker.txt"), "new", "utf8");
    const runtime = new MixCodeRuntime({ sessionsRoot: join(dir, "sessions") });
    const tab = createTab(1, "s1", oldDir);
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: oldDir,
    });

    await runtime.updateTabWorkdir("s1", newDir, "system");
    assert.equal(tab.workdir, newDir);
    assert.equal(runtimeTab.session.getCwd(), newDir);
    assert.equal(runtimeTab.agentSession.sessionManager.getCwd(), newDir);
    assert.match(
      runtimeTab.agent.state.systemPrompt,
      new RegExp(`Current working directory: ${escapeRegExp(newDir)}`),
    );
    const readTool = runtimeTab.agent.state.tools.find((tool) => tool.name === "read");
    assert.ok(readTool);
    const result = await readTool.execute("call-1", { path: "marker.txt" });
    assert.deepEqual(result.content, [{ type: "text", text: "new" }]);

    const anyAgent = runtimeTab.agent as unknown as { _state: { isStreaming: boolean } };
    anyAgent._state.isStreaming = true;
    await assert.rejects(runtime.updateTabWorkdir("s1", oldDir, "system"), /Cannot change workdir/);
    anyAgent._state.isStreaming = false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
