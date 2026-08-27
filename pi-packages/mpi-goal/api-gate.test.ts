/**
 * Contract: after Pi retries exhaust with stopReason=error, mpi-goal pauses the
 * goal (not active+idle). User resume re-opens apiGate and continues.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE } from "./src/domain/constants.js";
import { createTelemetry, isApiGateBlocked } from "./src/domain/telemetry.js";
import {
  createGoalState,
  getGoal,
  getTelemetry,
  persistSetGoal,
} from "./src/persistence/goal-store.js";
import { registerGoalLifecycle } from "./src/runtime/lifecycle.js";
import { resetContinuationRuntime } from "./src/runtime/continuation.js";

type Handler = (event: unknown, ctx?: ExtensionContext) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler[]>();
const entries: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
const messages: Array<{ customType?: string; content?: string; options?: unknown }> = [];
const notifies: Array<{ message: string; type?: string }> = [];
let registered = false;
let idle = true;

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
  hasUI: true,
  ui: {
    setStatus() {},
    setWidget() {},
    notify(message: string, type?: string) {
      notifies.push({ message, type });
    },
    select: async (prompt: string) => {
      if (/paused/i.test(prompt)) return "Resume goal";
      return "Continue goal";
    },
  },
  abort() {},
  isIdle() {
    return idle;
  },
  hasPendingMessages() {
    return false;
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

async function emit(name: string, event: unknown = {}): Promise<void> {
  for (const handler of handlers.get(name) ?? []) {
    await handler(event, ctx);
  }
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
  notifies.length = 0;
  idle = true;
  const goal = createGoalState({ objective: "keep working until done" });
  const telemetry = createTelemetry(goal.goalId);
  persistSetGoal(pi, goal, telemetry, "command");
}

test("final agent_end error pauses goal and does not auto-continue", async () => {
  seedActiveGoal();

  await emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "503 unavailable" }],
  });
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);

  assert.equal(continuationMessages().length, 0, "must not auto-continue after API error");
  assert.equal(getGoal()?.status, "paused");
  assert.equal(isApiGateBlocked(getTelemetry()), true);
  assert.equal(getTelemetry()?.lastSkipReason, "apiError");
  assert.equal(getTelemetry()?.lastSafetyPauseReason, "apiError");
  assert.ok(
    notifies.some((n) => /Upstream API failed/i.test(n.message) && /paused/i.test(n.message)),
  );
});

test("intermediate agent_end error does not pause before settle (Pi may still retry)", async () => {
  seedActiveGoal();

  // Pi emits agent_end(error) before auto-retry; settle comes only after retries finish.
  await emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "503" }],
  });
  // Longer than the normal 500ms settle fallback — error path must not arm it.
  await sleep(600);

  assert.equal(getGoal()?.status, "active", "must stay active while retries may still run");
  assert.equal(continuationMessages().length, 0);
  assert.equal(notifies.length, 0, "must not notify pause mid-retry");

  // Successful end after retry should auto-continue, not treat as API pause.
  await emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);

  assert.equal(getGoal()?.status, "active");
  assert.equal(isApiGateBlocked(getTelemetry()), false);
  assert.equal(continuationMessages().length, 1);
});

test("user resume after apiError re-opens gate and continues", async () => {
  seedActiveGoal();

  await emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "error", errorMessage: "503" }],
  });
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(20);
  assert.equal(getGoal()?.status, "paused");
  assert.equal(continuationMessages().length, 0);

  await emit("session_start", { type: "session_start", reason: "resume" });
  await sleep(40);

  assert.equal(getGoal()?.status, "active");
  assert.equal(isApiGateBlocked(getTelemetry()), false);
  assert.equal(continuationMessages().length, 1);
  assert.equal(
    (continuationMessages()[0]?.options as { triggerTurn?: boolean })?.triggerTurn,
    true,
  );
});

test("normal stop still auto-continues when gate is open", async () => {
  seedActiveGoal();

  await emit("agent_end", {
    type: "agent_end",
    messages: [{ role: "assistant", stopReason: "stop" }],
  });
  await emit("agent_settled", { type: "agent_settled" });
  await sleep(40);

  assert.equal(continuationMessages().length, 1);
  assert.equal(getGoal()?.status, "active");
  assert.equal(isApiGateBlocked(getTelemetry()), false);
});

test.after(() => {
  resetContinuationRuntime();
});
