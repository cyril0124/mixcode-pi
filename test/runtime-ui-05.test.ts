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

test("runtime creates pi agent sessions, streams default response, and records session messages", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-"));
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.equal(runtime.listTabs().length, 1);
    await runtime.prompt("s1", "hello");
    assert.equal(tab.status, "idle");
    assert.equal(tab.unreadDone, true);
    assert.ok(tab.previewMessages.some((message) => message.text.includes("hello")));
    assert.match(runtimeTab.chat.map((line) => line.text).join("\n"), /hello/);
    const entries = runtimeTab.session.getEntries();
    assert.ok(entries.length >= 2);
    await assert.rejects(runtime.prompt("missing", "x"), /Unknown tab session/);
    const reopened = new MixCodeRuntime({ sessionsRoot: dir });
    const reopenedTab = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.ok(reopenedTab.session.getEntries().length >= 2);
    assert.match(reopenedTab.chat.map((line) => line.text).join("\n"), /hello/);
    assert.equal(reopenedTab.tab.currentContextTokens !== undefined, true);
    assert.equal(reopenedTab.tab.contextLimit, MIXCODE_FAUX_MODEL.contextWindow);
    assert.match(
      reopenedTab.tab.previewMessages.map((message) => message.text).join("\n"),
      /hello/,
    );
    assert.deepEqual(reopened.getPromptHistory("s1"), ["hello"]);
    reopenedTab.session.appendCustomEntry("ui-note", { text: "not chat" });
    const reopenedAgain = new MixCodeRuntime({ sessionsRoot: dir });
    const reopenedAgainTab = await reopenedAgain.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.equal(
      reopenedAgainTab.chat.some((line) => line.text.includes("not chat")),
      false,
    );
    runtimeTab.session.appendMessage({
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      content: [{ type: "text", text: "tool summary text" }],
      isError: false,
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "custom",
      customType: "note",
      content: "custom text",
      display: true,
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "custom",
      customType: "array-note",
      content: [{ type: "text", text: "array custom text" }],
      display: true,
      timestamp: Date.now(),
    });
    runtimeTab.session.appendMessage({
      role: "bashExecution",
      command: "pwd",
      output: "bash output",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: Date.now(),
    });
    const reopenedBash = new MixCodeRuntime({ sessionsRoot: dir });
    const reopenedBashTab = await reopenedBash.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const reopenedBashRendered = renderChat(reopenedBashTab.chat, 80).join("\n");
    assert.match(reopenedBashRendered, /\$ pwd/);
    assert.match(reopenedBashRendered, /bash output/);
    await runtime.compactSession("s1", "preserve user intent");
    const compactedBranch = runtimeTab.session.getBranch();
    assert.equal(compactedBranch.at(-1)?.type, "compaction");
    const compactedContext = runtimeTab.session.buildSessionContext();
    assert.match(
      compactedContext.messages[0]?.role === "compactionSummary"
        ? compactedContext.messages[0].summary
        : "",
      /preserve user intent/,
    );
    assert.doesNotMatch(
      compactedContext.messages[0]?.role === "compactionSummary"
        ? compactedContext.messages[0].summary
        : "",
      /Extractive summary/,
    );
    assert.ok(runtimeTab.chat.some((line) => line.compactionSummary === true));
    const forked = await runtime.forkSession("s1", "s2");
    assert.equal(forked.getSessionId(), "s2");
    assert.equal(runtime.resolveModel("faux", "").id, "faux-1");
    await runtime.prompt("s1", "second message");
    await runtime.deleteTab("s1");
    assert.equal(runtime.getTab("s1"), undefined);
    await assert.rejects(runtime.deleteTab("s1"), /Unknown tab session/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime imports pi session JSONL into the active tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-import-"));
  const importedCwd = join(dir, "imported-cwd");
  try {
    await mkdir(importedCwd, { recursive: true });
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const tab = createTab(1, "s1", process.cwd());
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const importPath = join(dir, "external-session.jsonl");
    await writeFile(
      importPath,
      [
        JSON.stringify({
          type: "session",
          version: 3,
          id: "imported-session",
          timestamp: "2026-05-10T00:00:00.000Z",
          cwd: importedCwd,
        }),
        JSON.stringify({
          type: "message",
          id: "u1",
          parentId: null,
          timestamp: "2026-05-10T00:00:01.000Z",
          message: {
            role: "user",
            content: [{ type: "text", text: "imported hello" }],
            timestamp: 0,
          },
        }),
        "",
      ].join("\n"),
      "utf8",
    );

    const result = await runtime.importFromJsonl("s1", importPath);

    assert.deepEqual(result, { cancelled: false });
    assert.equal(tab.sessionId, "imported-session");
    assert.equal(tab.workdir, importedCwd);
    assert.equal(runtime.getTab("s1"), undefined);
    const importedTab = runtime.getTab("imported-session");
    assert.equal(importedTab, runtimeTab);
    assert.match(importedTab?.chat.map((line) => line.text).join("\n") ?? "", /imported hello/);
    await assert.rejects(
      () => runtime.importFromJsonl("imported-session", join(dir, "missing.jsonl")),
      /Session import file not found/,
    );

    const noCwdPath = join(dir, "no-cwd.jsonl");
    await writeFile(
      noCwdPath,
      `${JSON.stringify({ type: "session", version: 3, id: "no-cwd", timestamp: "2026-05-10T00:00:00.000Z" })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => runtime.importFromJsonl("imported-session", noCwdPath),
      /requires a cwd override/,
    );
    await runtime.importFromJsonl("imported-session", noCwdPath, process.cwd());
    assert.equal(tab.sessionId, "no-cwd");
    assert.equal(tab.workdir, process.cwd());

    const missingCwdPath = join(dir, "missing-cwd.jsonl");
    await writeFile(
      missingCwdPath,
      `${JSON.stringify({ type: "session", version: 3, id: "missing-cwd", timestamp: "2026-05-10T00:00:00.000Z", cwd: join(dir, "does-not-exist") })}\n`,
      "utf8",
    );
    await assert.rejects(
      () => runtime.importFromJsonl("no-cwd", missingCwdPath),
      /Stored session working directory does not exist/,
    );

    const emptyPath = join(dir, "empty.jsonl");
    await writeFile(emptyPath, "\n", "utf8");
    await assert.rejects(
      () => runtime.importFromJsonl("no-cwd", emptyPath),
      /Session import file is empty/,
    );
    const invalidJsonPath = join(dir, "invalid-json.jsonl");
    await writeFile(invalidJsonPath, "{not-json}\n", "utf8");
    await assert.rejects(
      () => runtime.importFromJsonl("no-cwd", invalidJsonPath),
      /Session import header is not valid JSON/,
    );
    const noHeaderPath = join(dir, "no-header.jsonl");
    await writeFile(noHeaderPath, `${JSON.stringify({ type: "message", id: "m1" })}\n`, "utf8");
    await assert.rejects(
      () => runtime.importFromJsonl("no-cwd", noHeaderPath),
      /must start with a session header/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
