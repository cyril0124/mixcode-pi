/**
 * Reproduction harness for suspected timeUsedSeconds bugs.
 * Failing assertion = bug confirmed (broken contract).
 * Passing assertion = suspicion false under this harness.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { evaluateBudgetPressure, isBudgetHardStop } from "./src/domain/budget.js";
import { TIME_BUDGET_WARNING_REMAINING_SECONDS, TOKEN_BUDGET_WARNING_REMAINING } from "./src/domain/constants.js";
import { createTelemetry } from "./src/domain/telemetry.js";
import {
	createGoalState,
	getGoal,
	persistAccountGoal,
	persistSetGoal,
	replayGoalState,
	setRuntimeStateForTests,
} from "./src/persistence/goal-store.js";
import { registerGoalLifecycle } from "./src/runtime/lifecycle.js";
import {
	captureContextResetCommandContext,
	createContextResetActionRunner,
} from "./src/runtime/context-reset.js";
import {
	createPostCompletionActionStates,
	recordPostStartActionAnchors,
	runPostCompletionActionsSafely,
} from "./src/runtime/post-completion.js";
import type { GoalState } from "./src/domain/types.js";

type Handler = (event: any, ctx?: any) => any;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** One lifecycle registration for the whole file (module handlers are additive). */
const handlers = new Map<string, Handler[]>();
const entries: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
const messages: Array<{ customType?: string; content?: string }> = [];
let aborted = 0;
let leafId = "leaf-0";
let registered = false;

