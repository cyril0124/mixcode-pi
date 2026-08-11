// After agent_end, pending-steer flush must not race a post-abort compact+resume.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { scheduleRuntimePendingMessageFlush } from "../src/agent/runtime-follow-up.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";

type Listener = (event: { type: string }) => void;

function fakeSession(state: {
  isCompacting: boolean;
  isStreaming: boolean;
}): AgentSession & { endCompact: () => void } {
  const listeners = new Set<Listener>();
  return {
    get isCompacting() {
      return state.isCompacting;
    },
    get isStreaming() {
      return state.isStreaming;
    },
    waitForIdle: () => Promise.resolve(),
    subscribe(listener: Listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    endCompact() {
      state.isCompacting = false;
      for (const listener of listeners) listener({ type: "compaction_end" });
    },
  } as unknown as AgentSession & { endCompact: () => void };
}

test("pending flush waits for compact and skips when a resume run is active", async () => {
  const state = { isCompacting: false, isStreaming: false };
  const session = fakeSession(state);
  const flushes: number[] = [];

  // Mid-turn path: agent_end first, then setImmediate starts compact, then resume streams.
  setImmediate(() => {
    state.isCompacting = true;
    setImmediate(() => {
      session.endCompact();
      state.isStreaming = true;
    });
  });

  scheduleRuntimePendingMessageFlush(
    "s1",
    session,
    () =>
      ({
        queuedPromptCount: 1,
        agentSession: session,
      }) as unknown as RuntimeTab,
    async (_sessionId, count) => {
      flushes.push(count ?? 0);
    },
    () => {
      throw new Error("onError should not run");
    },
  );

  await Bun.sleep(50);
  assert.deepEqual(flushes, []);
});

test("pending flush waits when compact flips isCompacting only after await abort", async () => {
  // Pi AgentSession.compact(): await abort() first, then set isCompacting.
  // A 1–2 macrotask claim window loses this race and flushes into the compact/resume.
  const state = { isCompacting: false, isStreaming: false };
  const session = fakeSession(state);
  const flushes: number[] = [];

  setImmediate(() => {
    void Promise.resolve().then(async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      await new Promise<void>((resolve) => setImmediate(resolve));
      state.isCompacting = true;
      setImmediate(() => {
        session.endCompact();
        state.isStreaming = true;
      });
    });
  });

  scheduleRuntimePendingMessageFlush(
    "s1",
    session,
    () =>
      ({
        queuedPromptCount: 1,
        agentSession: session,
      }) as unknown as RuntimeTab,
    async (_sessionId, count) => {
      flushes.push(count ?? 0);
    },
    () => {
      throw new Error("onError should not run");
    },
  );

  await Bun.sleep(50);
  assert.deepEqual(flushes, []);
});

test("pending flush still runs when no compact or resume follows agent_end", async () => {
  const session = fakeSession({ isCompacting: false, isStreaming: false });
  const flushes: number[] = [];

  scheduleRuntimePendingMessageFlush(
    "s1",
    session,
    () =>
      ({
        queuedPromptCount: 2,
        agentSession: session,
      }) as unknown as RuntimeTab,
    async (_sessionId, count) => {
      flushes.push(count ?? 0);
    },
    () => {
      throw new Error("onError should not run");
    },
  );

  await Bun.sleep(50);
  assert.deepEqual(flushes, [2]);
});
