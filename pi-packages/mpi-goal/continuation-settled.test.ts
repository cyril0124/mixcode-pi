/**
 * Contract: after an assistant stop, mpi-goal must auto-continue once the
 * session is truly idle. Real Pi keeps isIdle=false through agent_end and only
 * becomes idle on agent_settled — continuation must not depend on a 25ms race.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE } from "./src/domain/constants.js";
import { createTelemetry } from "./src/domain/telemetry.js";
import {
  createGoalState,
  persistClearGoal,
  persistSetGoal,
  replayGoalState,
} from "./src/persistence/goal-store.js";
import { registerGoalLifecycle } from "./src/runtime/lifecycle.js";
import { resetContinuationRuntime } from "./src/runtime/continuation.js";

type Handler = (event: unknown, ctx?: ExtensionContext) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler[]>();
const entries: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
const messages: Array<{ customType?: string; content?: string; options?: unknown }> = [];
let registered = false;
let idle = false;
let pendingMessages = false;

const pi = {
  on(name: string, handler: Handler) {
    const list = handlers.get(name) ?? [];
    list.push(handler);
    handlers.set(name, list);
  },
  appendEntry(customType: string, data: unknown) {
    const id = `entry-${entries.length + 1}`;
    entries.push({ type: "custom", customType, data, id });
  },
  sendMessage(msg: { customType?: string; content?: string }, options?: unknown) {
    messages.push({ ...msg, options });
  },
  registerTool() {},
  registerCommand() {},
  getActiveTools() {
    return [];
  },
  setActiveTools() {},
  getAllTools() {
    return [];
  },
  events: { on() {}, emit() {} },
} as unknown as ExtensionAPI;

const ctx = {
  hasUI: false,
  ui: {
    setStatus() {},
    setWidget() {},
    notify() {},
    select: async () => undefined,
  },
  abort() {},
  isIdle() {
    return idle;
  },
  hasPendingMessages() {
    return pendingMessages;
  },
  sessionManager: {
    getBranch() {
      return entries.map((e) => ({ ...e }));
    },
    getLeafId() {
      return entries.at(-1)?.id ?? "leaf-0";
    },
  },
} as unknown as ExtensionContext;

function ensureLifecycle(): void {
  if (registered) return;
  registerGoalLifecycle(pi);
  registered = true;
}

async function emit(name: string, event: unknown = {}): Promise<unknown> {
  let result: unknown;
  for (const handler of handlers.get(name) ?? []) {
    result = await handler(event, ctx);
  }
  return result;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function continuationMessages(): typeof messages {
  return messages.filter((m) => m.customType === CONTINUATION_MESSAGE_TYPE);
}

function seedActiveGoal(): void {
  ensureLifecycle();
  resetContinuationRuntime();
  entries.length = 0;
  messages.length = 0;
  idle = false;
  pendingMessages = false;
  const goal = createGoalState({ objective: "keep working until done" });
  const telemetry = createTelemetry(goal.goalId);
  persistSetGoal(pi, goal, telemetry, "command");
}

/** Drop in-memory goal while keeping branch entries (mid-session memory loss). */
function clearGoalMemoryKeepBranch(): void {
  const saved = entries.splice(0, entries.length);
  replayGoalState(ctx);
  entries.push(...saved);
}

test("agent_end while not idle still continues after agent_settled", async () => {
  seedActiveGoal();

  // Real Pi: agent_end fires with isIdle still false.
  idle = false;
  await emit("agent_end", { type: "agent_end", messages: [] });
  await sleep(40);
  assert.equal(continuationMessages().length, 0, "must not send continuation while not idle");

  // Only after settle is the session idle.
  idle = true;
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);

  const cont = continuationMessages();
  assert.equal(cont.length, 1, "must send exactly one continuation after settle");
  assert.equal((cont[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn, true);
  assert.equal((cont[0]?.options as { deliverAs?: string } | undefined)?.deliverAs, "followUp");
});

test("agent_settled does not continue when goal is not active", async () => {
  seedActiveGoal();
  persistClearGoal(pi, "command");

  idle = true;
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);
  assert.equal(continuationMessages().length, 0);
});

test("agent_settled while busy queues followUp instead of dropping", async () => {
  seedActiveGoal();
  // Race: process/subagent wake starts a run before settle-time continue runs.
  idle = false;
  await emit("agent_end", { type: "agent_end", messages: [] });
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);

  const cont = continuationMessages();
  assert.equal(cont.length, 1, "must queue continuation even when not idle");
  assert.equal((cont[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn, false);
  assert.equal((cont[0]?.options as { deliverAs?: string } | undefined)?.deliverAs, "followUp");
});

test("agent_settled rehydrates active goal from branch when memory is empty", async () => {
  seedActiveGoal();
  idle = true;
  await emit("agent_end", { type: "agent_end", messages: [] });
  // Mid-session memory loss after end: branch still has goal events, RAM does not.
  clearGoalMemoryKeepBranch();

  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);

  assert.equal(continuationMessages().length, 1, "must continue after rehydrate from branch");
});

