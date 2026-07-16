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

test("runtime extension reload rejects active streaming or compaction state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-reload-busy-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    Object.defineProperty(runtimeTab.agentSession, "isStreaming", {
      configurable: true,
      get: () => true,
    });
    await assert.rejects(() => runtime.extensionReload("s1"), /streaming/);

    Object.defineProperty(runtimeTab.agentSession, "isStreaming", {
      configurable: true,
      get: () => false,
    });
    Object.defineProperty(runtimeTab.agentSession, "isCompacting", {
      configurable: true,
      get: () => true,
    });
    await assert.rejects(() => runtime.extensionReload("s1"), /compaction/);

    delete (runtimeTab.agentSession as unknown as { isStreaming?: boolean }).isStreaming;
    delete (runtimeTab.agentSession as unknown as { isCompacting?: boolean }).isCompacting;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime wires pi extension command session actions into MixCode sessions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-actions-"));
  const events: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("new-action-session", {
      description: "Create a replacement session",
      handler: async (_args, ctx) => {
        await ctx.waitForIdle();
        const result = await ctx.newSession({
          parentSession: "parent-session.jsonl",
          setup: async (session) => {
            events.push(`setup:${session.getHeader()?.parentSession ?? "none"}`);
            session.appendMessage({ role: "user", content: "setup prompt", timestamp: Date.now() });
          },
          withSession: async (replacementCtx) => {
            events.push(`with-new:${replacementCtx.sessionManager.getSessionId()}`);
            await replacementCtx.sendMessage({
              customType: "replacement-note",
              content: "fresh context",
              display: true,
            });
          },
        });
        events.push(`new-result:${result.cancelled}`);
      },
    });
    pi.registerCommand("navigate-action-session", {
      description: "Navigate inside a session tree",
      handler: async (args, ctx) => {
        const result = await ctx.navigateTree(args.trim());
        events.push(`navigate:${result.cancelled}`);
      },
    });
    pi.registerCommand("fork-action-session", {
      description: "Fork from a user message",
      handler: async (args, ctx) => {
        const result = await ctx.fork(args.trim(), {
          withSession: async (replacementCtx) => {
            events.push(`with-fork:${replacementCtx.sessionManager.getSessionId()}`);
          },
        });
        events.push(`fork:${result.cancelled}`);
      },
    });
    pi.registerCommand("switch-action-session", {
      description: "Switch to a session file",
      handler: async (args, ctx) => {
        const result = await ctx.switchSession(args.trim(), {
          withSession: async (replacementCtx) => {
            events.push(`with-switch:${replacementCtx.sessionManager.getSessionId()}`);
          },
        });
        events.push(`switch:${result.cancelled}`);
      },
    });
    pi.on("session_start", (event) => events.push(`start:${event.reason}`));
    pi.on("session_before_switch", (event) => events.push(`before-switch:${event.reason}`));
    pi.on("session_before_fork", (event) =>
      events.push(`before-fork:${event.entryId}:${event.position}`),
    );
    pi.on("session_tree", (event) => events.push(`tree:${event.newLeafId ?? "root"}`));
    pi.on("session_shutdown", (event, ctx) =>
      events.push(
        `shutdown:${event.reason}:${event.targetSessionFile ? "target" : "none"}:${ctx.sessionManager.getSessionId()}`,
      ),
    );
    pi.registerMessageRenderer(
      "replacement-note",
      (message) => new Text(`replacement ${message.content}`, 0, 0),
    );
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    await runtime.prompt("s1", "/new-action-session");
    const afterNew = runtime.listTabs()[0]!;
    assert.equal(runtime.getTab("s1"), undefined);
    assert.equal(afterNew.session.getHeader()?.parentSession, "parent-session.jsonl");
    assert.equal(
      afterNew.chat.some((line) => line.role === "user" && line.text === "setup prompt"),
      true,
    );
    assert.match(
      renderAgentSurface(afterNew.tab, afterNew, 100).join("\n"),
      /replacement fresh context/,
    );

    const rootUserId = afterNew.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(rootUserId);
    await runtime.prompt(afterNew.tab.sessionId, "child prompt");
    assert.equal(
      afterNew.chat.some((line) => line.role === "user" && line.text === "child prompt"),
      true,
    );
    runtime.setExtensionUiHost({
      tui: new TUI(silentTerminal()),
      editor: {
        getText: () => "",
        setText: (text) => events.push(`editor:${text}`),
        pasteToEditor: () => undefined,
      },
    });
    await runtime.prompt(afterNew.tab.sessionId, `/navigate-action-session ${rootUserId}`);
    assert.equal(
      afterNew.chat.some((line) => line.role === "user" && line.text === "child prompt"),
      false,
    );
    assert.ok(events.includes("editor:setup prompt"));

    await runtime.prompt(afterNew.tab.sessionId, "fork base prompt");
    const activeUserId = afterNew.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(activeUserId);
    const beforeForkSessionId = afterNew.tab.sessionId;
    await runtime.prompt(afterNew.tab.sessionId, `/fork-action-session ${activeUserId}`);
    const afterFork = runtime.listTabs()[0]!;
    assert.notEqual(afterFork.tab.sessionId, beforeForkSessionId);
    assert.equal(
      afterFork.chat.some((line) => line.role === "user" && line.text === "setup prompt"),
      false,
    );
    assert.ok(events.includes("editor:setup prompt"));

    const switchTarget = await runtime.forkSession(afterFork.tab.sessionId, "switch-target");
    switchTarget.appendMessage({ role: "user", content: "switched prompt", timestamp: Date.now() });
    switchTarget.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "switched reply" }],
      api: MIXCODE_FAUX_MODEL.api,
      provider: MIXCODE_FAUX_MODEL.provider,
      model: MIXCODE_FAUX_MODEL.id,
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
    });
    const switchFile = switchTarget.getSessionFile();
    assert.ok(switchFile);
    await runtime.prompt(afterFork.tab.sessionId, `/switch-action-session ${switchFile}`);
    const afterSwitch = runtime.listTabs()[0]!;
    assert.equal(afterSwitch.tab.sessionId, "switch-target");
    assert.equal(
      afterSwitch.chat.some((line) => line.role === "user" && line.text === "switched prompt"),
      true,
    );

    assert.ok(events.includes("start:startup"));
    assert.ok(events.includes("before-switch:new"));
    assert.ok(events.includes("shutdown:new:target:s1"));
    assert.ok(events.includes("start:new"));
    assert.ok(events.includes("new-result:false"));
    assert.ok(events.indexOf("shutdown:new:target:s1") < events.indexOf("start:new"));
    assert.ok(events.some((event) => event.startsWith("tree:")));
    assert.ok(events.includes(`before-fork:${activeUserId}:before`));
    assert.ok(events.some((event) => event.startsWith("shutdown:fork:target:")));
    assert.ok(events.includes("start:fork"));
    assert.ok(events.includes("fork:false"));
    assert.ok(events.includes("before-switch:resume"));
    assert.ok(events.some((event) => event.startsWith("shutdown:resume:target:")));
    assert.ok(events.includes("start:resume"));
    assert.ok(events.includes("switch:false"));
    runtime.setExtensionUiHost(undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension newSession works without optional parent setup or callback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-new-plain-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    await runtime.createTab(createTab(1, "plain", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });

    const result = await runtime.extensionNewSession("plain");
    const replacement = runtime.listTabs()[0]!;
    assert.equal(result.cancelled, false);
    assert.equal(runtime.getTab("plain"), undefined);
    assert.notEqual(replacement.tab.sessionId, "plain");
    assert.equal(replacement.session.getHeader()?.parentSession, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension session actions expose cancellation and boundary errors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-extension-action-boundaries-"));
  const events: string[] = [];
  let forkCancelEntryId: string | undefined;
  let cancelNextResume = false;
  const extension: ExtensionFactory = (pi) => {
    pi.on("session_before_switch", (event) => {
      events.push(`before-switch:${event.reason}:${event.targetSessionFile ? "target" : "none"}`);
      if (event.reason === "new") return { cancel: true };
      if (event.reason === "resume" && cancelNextResume) return { cancel: true };
      return undefined;
    });
    pi.on("session_before_fork", (event) => {
      events.push(`before-fork:${event.entryId}:${event.position}`);
      if (event.entryId === forkCancelEntryId) return { cancel: true };
      return undefined;
    });
    pi.on("session_shutdown", (event) => events.push(`shutdown:${event.reason}`));
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "root message");
    const userId = runtimeTab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    const assistantId = runtimeTab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "assistant")?.id;
    assert.ok(userId);
    assert.ok(assistantId);
    forkCancelEntryId = userId;

    assert.deepEqual(await runtime.extensionNewSession("s1"), { cancelled: true });
    assert.equal(runtime.getTab("s1"), runtimeTab);

    assert.deepEqual(await runtime.extensionFork("s1", userId), { cancelled: true });
    assert.equal(runtime.getTab("s1"), runtimeTab);

    await assert.rejects(() => runtime.extensionFork("s1", "missing-entry"), /Invalid entry ID/);
    await assert.rejects(() => runtime.extensionFork("s1", assistantId), /Invalid entry ID/);
    await assert.rejects(
      () => runtime.extensionSwitchSession("s1", join(dir, "missing.jsonl")),
      /Session file not found/,
    );
    const importPath = join(dir, "cancel-import.jsonl");
    await writeFile(
      importPath,
      `${JSON.stringify({ type: "session", version: 3, id: "cancel-import", timestamp: "2026-05-10T00:00:00.000Z", cwd: process.cwd() })}\n`,
      "utf8",
    );
    cancelNextResume = true;
    assert.deepEqual(await runtime.importFromJsonl("s1", importPath), { cancelled: true });
    assert.equal(runtime.getTab("s1"), runtimeTab);
    assert.deepEqual(events, [
      "before-switch:new:none",
      `before-fork:${userId}:before`,
      "before-switch:resume:target",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
