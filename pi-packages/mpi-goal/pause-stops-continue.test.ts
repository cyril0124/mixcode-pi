/**
 * Contract: after /goal pause, already-armed agent_end continues and stale
 * queued mpi-goal-continuation messages must not keep the agent running.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE } from "./src/domain/constants.js";
import { createTelemetry } from "./src/domain/telemetry.js";
import {
	createGoalState,
	getGoal,
	persistSetGoal,
	persistUpdateGoal,
} from "./src/persistence/goal-store.js";
import { cancelAgentEndContinueArm, registerGoalLifecycle } from "./src/runtime/lifecycle.js";
import { cancelGoalContinuation, resetContinuationRuntime, scheduleMaybeContinueGoal } from "./src/runtime/continuation.js";

type Handler = (event: unknown, ctx?: ExtensionContext) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler[]>();
const entries: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
const messages: Array<{ customType?: string; content?: string; options?: unknown }> = [];
let registered = false;
let idle = true;
let aborted = 0;

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
	abort() {
		aborted += 1;
	},
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
	cancelAgentEndContinueArm();
	entries.length = 0;
	messages.length = 0;
	aborted = 0;
	idle = true;
	const goal = createGoalState({ objective: "keep working" });
	const telemetry = createTelemetry(goal.goalId);
	persistSetGoal(pi, goal, telemetry, "command");
}

function pauseGoalLikeCommand(): void {
	const goal = getGoal();
	assert.ok(goal);
	cancelGoalContinuation(goal.goalId);
	cancelAgentEndContinueArm();
	const paused = { ...goal, status: "paused" as const, updatedAt: Date.now() };
	persistUpdateGoal(pi, paused, createTelemetry(goal.goalId), "command");
}

test("pause cancels armed agent_end continue so settle does not send", async () => {
	seedActiveGoal();

	// Arm agent_end continue path (as if a run just ended).
	await emit("agent_end", {
		type: "agent_end",
		messages: [{ role: "assistant", stopReason: "stop" }],
	});
	// User pauses before settle/fallback fires.
	pauseGoalLikeCommand();
	await emit("agent_settled", { type: "agent_settled" });
	await sleep(550);

	assert.equal(getGoal()?.status, "paused");
	assert.equal(continuationMessages().length, 0, "paused goal must not agentEnd-continue");
});

test("stale queued continuation aborts when goal is paused", async () => {
	seedActiveGoal();
	pauseGoalLikeCommand();

	await emit("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: CONTINUATION_MESSAGE_TYPE,
			content: "Continue working toward the active session goal.",
			display: false,
		},
	});

	assert.equal(aborted, 1, "must abort turn kicked by stale continuation");
});

test("active goal still accepts continuation message_start", async () => {
	seedActiveGoal();

	await emit("message_start", {
		type: "message_start",
		message: {
			role: "custom",
			customType: CONTINUATION_MESSAGE_TYPE,
			content: "Continue working toward the active session goal.",
			display: false,
		},
	});

	assert.equal(aborted, 0);
});

test("schedule agentEnd after pause does not send continuation", async () => {
	seedActiveGoal();
	pauseGoalLikeCommand();
	scheduleMaybeContinueGoal(pi, ctx, "agentEnd");
	await sleep(40);
	assert.equal(continuationMessages().length, 0);
});

test.after(() => {
	resetContinuationRuntime();
	cancelAgentEndContinueArm();
});
