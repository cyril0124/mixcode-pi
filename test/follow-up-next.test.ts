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
} from "@earendil-works/pi-ai";
import type { RuntimeTab } from "../src/agent/runtime-types.js";
import { FollowUpCleanup } from "./helpers/follow-up-cleanup.js";
import { createTab, MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";

function userText(context: Context): string {
  const message = context.messages.filter((entry) => entry.role === "user").at(-1);
  if (!message) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n");
}

async function fixture(options: { failInitial?: boolean } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-follow-next-"));
  const calls: string[] = [];
  const blocked = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const finished = Promise.withResolvers<void>();
  const model = { ...MIXCODE_FAUX_MODEL, provider: "follow-next", api: "follow-next", id: "test" };
  const runtime = new MixCodeRuntime({
    sessionsRoot: dir,
    streamFn: (_model, context, streamOptions) => {
      const text = userText(context);
      calls.push(text);
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (text === "hold") {
          started.resolve();
          await blocked.promise;
        }
        const failed = text === "fail" || (text === "hold" && options.failInitial);
        const stopReason = streamOptions?.signal?.aborted ? "aborted" : failed ? "error" : "stop";
        const message: AssistantMessage = {
          role: "assistant",
          content: [{ type: "text", text: `done ${text}` }],
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
          ...(stopReason === "error" ? { errorMessage: "invalid request" } : {}),
        };
        if (stopReason === "error" || stopReason === "aborted") {
          stream.push({ type: "error", reason: stopReason, error: message });
        } else {
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end(message);
      })();
      return stream;
    },
  });
  const tab = createTab(1, "s1", dir, {
    model: {
      provider: model.provider,
      modelId: model.id,
      displayName: "test",
      contextWindow: model.contextWindow,
    },
  });
  const cleanup = new FollowUpCleanup(runtime, dir, [blocked.resolve]);
  let runtimeTab: RuntimeTab;
  try {
    runtimeTab = await runtime.createTab(tab, {
      systemPrompt: "system",
      workdir: dir,
      model,
      thinkingLevel: "off",
    });
  } catch (error) {
    await cleanup.cleanup();
    throw error;
  }
  const unsubscribe = runtime.onChange((event) => {
    if (event.type === "agent_settled" && calls.at(-1) === "last") finished.resolve();
  });
  return {
    runtime,
    tab,
    runtimeTab,
    calls,
    blocked,
    started,
    finished,
    track: <T>(promise: Promise<T>) => cleanup.track(promise),
    async cleanup() {
      unsubscribe();
      await cleanup.cleanup();
    },
  };
}

test("a prompt sequence is fully queued before an idle first round finishes", async () => {
  const f = await fixture();
  try {
    const snapshots: string[][] = [];
    const off = f.runtime.onChange(() => snapshots.push([...f.tab.pendingFollowUps]));
    try {
      f.runtime.queueFollowUpNextPrompts("s1", ["hold", "second", "last"]);
      assert.ok(snapshots.some((texts) => texts.join("|") === "hold|second|last"));
      await f.started.promise;
      assert.deepEqual(f.tab.pendingFollowUps, ["second", "last"]);
      assert.deepEqual(f.calls, ["hold"]);
      f.blocked.resolve();
      await f.finished.promise;
      assert.deepEqual(f.calls, ["hold", "second", "last"]);
    } finally {
      off();
    }
  } finally {
    await f.cleanup();
  }
});

test("a prompt sequence appends behind existing work and retains pause and edit semantics", async () => {
  const f = await fixture();
  try {
    f.tab.followUpsPaused = true;
    await f.runtime.prompt("s1", "earlier", { streamingBehavior: "followUp" });
    f.runtime.queueFollowUpNextPrompts("s1", ["second", "editable", "last"]);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.tab.pendingFollowUps, ["earlier", "second", "editable", "last"]);
    assert.equal(f.runtime.popPendingMessage("s1", "followUp"), "/follow-up last");
    assert.equal(f.tab.followUpsPaused, true);
    f.runtime.queueFollowUpNextPrompts("s1", ["last"]);
    await f.runtime.resumeFollowUps("s1");
    await f.finished.promise;
    assert.deepEqual(f.calls, ["earlier", "second", "editable", "last"]);
  } finally {
    await f.cleanup();
  }
});

test("sequence errors pause remaining rounds without replaying the failed round", async () => {
  const f = await fixture();
  const paused = Promise.withResolvers<void>();
  const off = f.runtime.onChange(() => {
    if (f.tab.followUpsPaused) paused.resolve();
  });
  try {
    f.runtime.queueFollowUpNextPrompts("s1", ["fail", "last"]);
    await paused.promise;
    assert.deepEqual(f.calls, ["fail"]);
    assert.deepEqual(f.tab.pendingFollowUps, ["last"]);
    await f.runtime.resumeFollowUps("s1");
    await f.finished.promise;
    assert.deepEqual(f.calls, ["fail", "last"]);
  } finally {
    off();
    await f.cleanup();
  }
});

test("aborting a busy run pauses an appended sequence until explicit resume", async () => {
  const f = await fixture();
  try {
    const running = f.track(f.runtime.prompt("s1", "hold"));
    await f.started.promise;
    f.runtime.queueFollowUpNextPrompts("s1", ["second", "last"]);
    assert.deepEqual(f.tab.pendingMessages, []);
    f.runtime.abortTab("s1");
    f.blocked.resolve();
    await running;
    assert.equal(f.tab.followUpsPaused, true);
    assert.deepEqual(f.calls, ["hold"]);
    assert.deepEqual(f.tab.pendingFollowUps, ["second", "last"]);
    await f.runtime.resumeFollowUps("s1");
    await f.finished.promise;
    assert.deepEqual(f.calls, ["hold", "second", "last"]);
  } finally {
    await f.cleanup();
  }
});

