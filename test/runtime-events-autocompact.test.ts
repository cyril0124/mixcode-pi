// Tests for the auto-compaction cycle transitions (src/agent/runtime-events.ts).
//
// The context-limit auto-compaction cycle is driven by four RuntimeTab flags.
// They were previously set inline across the agent_end handler and the
// autoCompactAndContinue finally block. enterAutoCompactCycle makes the entry
// atomic; its most load-bearing job is resetting autoCompactCycleFailed, since
// a stale failure flag would make the next cycle skip its compaction attempt.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endAutoCompactCycle,
  enterAutoCompactCycle,
} from "../src/agent/runtime-events.js";

// Minimal stand-in carrying just the cycle flags the helpers touch.
function cycleTab() {
  return {
    pendingContextLimitCompaction: true,
    deferPendingMessageFlush: false,
    autoCompactCycleActive: false,
    autoCompactCycleFailed: true, // stale failure from a previous cycle
    isAutoCompacting: false,
  } as unknown as Parameters<typeof enterAutoCompactCycle>[0];
}

test("enterAutoCompactCycle clears the stale failure flag and arms the cycle", () => {
  const t = cycleTab();
  enterAutoCompactCycle(t);
  assert.equal(t.pendingContextLimitCompaction, false);
  assert.equal(t.deferPendingMessageFlush, true);
  assert.equal(t.autoCompactCycleActive, true);
  // The footgun guard: a previous cycle's failure must not leak into this one.
  assert.equal(t.autoCompactCycleFailed, false);
});

test("endAutoCompactCycle clears the in-flight markers", () => {
  const t = cycleTab();
  enterAutoCompactCycle(t);
  t.isAutoCompacting = true;
  endAutoCompactCycle(t);
  assert.equal(t.isAutoCompacting, false);
  assert.equal(t.autoCompactCycleActive, false);
});
