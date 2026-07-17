import assert from "node:assert/strict";
import test from "node:test";
import { GoalManagementView, type GoalOverlaySnapshot } from "./src/surface/ui/goal-overlay.js";
import type { GoalState } from "./src/domain/types.js";

function theme() {
	return {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
	};
}

function goal(partial: Partial<GoalState> = {}): GoalState {
	return {
		goalId: "g1",
		objective: "Ship mpi-goal overlay and progressive tools",
		status: "active",
		tokensUsed: 12_000,
		tokenBudget: 100_000,
		timeUsedSeconds: 90,
		timeBudgetSeconds: 600,
		createdAt: 1,
		updatedAt: 2,
		postCompletionActions: [],
		...partial,
	};
}

test("overlay renders active goal with meters and actions", () => {
	let snap: GoalOverlaySnapshot = { goal: goal(), queue: [] };
	const view = new GoalManagementView(
		theme(),
		() => {},
		() => {},
		() => 20,
		{
			getSnapshot: () => snap,
			pause: () => {
				snap = { ...snap, goal: snap.goal ? { ...snap.goal, status: "paused" } : null };
			},
			resume: () => {},
			clear: () => {
				snap = { goal: null, queue: snap.queue };
			},
			removeQueueItem: () => {},
			clearQueue: () => {},
		},
	);

	const lines = view.render(72).join("\n");
	assert.match(lines, /mpi-goal/);
	assert.match(lines, /ACTIVE|active/i);
	assert.match(lines, /Tokens/);
	assert.match(lines, /Ship mpi-goal overlay/);
	assert.match(lines, /pause|clear|queue/i);
});

test("overlay empty state shows start hints", () => {
	const view = new GoalManagementView(
		theme(),
		() => {},
		() => {},
		() => 20,
		{
			getSnapshot: () => ({ goal: null, queue: [] }),
			pause: () => {},
			resume: () => {},
			clear: () => {},
			removeQueueItem: () => {},
			clearQueue: () => {},
		},
	);
	const text = view.render(60).join("\n");
	assert.match(text, /No active goal/);
	assert.match(text, /\/goal <objective>/);
});

test("pause key updates snapshot via actions", () => {
	let snap: GoalOverlaySnapshot = { goal: goal(), queue: [] };
	let paused = false;
	const view = new GoalManagementView(
		theme(),
		() => {},
		() => {},
		() => 20,
		{
			getSnapshot: () => snap,
			pause: () => {
				paused = true;
				snap = { ...snap, goal: snap.goal ? { ...snap.goal, status: "paused" } : null };
			},
			resume: () => {},
			clear: () => {},
			removeQueueItem: () => {},
			clearQueue: () => {},
		},
	);
	view.handleInput("p");
	assert.equal(paused, true);
	assert.equal(snap.goal?.status, "paused");
});
