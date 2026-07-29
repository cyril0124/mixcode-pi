// Core no longer owns a mid-turn auto-compact cycle. agent_end must not start
// private compact+continue work. This file guards the removed lifecycle flags.

import assert from "node:assert/strict";
import { test } from "node:test";
import { applyEvent } from "../src/agent/runtime-events.js";
import type { RuntimeTab } from "../src/agent/runtime-types.js";

function stubTab(): RuntimeTab {
  return {
    tab: {
      sessionId: "s1",
      status: "running",
      pendingMessages: [],
      pendingFollowUps: [],
      unreadDone: false,
    },
    chat: [],
    session: { getBranch: () => [] },
    agentSession: {
      isStreaming: false,
      isCompacting: false,
    },
    queuedPromptCount: 0,
    queuedFollowUpCount: 0,
  } as unknown as RuntimeTab;
}

test("agent_end does not arm a MixCode mid-turn auto-compact cycle", () => {
  const runtimeTab = stubTab();
  const events: string[] = [];
  applyEvent(runtimeTab, { type: "agent_end", messages: [] } as never, (event) => {
    events.push(event.type);
  });
  assert.equal(runtimeTab.tab.status, "idle");
  // Removed flags must not reappear on the tab.
  assert.equal(
    "pendingContextLimitCompaction" in runtimeTab &&
      (runtimeTab as { pendingContextLimitCompaction?: boolean }).pendingContextLimitCompaction,
    false,
  );
  assert.equal(
    "autoCompactCycleActive" in runtimeTab &&
      (runtimeTab as { autoCompactCycleActive?: boolean }).autoCompactCycleActive,
    false,
  );
  assert.deepEqual(events, ["agent_end"]);
});
