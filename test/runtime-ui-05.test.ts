import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
  type Model,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  createTab,
  renderChat,
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

test("runtime restores prompt history from the active SDK branch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-branch-"));
  const sessionId = "branch-history";
  const file = join(dir, `2026-06-27T00-00-00-000Z_${sessionId}.jsonl`);
  try {
    const lines = [
      {
        type: "session",
        version: 3,
        id: sessionId,
        timestamp: "2026-06-27T00:00:00.000Z",
        cwd: process.cwd(),
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-06-27T00:00:01.000Z",
        message: { role: "user", content: "root prompt", timestamp: 0 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-06-27T00:00:02.000Z",
        message: runtimeAssistantMessage("answer"),
      },
      {
        type: "message",
        id: "u2",
        parentId: "a1",
        timestamp: "2026-06-27T00:00:03.000Z",
        message: { role: "user", content: "abandoned prompt", timestamp: 0 },
      },
      "{bad json",
      {
        type: "message",
        id: "u3",
        parentId: "a1",
        timestamp: "2026-06-27T00:00:04.000Z",
        message: { role: "user", content: "active prompt", timestamp: 0 },
      },
    ];
    await writeFile(
      file,
      `${lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n")}\n`,
      "utf8",
    );

    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    assert.deepEqual(runtime.getPromptHistory(sessionId), ["root prompt", "active prompt"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime restores prompt history from legacy linear session files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-legacy-history-"));
  const sessionId = "legacy-history";
  const file = join(dir, `2026-06-27T00-00-00-000Z_${sessionId}.jsonl`);
  try {
    const lines = [
      {
        type: "session",
        version: 1,
        id: sessionId,
        timestamp: "2026-06-27T00:00:00.000Z",
        cwd: process.cwd(),
      },
      {
        type: "message",
        timestamp: "2026-06-27T00:00:01.000Z",
        message: { role: "user", content: "first legacy", timestamp: 0 },
      },
      {
        type: "message",
        timestamp: "2026-06-27T00:00:02.000Z",
        message: runtimeAssistantMessage("answer"),
      },
      {
        type: "message",
        timestamp: "2026-06-27T00:00:03.000Z",
        message: { role: "user", content: "second legacy", timestamp: 0 },
      },
      {
        type: "message",
        timestamp: "2026-06-27T00:00:04.000Z",
        message: runtimeAssistantMessage("answer"),
      },
    ];
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");

    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    assert.deepEqual(runtime.getPromptHistory(sessionId), ["first legacy", "second legacy"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime creates sessions, streams responses, restores chat, and supports compact/fork/delete", async () => {
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
    assert.ok(tab.previewMessages.some((message) => message.text.includes("hello")));
    assert.match(runtimeTab.chat.map((line) => line.text).join("\n"), /hello/);

    const reopened = new MixCodeRuntime({ sessionsRoot: dir });
    assert.deepEqual(reopened.getPromptHistory("s1"), ["hello"]);
    const reopenedTab = await reopened.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    assert.match(reopenedTab.chat.map((line) => line.text).join("\n"), /hello/);
    assert.equal(reopenedTab.tab.contextLimit, MIXCODE_FAUX_MODEL.contextWindow);

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
    const rendered = renderChat(reopenedBashTab.chat, 80).join("\n");
    assert.match(rendered, /\$ pwd/);
    assert.match(rendered, /bash output/);

    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    await runtime.compactSession("s1", "preserve user intent");
    assert.equal(runtimeTab.session.getBranch().at(-1)?.type, "compaction");
    assert.ok(runtimeTab.chat.some((line) => line.compactionSummary === true));

    const forked = await runtime.forkSession("s1", "s2");
    assert.equal(forked.getSessionId(), "s2");
    await runtime.deleteTab("s1");
    assert.equal(runtime.getTab("s1"), undefined);
    await assert.rejects(runtime.deleteTab("s1"), /Unknown tab session/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("runtime compacts imported replay session with stream signal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-runtime-compact-replay-"));
  try {
    let compactSignal: AbortSignal | undefined;
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model: Model<any>, _context: Context, options?: SimpleStreamOptions) => {
        compactSignal = options?.signal;
        return delayedAssistantStream("replay summary", Promise.resolve(), options);
      },
    });
    const importPath = join(dir, "2026-06-07T00-00-00-000Z_replay-session.jsonl");
    const replayAssistantMessage = (text: string): AssistantMessage => ({
      ...runtimeAssistantMessage(text),
      api: "replay",
      provider: "replay",
      model: "replay-model",
    });
    const replayEntries = [
      {
        type: "session",
        version: 3,
        id: "replay-session",
        timestamp: "2026-06-07T00:00:00.000Z",
        cwd: process.cwd(),
      },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-06-07T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "original task" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: "2026-06-07T00:00:02.000Z",
        message: replayAssistantMessage("old answer"),
      },
      {
        type: "compaction",
        id: "c1",
        parentId: "a1",
        timestamp: "2026-06-07T00:00:03.000Z",
        summary: "previous summary",
        firstKeptEntryId: "u2",
        tokensBefore: 50000,
      },
      {
        type: "message",
        id: "u2",
        parentId: "c1",
        timestamp: "2026-06-07T00:00:04.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "continue" }],
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "a2",
        parentId: "u2",
        timestamp: "2026-06-07T00:00:05.000Z",
        message: {
          ...replayAssistantMessage("tool call"),
          content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "file.ts" } }],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        id: "t1",
        parentId: "a2",
        timestamp: "2026-06-07T00:00:06.000Z",
        message: {
          role: "toolResult",
          toolCallId: "tc1",
          toolName: "read",
          content: [{ type: "text", text: "file content" }],
          details: {},
          isError: false,
          timestamp: 0,
        },
      },
      {
        type: "message",
        id: "a3",
        parentId: "t1",
        timestamp: "2026-06-07T00:00:07.000Z",
        message: replayAssistantMessage("latest answer"),
      },
    ];
    await writeFile(
      importPath,
      `${replayEntries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
      "utf8",
    );
    const tab = createTab(1, "replay-session", process.cwd(), {
      model: {
        provider: "replay",
        modelId: "replay-model",
        displayName: "replay/replay-model",
        contextWindow: MIXCODE_FAUX_MODEL.contextWindow,
      },
    });
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
      model: { ...MIXCODE_FAUX_MODEL, provider: "replay", api: "replay", id: "replay-model" },
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });

    await runtime.compactSession("replay-session");

    assert.ok(compactSignal instanceof AbortSignal);
    assert.equal(tab.status, "idle");
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

    const emptyPath = join(dir, "empty.jsonl");
    await writeFile(emptyPath, "\n", "utf8");
    await assert.rejects(
      () => runtime.importFromJsonl("no-cwd", emptyPath),
      /Session import file is empty/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
