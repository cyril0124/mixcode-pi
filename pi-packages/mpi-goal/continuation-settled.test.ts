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

test("agent_end fallback continues if agent_settled never fires", async () => {
	seedActiveGoal();
	idle = true;
	// Only agent_end — no settled (host bug / early exit).
	await emit("agent_end", { type: "agent_end", messages: [] });
	assert.equal(continuationMessages().length, 0, "must wait for settle/fallback window");
	await sleep(600);
	assert.equal(continuationMessages().length, 1, "fallback must kick auto-continue");
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
