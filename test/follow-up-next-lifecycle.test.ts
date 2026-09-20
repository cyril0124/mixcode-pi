import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  InMemoryCredentialStore,
  type SimpleStreamOptions,
  Type,
} from "@earendil-works/pi-ai";
import { type ExtensionFactory, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { emitMarkDone, MARK_DONE_EVENT } from "../src/core/extension-event-bus.js";
import type { MixCodeModel } from "../src/core/types.js";
import { FollowUpCleanup } from "./helpers/follow-up-cleanup.js";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";

function assistantMessage(
  model: MixCodeModel,
  text: string,
  stopReason: "stop" | "toolUse" = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason,
    timestamp: Date.now(),
  };
}

function streamMessage(message: AssistantMessage, options?: SimpleStreamOptions, failed = false) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (options?.signal?.aborted) {
      stream.push({ type: "error", reason: "aborted", error: message });
      stream.end(message);
      return;
    }
    stream.push({ type: "start", partial: { ...message, content: [] } });
    if (failed) {
      stream.push({ type: "error", reason: "error", error: message });
      stream.end(message);
      return;
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

function userTexts(context: Context): string[] {
  return context.messages
    .filter((entry) => entry.role === "user")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
    );
}

function userText(context: Context): string {
  return userTexts(context).at(-1) ?? "";
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

test("fixture cleanup closes sessions and unregisters event buses after a test failure", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-cleanup-"));
  const model = testModel("follow-cleanup");
  let received = 0;
  let shutdowns = 0;
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const calls: string[] = [];
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    streamFn: (_model, context) => {
      calls.push(userText(context));
      const stream = createAssistantMessageEventStream();
      cleanup.track(
        (async () => {
          started.resolve();
          await release.promise;
          const message = assistantMessage(model, "finished");
          stream.push({ type: "done", reason: "stop", message });
          stream.end(message);
        })(),
      );
      return stream;
    },
    extensionFactories: [
      (pi) => {
        pi.events.on(MARK_DONE_EVENT, () => received++);
        pi.on("session_shutdown", () => {
          shutdowns++;
        });
      },
    ],
  });
  const cleanup = new FollowUpCleanup(runtime, dir, [release.resolve]);
  const failure = new Error("test assertion failed");
  await assert.rejects(
    async () => {
      try {
        await runtime.createTab(createTab(1, "s1", dir), {
          systemPrompt: "system",
          thinkingLevel: "off",
          workdir: dir,
          model,
        });
        emitMarkDone();
        assert.equal(received, 1);
        cleanup.track(runtime.prompt("s1", "held prompt"));
        await started.promise;
        await runtime.prompt("s1", "must not start", {
          streamingBehavior: "followUp",
          followUpNext: true,
        });
        throw failure;
      } finally {
        await cleanup.cleanup();
      }
    },
    (error) => error === failure,
  );
  assert.deepEqual(calls, ["held prompt"]);
  assert.deepEqual(runtime.listTabs(), []);
  assert.equal(shutdowns, 1);
  emitMarkDone();
  assert.equal(received, 1);
  await assert.rejects(fs.stat(dir), { code: "ENOENT" });
});

function testModel(provider: string): MixCodeModel {
  return { ...MIXCODE_FAUX_MODEL, provider, api: `${provider}-api`, id: `${provider}-model` };
}

