import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	beginActiveTime,
	liveActiveExtraSeconds,
	resetActiveTimeForTests,
	stopActiveTime,
	takeActiveElapsedSeconds,
	withLiveActiveTime,
} from "./src/domain/active-time.js";
import { createTelemetry } from "./src/domain/telemetry.js";
import {
	createGoalState,
	getGoal,
	persistSetGoal,
	setRuntimeStateForTests,
} from "./src/persistence/goal-store.js";
import { flushGoalActiveTime, registerGoalLifecycle } from "./src/runtime/lifecycle.js";

type Handler = (event: any, ctx?: any) => any;

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

test("pure: takeActiveElapsedSeconds advances anchor without double count", () => {
	resetActiveTimeForTests();
	const t0 = 1_000_000;
	beginActiveTime(t0);
	assert.equal(takeActiveElapsedSeconds(t0 + 2500), 2);
	assert.equal(takeActiveElapsedSeconds(t0 + 2500), 0);
	assert.equal(takeActiveElapsedSeconds(t0 + 3600), 1);
	stopActiveTime(t0 + 3600);
	assert.equal(liveActiveExtraSeconds(t0 + 99999), 0);
});

test("pure: sub-second remainders accumulate across stop/start", () => {
	resetActiveTimeForTests();
	let t = 1_000_000;
	let used = 0;
	for (let i = 0; i < 5; i++) {
		beginActiveTime(t);
		t += 400;
		used += takeActiveElapsedSeconds(t);
		stopActiveTime(t);
	}
	// 5 * 400ms = 2000ms active wall time across short turns.
	assert.equal(used, 2);
});

test("pure: withLiveActiveTime is display-only and does not mutate store", () => {
	resetActiveTimeForTests();
	const goal = createGoalState({ objective: "x", now: 1 });
	goal.timeUsedSeconds = 10;
	beginActiveTime(Date.now() - 1500);
	const live = withLiveActiveTime(goal);
	assert.ok(live.timeUsedSeconds >= 11);
	assert.equal(goal.timeUsedSeconds, 10);
	resetActiveTimeForTests();
});

function createLifecycleHarness() {
	resetActiveTimeForTests();
	setRuntimeStateForTests({ goal: null, telemetry: null });
	const handlers = new Map<string, Handler[]>();
	const appendCalls: unknown[] = [];
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		appendEntry(_type: string, data: unknown) {
			appendCalls.push(data);
		},
		sendMessage() {},
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
		ui: { setStatus() {}, setWidget() {}, notify() {}, select: async () => undefined },
		abort() {},
		sessionManager: { getBranch: () => [], getLeafId: () => "leaf" },
	} as unknown as ExtensionContext;

	registerGoalLifecycle(pi);

	async function emit(name: string, event: unknown = {}): Promise<void> {
		for (const handler of handlers.get(name) ?? []) {
			await handler(event, ctx);
		}
	}

	function seedActiveGoal(opts?: { timeBudgetSeconds?: number }) {
		const goal = createGoalState({
			objective: "track time",
			timeBudgetSeconds: opts?.timeBudgetSeconds,
			now: 1,
		});
		const telemetry = createTelemetry(goal.goalId);
		setRuntimeStateForTests({ goal, telemetry });
		persistSetGoal(pi, goal, telemetry, "tool");
		return goal;
	}

	function accountAppendCount(): number {
		return appendCalls.filter((d) => (d as { kind?: string }).kind === "account").length;
	}

	return { pi, ctx, emit, seedActiveGoal, appendCalls, accountAppendCount };
}

// Lifecycle registration is additive per harness instance — one harness per test file section.
let harness: ReturnType<typeof createLifecycleHarness> | null = null;
function H() {
	if (!harness) harness = createLifecycleHarness();
	return harness;
}

test("lifecycle: tool_result flushes whole seconds; sub-second does not persist", async () => {
	const h = createLifecycleHarness();
	harness = h;
	h.seedActiveGoal();
	const before = h.accountAppendCount();
	await h.emit("turn_start", { timestamp: Date.now() });
	// no whole second yet
	await h.emit("tool_result", { isError: false, toolName: "bash", details: {} });
	assert.equal(h.accountAppendCount(), before, "sub-second tool_result must not account");
	await sleep(1100);
	await h.emit("tool_result", { isError: false, toolName: "bash", details: {} });
	assert.ok(h.accountAppendCount() > before, ">=1s tool_result should account");
	assert.ok((getGoal()?.timeUsedSeconds ?? 0) >= 1);
});

test("lifecycle: turn idle between turns is not billed", async () => {
	const h = H();
	resetActiveTimeForTests();
	setRuntimeStateForTests({ goal: null, telemetry: null });
	// re-seed on same handlers
	const goal = createGoalState({ objective: "idle", now: 1 });
	const telemetry = createTelemetry(goal.goalId);
	setRuntimeStateForTests({ goal, telemetry });
	persistSetGoal(h.pi, goal, telemetry, "tool");

	await h.emit("turn_start", { timestamp: Date.now() });
	await sleep(1100);
	await h.emit("turn_end", {
		message: {
			role: "assistant",
			stopReason: "stop",
			usage: { totalTokens: 1, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
		},
	});
	const afterTurn = getGoal()?.timeUsedSeconds ?? 0;
	assert.ok(afterTurn >= 1);
	await sleep(1200);
	// no turn running — sleep must not add
	const afterIdle = getGoal()?.timeUsedSeconds ?? 0;
	assert.equal(afterIdle, afterTurn);
});

test("lifecycle: message_update without hard-stop does not appendEntry account", async () => {
	const h = H();
	const goal = createGoalState({ objective: "stream", timeBudgetSeconds: 10_000, now: 1 });
	const telemetry = createTelemetry(goal.goalId);
	setRuntimeStateForTests({ goal, telemetry });
	persistSetGoal(h.pi, goal, telemetry, "tool");
	await h.emit("turn_start", { timestamp: Date.now() });
	const before = h.appendCalls.length;
	await h.emit("message_update", { message: { role: "assistant", usage: { totalTokens: 10 } } });
	const after = h.appendCalls.length;
	assert.equal(after, before, "message_update must not write session when not hard-stopping");
});

test("lifecycle: hard-stop flushes time before status change", async () => {
	const h = H();
	// budget 2s → hard stop at ceil(2*1.1)=3
	const goal = createGoalState({ objective: "hs", timeBudgetSeconds: 2, now: 1 });
	const telemetry = createTelemetry(goal.goalId);
	setRuntimeStateForTests({ goal, telemetry });
	persistSetGoal(h.pi, goal, telemetry, "tool");
	await h.emit("turn_start", { timestamp: Date.now() });
	await sleep(3100);
	await h.emit("message_update", { message: { role: "assistant", usage: { totalTokens: 0 } } });
	const g = getGoal();
	assert.equal(g?.status, "budgetLimited");
	assert.ok((g?.timeUsedSeconds ?? 0) >= 3, `expected used>=3 after hard-stop, got ${g?.timeUsedSeconds}`);
});

test("flushGoalActiveTime is no-op when clock stopped", () => {
	const h = H();
	resetActiveTimeForTests();
	const goal = createGoalState({ objective: "n", now: 1 });
	setRuntimeStateForTests({ goal, telemetry: createTelemetry(goal.goalId) });
	const n = flushGoalActiveTime(h.pi, "turn");
	assert.equal(n, 0);
});