test("no continuation without agent_settled: settle is the single dispatch point", async () => {
  seedActiveGoal();
  idle = true;
  // Only agent_end, no settled (host bug or early exit). Pi 0.87 emits
  // settled from the run's finally block, so settle alone dispatches.
  await emit("agent_end", { type: "agent_end", messages: [] });
  await sleep(600);
  assert.equal(continuationMessages().length, 0, "no fallback: settle is required");

  idle = true;
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);
  assert.equal(continuationMessages().length, 1, "settle dispatches the continuation");
});

type BoundaryEvent = {
  type: "agent_before_settle";
  outcome: "completed" | "aborted" | "error";
  entries: unknown[];
};

function boundaryEvent(outcome: BoundaryEvent["outcome"]): BoundaryEvent {
  return { type: "agent_before_settle", outcome, entries: [] };
}

/** Arm the boundary path: idle compact start, wake run, compact finishes mid-run. */
async function armBoundaryCompaction(): Promise<void> {
  seedActiveGoal();
  idle = true;
  await emit("session_before_compact", { type: "session_before_compact" });
  assert.equal(continuationMessages().length, 0, "idle compact start must not prequeue");
  // A wake run starts (subagent/process), and the compact finishes while it runs.
  idle = false;
  await emit("agent_end", { type: "agent_end", messages: [] });
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(20);
  assert.equal(continuationMessages().length, 0, "compacting: settle continue defers");
  await emit("session_compact", { type: "session_compact" });
}

test("compaction boundary returns one continuation draft and continue flag", async () => {
  await armBoundaryCompaction();

  const result = (await emit("agent_before_settle", boundaryEvent("completed"))) as
    | {
        entries?: Array<{ type: string; customType?: string }>;
        continue?: boolean;
      }
    | undefined;
  assert.ok(result, "boundary must return a result when compaction work is armed");
  assert.equal(result.continue, true);
  const draft = result.entries?.[0];
  assert.equal(draft?.type, "custom_message");
  assert.equal(draft?.customType, CONTINUATION_MESSAGE_TYPE);

  // One-shot: a second boundary with no newly armed work must not continue.
  const again = await emit("agent_before_settle", boundaryEvent("completed"));
  assert.equal(again, undefined, "boundary work is one-shot");
});

test("compaction boundary keeps work armed on aborted outcome", async () => {
  await armBoundaryCompaction();

  const aborted = await emit("agent_before_settle", boundaryEvent("aborted"));
  assert.equal(aborted, undefined, "aborted run must not auto-continue");

  const result = (await emit("agent_before_settle", boundaryEvent("completed"))) as
    | {
        entries?: Array<{ customType?: string }>;
        continue?: boolean;
      }
    | undefined;
  assert.ok(result, "armed work survives the aborted boundary");
  assert.equal(result.continue, true);
  assert.equal(result.entries?.[0]?.customType, CONTINUATION_MESSAGE_TYPE);
});

test("idle compaction with active goal sends continuation directly", async () => {
  seedActiveGoal();
  idle = true;
  await emit("session_before_compact", { type: "session_before_compact" });
  await emit("session_compact", { type: "session_compact" });

  const cont = continuationMessages();
  assert.equal(cont.length, 1, "idle compact must continue immediately");
  assert.equal((cont[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn, true);

  const again = await emit("agent_before_settle", boundaryEvent("completed"));
  assert.equal(again, undefined, "nothing armed after the direct send");
});

test("failed compaction releases goal continuation without duplicating the prequeue", async () => {
  seedActiveGoal();

  await emit("session_before_compact", {
    type: "session_before_compact",
    reason: "threshold",
    willRetry: false,
  });
  assert.equal(continuationMessages().length, 1, "busy compaction must prequeue one continuation");

  await emit("session_compact_failed", {
    type: "session_compact_failed",
    reason: "threshold",
    errorMessage: "Auto-compaction failed: provider unavailable",
    aborted: false,
    willRetry: false,
    fromExtension: false,
  });
  assert.equal(
    continuationMessages().length,
    1,
    "failure handling must not duplicate the prequeued continuation",
  );

  // The prequeued turn completed; an active goal must be able to continue again.
  await emit("agent_end", { type: "agent_end", messages: [] });
  idle = true;
  await emit("agent_settled", { type: "agent_settled" });
  assert.equal(
    continuationMessages().length,
    2,
    "failed compaction must not leave goal continuation stuck as compacting",
  );
});

// Avoid leaking timers if a future change reintroduces delayed retries.
test.after(() => {
  resetContinuationRuntime();
});
