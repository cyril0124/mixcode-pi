/**
 * Contract: resuming a session with an active goal must prompt whether to
 * continue. Active+idle is not auto-running; UI alone must not look like work.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONTINUATION_MESSAGE_TYPE } from "./src/domain/constants.js";
import { createTelemetry } from "./src/domain/telemetry.js";
import {
	createGoalState,
	getGoal,
	persistClearGoal,
	persistSetGoal,
	persistUpdateGoal,
} from "./src/persistence/goal-store.js";
import { registerGoalLifecycle } from "./src/runtime/lifecycle.js";
import { resetContinuationRuntime, scheduleMaybeContinueGoal } from "./src/runtime/continuation.js";
import type { GoalState } from "./src/domain/types.js";

type Handler = (event: unknown, ctx?: ExtensionContext) => unknown | Promise<unknown>;

const handlers = new Map<string, Handler[]>();
const entries: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
const messages: Array<{ customType?: string; content?: string; options?: unknown }> = [];
const notifications: Array<{ message: string; type?: string }> = [];
let sendMessageError: Error | undefined;
let registered = false;
let idle = true;
let selectChoice: string | undefined;
const selectPrompts: string[] = [];

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
		if (sendMessageError) throw sendMessageError;
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
			notifications.push({ message, type });
		},
		select: async (prompt: string, _options: string[]) => {
			selectPrompts.push(prompt);
			return selectChoice;
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

function seedGoal(status: GoalState["status"]): GoalState {
	ensureLifecycle();
	resetContinuationRuntime();
	entries.length = 0;
	messages.length = 0;
	notifications.length = 0;
	sendMessageError = undefined;
	selectPrompts.length = 0;
	selectChoice = undefined;
	idle = true;
	const goal = createGoalState({ objective: "keep working until done" });
	const withStatus: GoalState = { ...goal, status, updatedAt: Date.now() };
	const telemetry = createTelemetry(withStatus.goalId);
	persistSetGoal(pi, withStatus, telemetry, "command");
	if (status !== "active") {
		persistUpdateGoal(pi, withStatus, telemetry, status === "paused" ? "abort" : "tool");
	}
	return withStatus;
}

test("session resume with active goal prompts continue and continues when accepted", async () => {
	seedGoal("active");
	selectChoice = "Continue goal";

	await emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(selectPrompts.length, 1);
	assert.match(selectPrompts[0] ?? "", /active goal/i);
	assert.equal(continuationMessages().length, 1);
	assert.equal((continuationMessages()[0]?.options as { triggerTurn?: boolean })?.triggerTurn, true);
	assert.equal((continuationMessages()[0]?.options as { deliverAs?: string })?.deliverAs, "followUp");
	assert.equal(getGoal()?.status, "active");
});

test("session resume isolates continuation send failures", async () => {
	seedGoal("active");
	selectChoice = "Continue goal";
	sendMessageError = new Error("ctx is stale");

	await emit("session_start", { type: "session_start", reason: "resume" });

	assert.equal(selectPrompts.length, 1);
	assert.equal(getGoal()?.status, "active");
});

test("user-confirmed continuation warns when no active goal remains", () => {
	seedGoal("active");
	persistClearGoal(pi, "command");

	scheduleMaybeContinueGoal(pi, ctx, "resumed");

	assert.deepEqual(notifications, [
		{
			message: "Could not start goal continuation: no active goal in this session.",
			type: "warning",
		},
	]);
});

test("session resume with active goal can leave idle without continuing", async () => {
	seedGoal("active");
	selectChoice = "Leave idle";

	await emit("session_start", { type: "session_start", reason: "resume" });
	await sleep(40);

	assert.equal(selectPrompts.length, 1);
	assert.equal(continuationMessages().length, 0);
	assert.equal(getGoal()?.status, "active");
});

test("session resume Continue starts even when session is briefly not idle", async () => {
	seedGoal("active");
	selectChoice = "Continue goal";
	// User-confirmed continue must not depend on a post-select idle race.
	idle = false;

	await emit("session_start", { type: "session_start", reason: "resume" });
	assert.equal(continuationMessages().length, 1);
	assert.equal((continuationMessages()[0]?.options as { triggerTurn?: boolean } | undefined)?.triggerTurn, true);
});

test("session reload does not prompt for active goal", async () => {
	seedGoal("active");
	selectChoice = "Continue goal";

	await emit("session_start", { type: "session_start", reason: "reload" });
	await sleep(40);

	assert.equal(selectPrompts.length, 0);
	assert.equal(continuationMessages().length, 0);
});

test("session resume with paused goal still prompts resume", async () => {
	seedGoal("paused");
	selectChoice = "Resume goal";

	await emit("session_start", { type: "session_start", reason: "resume" });
	await sleep(40);

	assert.equal(selectPrompts.length, 1);
	assert.match(selectPrompts[0] ?? "", /paused goal/i);
	assert.equal(getGoal()?.status, "active");
	assert.equal(continuationMessages().length, 1);
});

test.after(() => {
	resetContinuationRuntime();
});