const pi = {
	on(name: string, handler: Handler) {
		const list = handlers.get(name) ?? [];
		list.push(handler);
		handlers.set(name, list);
	},
	appendEntry(customType: string, data: unknown) {
		const id = `entry-${entries.length + 1}`;
		entries.push({ type: "custom", customType, data, id });
		leafId = id;
	},
	sendMessage(msg: { customType?: string; content?: string }) {
		messages.push(msg);
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
	sessionManager: {
		getBranch() {
			return entries.map((e) => ({ ...e }));
		},
		getLeafId() {
			return leafId;
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

function resetScene(): void {
	ensureLifecycle();
	entries.length = 0;
	messages.length = 0;
	aborted = 0;
	leafId = "leaf-0";
	setRuntimeStateForTests({ goal: null, telemetry: null });
}

function seedGoal(goal: GoalState): void {
	const telemetry = createTelemetry(goal.goalId);
	setRuntimeStateForTests({ goal, telemetry });
	persistSetGoal(pi, goal, telemetry, "tool");
}

function assistantTurnEndMessage(totalTokens = 0) {
	return {
		role: "assistant" as const,
		stopReason: "stop",
		usage: { totalTokens, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
	};
}

test("pure: hard-stop threshold for time budget 100 is 110", () => {
	const goal = createGoalState({ objective: "t", timeBudgetSeconds: 100, now: 1 });
	goal.timeUsedSeconds = 109;
	assert.equal(isBudgetHardStop(evaluateBudgetPressure(goal).kind), false);
	goal.timeUsedSeconds = 110;
	assert.equal(isBudgetHardStop(evaluateBudgetPressure(goal).kind), true);
});

test("REPRO: many sub-1s turns undercount wall clock (floor to seconds)", async () => {
	resetScene();
	// no budgets — isolate pure accounting
	seedGoal(createGoalState({ objective: "short turns", now: 1 }));

	for (let i = 0; i < 5; i++) {
		await emit("turn_start", { timestamp: Date.now() });
		await sleep(400);
		await emit("turn_end", { message: assistantTurnEndMessage(1) });
	}

	const used = getGoal()?.timeUsedSeconds ?? -1;
	// ~2.0s wall clock across turns; per-turn floor(ms/1000) often yields 0
	assert.ok(
		used >= 1,
		`BUG CONFIRMED: ~2s wall-clock turn work accounted as timeUsedSeconds=${used}`,
	);
});

test("REPRO: stream hard-stop aborts without persisting estimated elapsed", async () => {
	resetScene();
	// budget 2s → hardStop = ceil(2*1.1)=3
	seedGoal(createGoalState({ objective: "hard stop", timeBudgetSeconds: 2, now: 1 }));

	await emit("turn_start", { timestamp: Date.now() });
	await sleep(3100);
	await emit("message_update", {
		message: { role: "assistant", usage: { totalTokens: 0 } },
	});

	assert.equal(aborted, 1, "expected stream hard-stop to abort");
	const after = getGoal();
	assert.equal(after?.status, "budgetLimited");
	const used = after?.timeUsedSeconds ?? -1;
	// Decision used estimated >=3s; persist should not leave 0 if host never emits turn_end
	assert.ok(
		used >= 3,
		`BUG CONFIRMED: hard-stop fired but persisted timeUsedSeconds=${used} (estimated was >=3; no turn_end yet)`,
	);
});

test("REPRO: missing turn_end loses the entire turn elapsed", async () => {
	resetScene();
	seedGoal(createGoalState({ objective: "orphan turn", now: 1 }));

	await emit("turn_start", { timestamp: Date.now() });
	await sleep(1500);
	// overwrite activeTurn without end
	await emit("turn_start", { timestamp: Date.now() });
	await emit("turn_end", { message: assistantTurnEndMessage(1) });

	const used = getGoal()?.timeUsedSeconds ?? -1;
	assert.ok(
		used >= 1,
		`BUG CONFIRMED: orphaned ~1.5s turn dropped; timeUsedSeconds=${used}`,
	);
});

test("REPRO: mid-turn goal replace drops turn accounting", async () => {
	resetScene();
	const first = createGoalState({ objective: "first", now: 1 });
	seedGoal(first);

	await emit("turn_start", { timestamp: Date.now() });
	await sleep(1200);

	const second = createGoalState({ objective: "second", now: Date.now() });
	const telemetry = createTelemetry(second.goalId);
	setRuntimeStateForTests({ goal: second, telemetry });
	persistSetGoal(pi, second, telemetry, "tool");

	await emit("turn_end", { message: assistantTurnEndMessage(5) });

	const current = getGoal();
	// Current code: stale goalId → account ignored; second stays 0; first gone from runtime
	assert.ok(
		(current?.timeUsedSeconds ?? 0) >= 1,
		`BUG CONFIRMED: mid-turn replace dropped ~1.2s; current timeUsedSeconds=${current?.timeUsedSeconds ?? "null"} goal=${current?.objective}`,
	);
});

test("REPRO: token stream warning suppresses time stream warning same turn", async () => {
	resetScene();
	assert.ok(TOKEN_BUDGET_WARNING_REMAINING >= 100);
	assert.ok(TIME_BUDGET_WARNING_REMAINING_SECONDS >= 1);

	const goal = createGoalState({
		objective: "warn dedup",
		tokenBudget: 100,
		// large enough that hard-stop won't fire on +1.5s, but remaining will enter time warning band
		timeBudgetSeconds: 100,
		now: 1,
	});
	// remaining tokens = 15 <= 100k → tokenWarning
	goal.tokensUsed = 85;
	// remaining time base 50; +1.5s stream still remaining ~48.5 <= 60 → timeWarning
	goal.timeUsedSeconds = 50;
	seedGoal(goal);

	await emit("turn_start", { timestamp: Date.now() });
	await emit("message_update", {
		message: { role: "assistant", usage: { totalTokens: 0 } },
	});
	const tokenWarnings = messages.filter((m) => /token budget warning/i.test(m.content ?? ""));
	assert.ok(tokenWarnings.length > 0, `setup failed: no token warning; msgs=${JSON.stringify(messages)}`);

	await sleep(1500);
	await emit("message_update", {
		message: { role: "assistant", usage: { totalTokens: 0 } },
	});
	const timeWarnings = messages.filter((m) => /time budget warning/i.test(m.content ?? ""));
	assert.ok(
		timeWarnings.length > 0,
		`BUG CONFIRMED: token warning suppressed time warning same turn; msgs=${JSON.stringify(messages.map((m) => m.content))}`,
	);
});

test("REPRO: context.reset navigates to pre-set anchor; intermediate branch loses goal events", async () => {
	// Separate from lifecycle entries array
	const branch: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [
		{ type: "message", id: "m0" },
	];
	let localLeaf = "m0";
	const localPi = {
		appendEntry(customType: string, data: unknown) {
			const id = `e-${branch.length}`;
			branch.push({ type: "custom", customType, data, id });
			localLeaf = id;
		},
	} as unknown as ExtensionAPI;
	const localCtx = {
		sessionManager: {
			getBranch: () => branch.map((e) => ({ ...e })),
			getLeafId: () => localLeaf,
		},
	} as unknown as ExtensionContext;

	let goal = createGoalState({
		objective: "reset me",
		postCompletionActions: createPostCompletionActionStates([{ type: "context.reset", mode: "summarize" }]),
		now: 1,
	});
	// Same order as create_goal tool path
	goal = recordPostStartActionAnchors(localPi, localCtx, goal, "tool");
	const anchor = goal.postCompletionActions?.[0]?.anchorEntryId;
	assert.equal(anchor, "m0");

	const telemetry = createTelemetry(goal.goalId);
	setRuntimeStateForTests({ goal, telemetry });
	persistSetGoal(localPi, goal, telemetry, "tool");
	persistAccountGoal(localPi, goal.goalId, { timeUsedSeconds: 42, tokensUsed: 10 }, telemetry, "turn");
	assert.equal(getGoal()?.timeUsedSeconds, 42);

	const idsBeforeNav = branch.map((b) => b.id);
	assert.ok(idsBeforeNav.includes("e-1") || idsBeforeNav.length > 1, `expected set/account entries: ${idsBeforeNav}`);

	let navigatedTo: string | undefined;
	captureContextResetCommandContext({
		navigateTree: async (entryId: string) => {
			navigatedTo = entryId;
			const idx = branch.findIndex((e) => e.id === entryId);
			if (idx >= 0) branch.splice(idx + 1);
			localLeaf = entryId;
			// Host would fire session_tree here — simulate immediate replay impact
			const mid = replayGoalState(localCtx);
			assert.equal(
				mid.goal,
				null,
				"expected mid-navigate replay to lose goal when anchor is before set",
			);
			return { cancelled: false };
		},
	} as any);

	const completed: GoalState = { ...getGoal()!, status: "complete" };
	setRuntimeStateForTests({ goal: completed, telemetry });
	const runner = createContextResetActionRunner({
		postCompletionActions: true,
		contextReset: true,
		contextResetClear: false,
	});
	await runPostCompletionActionsSafely(localPi, localCtx, completed, "tool", runner);

	assert.equal(navigatedTo, "m0");
	// Final state may re-append via persistActionState after navigate.
	const final = getGoal();
	const finalBranchIds = branch.map((b) => b.id);
	// Bug signal #1 already asserted mid-navigate goal=null.
	// Bug signal #2: historical account entry is gone from branch (only re-seeded snapshot may remain).
	const hasAccountKind = branch.some((e) => {
		const data = e.data as { kind?: string } | undefined;
		return data?.kind === "account";
	});
	assert.ok(
		hasAccountKind,
		`BUG CONFIRMED: context.reset dropped account history from branch; ids=${finalBranchIds.join(",")} finalUsed=${final?.timeUsedSeconds}`,
	);
});
