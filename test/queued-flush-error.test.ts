import assert from "node:assert/strict";
import { test } from "node:test";
import { scheduleRuntimePendingMessageFlush } from "../src/agent/runtime-follow-up.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";

// A rejecting auto-resend used to become an unhandled Promise rejection and take
// the whole TUI process down (Node exits on unhandledRejection). The scheduler
// must catch the failure and surface it through onError instead of crashing.
test("scheduleRuntimePendingMessageFlush surfaces flush failure through onError instead of crashing", async () => {
  const errors: Array<{ sessionId: string; error: unknown }> = [];
  const fakeSession = { waitForIdle: () => Promise.resolve() };

  scheduleRuntimePendingMessageFlush(
    "s1",
    fakeSession as unknown as RuntimeTab["agentSession"],
    () => ({ queuedPromptCount: 1 }) as unknown as RuntimeTab,
    () => Promise.reject(new Error("queued resend failed")),
    (sessionId, error) => errors.push({ sessionId, error }),
  );

  // The chain settles through waitForIdle plus a setImmediate claim window
  // (waitOutPostAbortCompactAndResume); under CI CPU load those macrotasks can
  // outlast a fixed sleep, so poll for the surfaced error instead.
  for (let waited = 0; errors.length === 0 && waited < 2000; waited += 10) {
    await Bun.sleep(10);
  }

  assert.equal(errors.length, 1);
  assert.equal(errors[0]?.sessionId, "s1");
  assert.match((errors[0]?.error as Error).message, /queued resend failed/);
});