for (const delivery of ["single", "sequence"] as const) {
  test(`follow-up ${delivery} waits for a failed tool turn to recover through multiple model steps`, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-tool-"));
    const model = testModel("follow-tool");
    const calls: string[] = [];
    const toolReleased = Promise.withResolvers<void>();
    const toolStarted = Promise.withResolvers<void>();
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      streamFn: (_model, context, options) => {
        calls.push(userText(context));
        const hasToolFailure = context.messages.some(
          (message) => message.role === "toolResult" && message.isError,
        );
        if (userText(context) === "tool failure" && !hasToolFailure) {
          toolStarted.resolve();
          const stream = createAssistantMessageEventStream();
          void (async () => {
            const toolCall: AssistantMessage = {
              ...assistantMessage(model, "", "toolUse"),
              content: [
                { type: "toolCall", id: "broken-call", name: "broken_tool", arguments: {} },
              ],
            };
            stream.push({ type: "start", partial: { ...toolCall, content: [] } });
            await toolReleased.promise;
            stream.push({ type: "done", reason: "toolUse", message: toolCall });
            stream.end(toolCall);
          })();
          return stream;
        }
        return streamMessage(
          assistantMessage(
            model,
            hasToolFailure ? "model recovered after tool failure" : "next finished",
          ),
          options,
        );
      },
      extensionFactories: [
        (pi) => {
          pi.registerTool({
            name: "broken_tool",
            label: "Broken tool",
            description: "Fails once so the model must recover.",
            parameters: Type.Object({}),
            execute: async () => {
              throw new Error("tool failed");
            },
          });
        },
      ],
    });
    const cleanup = new FollowUpCleanup(runtime, dir, [toolReleased.resolve]);
    try {
      const tab = createTab(1, "s1", dir);
      await runtime.createTab(tab, {
        systemPrompt: "system",
        thinkingLevel: "off",
        workdir: dir,
        model,
      });
      if (delivery === "sequence") {
        runtime.queueFollowUpNextPrompts("s1", ["tool failure", "after tool"]);
      } else {
        cleanup.track(runtime.prompt("s1", "tool failure"));
      }
      await toolStarted.promise;
      if (delivery === "single") {
        await runtime.prompt("s1", "after tool", {
          streamingBehavior: "followUp",
          followUpNext: true,
        });
      }
      assert.deepEqual(tab.pendingFollowUps, ["after tool"]);
      assert.deepEqual(calls, ["tool failure"]);
      toolReleased.resolve();
      await waitUntil(
        () => calls.length === 3 && tab.pendingFollowUps.length === 0 && tab.status === "idle",
      );
      assert.deepEqual(calls, ["tool failure", "tool failure", "after tool"]);
      assert.ok(
        runtime
          .getTab("s1")!
          .chat.some((line) => line.role === "assistant" && /recovered/.test(line.text)),
      );
    } finally {
      await cleanup.cleanup();
    }
  });
}

test("retryable API failure keeps follow-ups flowing until the retry succeeds", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-retry-"));
  const model = testModel("follow-retry");
  const calls: string[] = [];
  let attempts = 0;
  const firstAttempt = Promise.withResolvers<void>();
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    streamFn: (_model, context, options) => {
      const text = userText(context);
      calls.push(text);
      if (text === "retry me" && attempts++ === 0) {
        firstAttempt.resolve();
        throw new Error("500 server error");
      }
      return streamMessage(assistantMessage(model, `done ${text}`), options);
    },
  });
  const cleanup = new FollowUpCleanup(runtime, dir);
  try {
    const runtimeTab = await runtime.createTab(createTab(1, "s1", dir), {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: dir,
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
    });
    cleanup.track(runtime.prompt("s1", "retry me"));
    await firstAttempt.promise;
    await runtime.prompt("s1", "after retry", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    assert.deepEqual(runtimeTab.tab.pendingFollowUps, ["after retry"]);
    await waitUntil(
      () =>
        calls.length === 3 &&
        runtimeTab.tab.pendingFollowUps.length === 0 &&
        runtimeTab.tab.status === "idle",
    );
    assert.deepEqual(calls, ["retry me", "retry me", "after retry"]);
    assert.equal(runtimeTab.tab.followUpsPaused, false);
  } finally {
    await cleanup.cleanup();
  }
});

