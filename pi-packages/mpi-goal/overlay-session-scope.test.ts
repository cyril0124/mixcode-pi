/**
 * Contract: /goal overlay getSnapshot/actions must read the same session-scoped
 * goal that was active when the overlay opened — even when the TUI later calls
 * getSnapshot outside the command's AsyncLocalStorage context.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { createTelemetry } from "./src/domain/telemetry.js";
import { runInGoalSession, withGoalSessionFromCtxAsync } from "./src/domain/session-scope.js";
import {
	createGoalState,
	getGoal,
	persistSetGoal,
	replayGoalState,
} from "./src/persistence/goal-store.js";
import { STATE_ENTRY_TYPE } from "./src/domain/constants.js";

test("getGoal is null outside ALS even when session map still holds the goal", () => {
	const goal = createGoalState({ objective: "keep me", now: 1 });
	const telemetry = createTelemetry(goal.goalId);

	const silentPi = { appendEntry() {} } as unknown as ExtensionAPI;
	runInGoalSession("session-live", () => {
		persistSetGoal(silentPi, goal, telemetry, "command");
		assert.equal(getGoal()?.objective, "keep me");
	});

	// TUI re-render path: no AsyncLocalStorage store.
	assert.equal(getGoal(), null, "without session scope, getGoal must not see other session's memory");
});

test("overlay-style getSnapshot must re-enter session key or it shows No active goal", async () => {
	const branch: Array<{ type: string; customType?: string; data?: unknown; id: string }> = [];
	const sessionId = "sess-overlay-1";
	const pi = {
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data, id: `e-${branch.length}` });
		},
	} as unknown as ExtensionAPI;

	const ctx = {
		hasUI: true,
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => branch.map((e) => ({ ...e })),
			getLeafId: () => branch.at(-1)?.id ?? "root",
		},
		ui: {
			notify() {},
			setStatus() {},
			setWidget() {},
			// Capture the factory's getSnapshot the way openGoalOverlay wires it.
			async custom(factory: (tui: unknown, theme: unknown, kb: unknown, done: (v: void) => void) => { getSnapshot?: () => { goal: unknown } }) {
				// We don't use real GoalManagementView; instead mirror the bug:
				// command sets state under ALS, then later getSnapshot runs without ALS.
				return undefined as void;
			},
		},
	} as unknown as ExtensionCommandContext;

	let leakedGetSnapshot: (() => { goal: ReturnType<typeof getGoal> }) | undefined;

	await withGoalSessionFromCtxAsync(ctx, async () => {
		const goal = createGoalState({ objective: "widget says active", now: 1 });
		const telemetry = createTelemetry(goal.goalId);
		persistSetGoal(pi, goal, telemetry, "command");
		assert.equal(getGoal()?.status, "active");
		// Buggy pattern (pre-fix): close over getGoal without session key.
		leakedGetSnapshot = () => ({ goal: getGoal() });
	});

	// After command ALS ends, naive getSnapshot loses the goal → overlay "No active goal".
	assert.equal(leakedGetSnapshot?.().goal, null, "reproduces empty overlay while session still has goal");

	// Fixed pattern: re-enter session key.
	const fixedGetSnapshot = () =>
		runInGoalSession(sessionId, () => {
			replayGoalState(ctx);
			return { goal: getGoal() };
		});
	assert.equal(fixedGetSnapshot().goal?.objective, "widget says active");
	assert.equal(fixedGetSnapshot().goal?.status, "active");
});

test("branch still contains mpi-goal-state after persist (widget/session authority)", () => {
	const branch: Array<{ type: string; customType?: string; data?: unknown }> = [];
	const pi = {
		appendEntry(customType: string, data: unknown) {
			branch.push({ type: "custom", customType, data });
		},
	} as unknown as ExtensionAPI;

	runInGoalSession("sess-branch", () => {
		const goal = createGoalState({ objective: "on branch", now: 1 });
		persistSetGoal(pi, goal, createTelemetry(goal.goalId), "command");
	});

	assert.ok(branch.some((e) => e.customType === STATE_ENTRY_TYPE));
});
