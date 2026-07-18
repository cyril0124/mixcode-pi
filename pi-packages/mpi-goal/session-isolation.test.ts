import assert from "node:assert/strict";
import test from "node:test";
import { createTelemetry } from "./src/domain/telemetry.js";
import { runInGoalSession } from "./src/domain/session-scope.js";
import {
	createGoalState,
	getGoal,
	setRuntimeStateForTests,
} from "./src/persistence/goal-store.js";
import { enqueueGoal, getQueue, setQueueForTests } from "./src/persistence/queue-store.js";

test("goal memory is isolated across session keys", () => {
	runInGoalSession("tab-a", () => {
		const goal = createGoalState({ objective: "goal in tab A", now: 1 });
		setRuntimeStateForTests({ goal, telemetry: createTelemetry(goal.goalId) });
		assert.equal(getGoal()?.objective, "goal in tab A");
	});

	runInGoalSession("tab-b", () => {
		// Fresh tab must not see tab-a goal (the multi-tab leak).
		assert.equal(getGoal(), null);
		const goal = createGoalState({ objective: "goal in tab B", now: 2 });
		setRuntimeStateForTests({ goal, telemetry: createTelemetry(goal.goalId) });
		assert.equal(getGoal()?.objective, "goal in tab B");
	});

	runInGoalSession("tab-a", () => {
		assert.equal(getGoal()?.objective, "goal in tab A");
	});
});

test("queue memory is isolated across session keys", () => {
	runInGoalSession("tab-a", () => {
		setQueueForTests({ queue: [], revision: 0 });
		enqueueGoal("queued-A", "command");
		assert.equal(getQueue().length, 1);
		assert.equal(getQueue()[0]?.objective, "queued-A");
	});

	runInGoalSession("tab-b", () => {
		assert.equal(getQueue().length, 0);
		enqueueGoal("queued-B", "command");
		assert.equal(getQueue()[0]?.objective, "queued-B");
	});

	runInGoalSession("tab-a", () => {
		assert.equal(getQueue()[0]?.objective, "queued-A");
	});
});