test("nextTurn extension messages stay with the queued user's model context", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-input-"));
  const model = testModel("follow-input");
  const contexts: Context[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.on("input", (event) => {
      if (event.text === "queued user") {
        pi.sendMessage(
          { customType: "hidden-next-turn", content: "extension context", display: false },
          { deliverAs: "nextTurn" },
        );
      }
    });
  };
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    streamFn: (_model, context, options) => {
      contexts.push(context);
      return streamMessage(assistantMessage(model, `done ${userText(context)}`), options);
    },
    extensionFactories: [extension],
  });
  const cleanup = new FollowUpCleanup(runtime, dir);
  try {
    const tab = createTab(1, "s1", dir);
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: dir,
      model,
    });
    tab.followUpsPaused = true;
    await runtime.prompt("s1", "first", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    await runtime.prompt("s1", "queued user", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    await runtime.prompt("s1", "next task", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    assert.deepEqual(contexts, []);
    await runtime.resumeFollowUps("s1");
    await waitUntil(
      () => contexts.length === 3 && tab.pendingFollowUps.length === 0 && tab.status === "idle",
    );
    assert.deepEqual(contexts.map(userTexts), [
      ["first"],
      ["first", "queued user", "extension context"],
      ["first", "queued user", "extension context", "next task"],
    ]);
    const queuedContext = contexts.find((context) => userTexts(context).includes("queued user"));
    const nextContext = contexts.find((context) => userText(context) === "next task");
    assert.ok(queuedContext);
    assert.ok(nextContext);
    const queuedTexts = userTexts(queuedContext!);
    const nextTexts = userTexts(nextContext!);
    assert.deepEqual(queuedTexts.slice(-2), ["queued user", "extension context"]);
    assert.equal(nextTexts.at(-1), "next task");
    assert.ok(nextTexts.indexOf("extension context") < nextTexts.indexOf("next task"));
  } finally {
    await cleanup.cleanup();
  }
});

test("manual compaction drains queued follow-ups only after the host finishes", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-compact-"));
  const model = testModel("follow-compact");
  const calls: string[] = [];
  const releaseCompact = Promise.withResolvers<void>();
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    streamFn: (_model, context, options) => {
      calls.push(userText(context));
      return streamMessage(assistantMessage(model, `done ${userText(context)}`), options);
    },
    extensionFactories: [
      (pi) => {
        pi.on("session_before_compact", async (event) => {
          await releaseCompact.promise;
          return {
            compaction: {
              summary: "manual summary",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: 20,
            },
          };
        });
      },
    ],
  });
  const cleanup = new FollowUpCleanup(runtime, dir, [releaseCompact.resolve]);
  try {
    const tab = createTab(1, "s1", dir);
    const runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: dir,
      model,
    });
    runtimeTab.agentSession.settingsManager.applyOverrides({
      compaction: { reserveTokens: 1, keepRecentTokens: 1 },
    });
    await runtime.prompt("s1", "compact anchor");
    const compact = cleanup.track(runtime.compactSession("s1"));
    await new Promise<void>((resolve) => {
      const off = runtime.onChange((event) => {
        if (event.type === "compaction_start") {
          off();
          resolve();
        }
      });
    });
    await runtime.prompt("s1", "after compact", {
      streamingBehavior: "followUp",
      followUpNext: true,
    });
    assert.deepEqual(tab.pendingFollowUps, ["after compact"]);
    await Bun.sleep(30);
    assert.deepEqual(calls, ["compact anchor"]);
    releaseCompact.resolve();
    await compact;
    await waitUntil(() => tab.pendingFollowUps.length === 0 && tab.status === "idle");
    assert.deepEqual(calls, ["compact anchor", "after compact"]);
  } finally {
    await cleanup.cleanup();
  }
});

test("auth preflight pauses an undelivered follow-up and explicit resume sends it once", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-auth-"));
  const model = { ...testModel("follow-auth"), api: "follow-auth-api" };
  const calls: string[] = [];
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider(model.provider, {
    name: model.provider,
    api: model.api,
    models: [model],
    streamSimple: (_requestModel, context, options) => {
      calls.push(userText(context));
      return streamMessage(assistantMessage(model, `done ${userText(context)}`), options);
    },
  });
  const runtime = new MixCodeRuntime({ sessionsRoot: dir, modelRuntime });
  const cleanup = new FollowUpCleanup(runtime, dir);
  try {
    const tab = createTab(1, "s1", dir);
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "off",
      workdir: dir,
      model,
    });
    await assert.rejects(
      () =>
        runtime.prompt("s1", "undelivered", { streamingBehavior: "followUp", followUpNext: true }),
      /No API key found/,
    );
    await waitUntil(() => tab.followUpsPaused);
    assert.deepEqual(tab.pendingFollowUps, ["undelivered"]);
    assert.deepEqual(calls, []);
    await modelRuntime.setRuntimeApiKey(model.provider, "test-key");
    await runtime.resumeFollowUps("s1");
    await waitUntil(
      () => calls.length === 1 && tab.pendingFollowUps.length === 0 && tab.status === "idle",
    );
    assert.deepEqual(calls, ["undelivered"]);
  } finally {
    await cleanup.cleanup();
  }
});