test("next boundaries preserve FIFO and batch only adjacent ordinary follow-ups", async () => {
  const f = await fixture();
  try {
    const running = f.track(f.runtime.prompt("s1", "hold"));
    await f.started.promise;
    await f.runtime.prompt("s1", "A", { streamingBehavior: "followUp" });
    await f.runtime.prompt("s1", "B", { streamingBehavior: "followUp" });
    await f.runtime.prompt("s1", "C", { streamingBehavior: "followUp", followUpNext: true });
    await f.runtime.prompt("s1", "D", { streamingBehavior: "followUp" });
    await f.runtime.prompt("s1", "last", { streamingBehavior: "followUp", followUpNext: true });
    assert.deepEqual(f.calls, ["hold"]);
    f.blocked.resolve();
    await running;
    await f.finished.promise;
    assert.deepEqual(f.calls, ["hold", "A\n\nB", "C", "D", "last"]);
    assert.deepEqual(f.tab.pendingFollowUps, []);
  } finally {
    await f.cleanup();
  }
});

test("abort pauses FIFO until explicit resume; new prompts and enqueues do not resume", async () => {
  const f = await fixture();
  try {
    const running = f.track(f.runtime.prompt("s1", "hold"));
    await f.started.promise;
    await f.runtime.prompt("s1", "next", { streamingBehavior: "followUp", followUpNext: true });
    await f.runtime.prompt("s1", "ordinary", { streamingBehavior: "followUp" });
    f.runtime.abortTab("s1");
    f.blocked.resolve();
    await running;
    await f.runtimeTab.agentSession.waitForIdle();
    assert.equal(f.tab.followUpsPaused, true);
    await f.runtime.prompt("s1", "manual");
    await f.runtime.prompt("s1", "last", { streamingBehavior: "followUp", followUpNext: true });
    assert.deepEqual(f.calls, ["hold", "manual"]);
    assert.deepEqual(f.tab.pendingFollowUps, ["next", "ordinary", "last"]);
    await f.runtime.resumeFollowUps("s1");
    await f.finished.promise;
    assert.deepEqual(f.calls, ["hold", "manual", "next", "ordinary", "last"]);
    assert.equal(f.tab.followUpsPaused, false);
  } finally {
    await f.cleanup();
  }
});

test("final model error pauses unsent follow-ups and resume does not repeat failed task", async () => {
  const f = await fixture();
  try {
    const running = f.track(f.runtime.prompt("s1", "hold"));
    await f.started.promise;
    await f.runtime.prompt("s1", "fail", { streamingBehavior: "followUp", followUpNext: true });
    await f.runtime.prompt("s1", "last", { streamingBehavior: "followUp", followUpNext: true });
    const paused = Promise.withResolvers<void>();
    const off = f.runtime.onChange(() => {
      if (f.tab.followUpsPaused) paused.resolve();
    });
    f.blocked.resolve();
    await running;
    await paused.promise;
    off();
    assert.deepEqual(f.calls, ["hold", "fail"]);
    assert.deepEqual(f.tab.pendingFollowUps, ["last"]);
    await f.runtime.resumeFollowUps("s1");
    await f.finished.promise;
    assert.deepEqual(f.calls, ["hold", "fail", "last"]);
  } finally {
    await f.cleanup();
  }
});

test("failure of the initial ordinary run pauses queued next work before dispatch", async () => {
  const f = await fixture({ failInitial: true });
  try {
    const running = f.track(f.runtime.prompt("s1", "hold"));
    await f.started.promise;
    await f.runtime.prompt("s1", "last", { streamingBehavior: "followUp", followUpNext: true });
    f.blocked.resolve();
    await running;
    await f.runtimeTab.agentSession.waitForIdle();
    assert.equal(f.tab.followUpsPaused, true);
    assert.deepEqual(f.calls, ["hold"]);
    assert.deepEqual(f.tab.pendingFollowUps, ["last"]);
    await f.runtime.resumeFollowUps("s1");
    await f.finished.promise;
    assert.deepEqual(f.calls, ["hold", "last"]);
  } finally {
    await f.cleanup();
  }
});

test("idle next starts immediately and empty resume surfaces an error", async () => {
  const f = await fixture();
  try {
    await f.runtime.prompt("s1", "first", { streamingBehavior: "followUp", followUpNext: true });
    assert.deepEqual(f.calls, ["first"]);
    await assert.rejects(f.runtime.resumeFollowUps("s1"), /Error:.*[Nn]o follow-up/);
  } finally {
    await f.cleanup();
  }
});

test("taking next back for editing retains its command and does not disturb steer", async () => {
  const f = await fixture();
  try {
    const running = f.track(f.runtime.prompt("s1", "hold"));
    await f.started.promise;
    await f.runtime.prompt("s1", "steer");
    await f.runtime.prompt("s1", "later", { streamingBehavior: "followUp", followUpNext: true });
    assert.equal(f.runtime.popPendingMessage("s1", "followUp"), "/follow-up later");
    assert.deepEqual(f.tab.pendingFollowUps, []);
    assert.deepEqual(f.tab.pendingMessages, ["steer"]);
    f.blocked.resolve();
    await running;
  } finally {
    await f.cleanup();
  }
});
