import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, type Terminal } from "@earendil-works/pi-tui";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab, type RuntimeTab } from "./helpers/mixcode.js";

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

async function waitFor(predicate: () => boolean, attempts = 80): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

test("runtime extension fork covers root and at-position branches", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-fork-branches-"));
  const events: string[] = [];
  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    await runtime.prompt("s1", "root prompt");
    const rootUserId = runtimeTab.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(rootUserId);
    runtime.setExtensionUiHost({
      tui: new TuiMainScreen(silentTerminal()),
      editor: {
        getText: () => "occupied",
        setText: (text) => events.push(`editor:${text}`),
        pasteToEditor: () => undefined,
      },
    });

    const beforeRootSessionFile = runtimeTab.session.getSessionFile();
    const forkRoot = await runtime.extensionFork("s1", rootUserId);
    const afterRootFork = runtime.listTabs()[0]!;
    assert.deepEqual(forkRoot, { cancelled: false });
    assert.notEqual(afterRootFork.tab.sessionId, "s1");
    assert.notEqual(afterRootFork.session.getSessionFile(), beforeRootSessionFile);
    assert.equal(afterRootFork.session.getHeader()?.parentSession, beforeRootSessionFile);
    assert.equal(afterRootFork.chat.length, 0);
    assert.ok(events.includes("editor:root prompt"));

    await runtime.prompt(afterRootFork.tab.sessionId, "at prompt");
    const atUserId = afterRootFork.session
      .getBranch()
      .find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
    assert.ok(atUserId);
    const beforeAtSession = afterRootFork.tab.sessionId;
    events.length = 0;
    const forkAt = await runtime.extensionFork(beforeAtSession, atUserId, { position: "at" });
    const afterAtFork = runtime.listTabs()[0]!;
    assert.deepEqual(forkAt, { cancelled: false });
    assert.notEqual(afterAtFork.tab.sessionId, beforeAtSession);
    assert.deepEqual(events, ["editor:"]);
    runtime.setExtensionUiHost(undefined);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("runtime extension fork treats visible non-user entries as prior conversation", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-fork-visible-prior-"));
  try {
    const cases: Array<{
      name: string;
      append: (runtimeTab: RuntimeTab) => void;
      expected: string;
    }> = [
      {
        name: "custom-message",
        append: (runtimeTab) =>
          runtimeTab.session.appendCustomMessageEntry("visible", "visible custom", true),
        expected: "visible custom",
      },
      {
        name: "assistant",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "assistant",
            content: [{ type: "text", text: "assistant prior" }],
            api: "x",
            provider: "x",
            model: "x",
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
          }),
        expected: "assistant prior",
      },
      {
        name: "tool-result",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "toolResult",
            toolCallId: "tc",
            toolName: "bash",
            content: [{ type: "text", text: "tool result" }],
            isError: false,
            timestamp: Date.now(),
          }),
        expected: "tool result",
      },
      {
        name: "bash-execution",
        append: (runtimeTab) =>
          runtimeTab.session.appendMessage({
            role: "bashExecution",
            command: "pwd",
            output: "bash output",
            exitCode: 0,
            cancelled: false,
            truncated: false,
            timestamp: Date.now(),
          }),
        expected: "bash output",
      },
    ];
    for (const item of cases) {
      const runtime = new MixCodeRuntime({ sessionsRoot: path.join(dir, item.name) });
      const runtimeTab = await runtime.createTab(createTab(1, `s-${item.name}`, process.cwd()), {
        systemPrompt: "system",
        thinkingLevel: "medium",
        workdir: process.cwd(),
      });
      item.append(runtimeTab);
      runtimeTab.session.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: item.expected }],
        api: "faux",
        provider: "faux",
        model: "faux-1",
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
      const userId = runtimeTab.session.appendMessage({
        role: "user",
        content: `after ${item.name}`,
        timestamp: Date.now(),
      });
      const beforeFile = runtimeTab.session.getSessionFile();

      const result = await runtime.extensionFork(runtimeTab.tab.sessionId, userId);
      const afterFork = runtime.listTabs()[0]!;
      assert.deepEqual(result, { cancelled: false });
      assert.notEqual(afterFork.session.getSessionFile(), beforeFile);
      assert.equal(
        afterFork.chat.some((line) => line.text.includes(item.expected)),
        true,
      );
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ctx.shutdown() closes the current tab when idle", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-shutdown-idle-"));
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("shutdown-smoke", {
      description: "Request session shutdown",
      handler: async (_args, ctx) => {
        ctx.shutdown();
      },
    });
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
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

    await runtime.prompt("s1", "/shutdown-smoke");

    assert.equal(runtime.getTab("s1"), undefined);
    assert.ok(runtime.getTab("s2"));
    assert.equal(
      runtime
        .listTabs()
        .map((t) => t.tab.sessionId)
        .join(","),
      "s2",
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("ctx.shutdown() defers close until the tab is no longer streaming", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-runtime-extension-shutdown-defer-"));
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });

  function pendingStream(options?: SimpleStreamOptions) {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(async () => {
      const message: AssistantMessage = {
        role: "assistant",
        content: [],
        api: "shutdown-defer",
        provider: "shutdown-defer",
        model: "shutdown-defer",
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
      await Promise.race([
        released,
        new Promise<void>((resolve) => {
          if (options?.signal?.aborted) return resolve();
          options?.signal?.addEventListener("abort", () => resolve(), { once: true });
        }),
      ]);
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    });
    return stream;
  }

  try {
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model, _context, options) => pendingStream(options),
    });
    const model = {
      ...MIXCODE_FAUX_MODEL,
      provider: "shutdown-defer",
      api: "shutdown-defer",
      id: "shutdown-defer",
    };
    const runtimeTab = await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
      model,
    });
    await runtime.createTab(createTab(2, "s2", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: process.cwd(),
      model,
    });

    const pending = runtime.prompt("s1", "hang please");
    await waitFor(
      () =>
        runtimeTab.agentSession.isStreaming === true ||
        runtimeTab.agentSession.agent.state.isStreaming === true,
    );

    runtime.requestExtensionShutdown("s1");
    assert.ok(runtime.getTab("s1"), "must not close while streaming");

    release();
    await pending.catch(() => undefined);
    await waitFor(() => runtime.getTab("s1") === undefined);

    assert.equal(runtime.getTab("s1"), undefined);
    assert.ok(runtime.getTab("s2"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
