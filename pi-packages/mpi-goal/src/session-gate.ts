import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { withGoalSessionFromCtx } from "./domain/session-scope.js";
import { getGoal, replayGoalState } from "./persistence/goal-store.js";
import { getQueue, replayQueueState } from "./persistence/queue-store.js";

/**
 * True when this session already has an unfinished goal or a non-empty queue
 * and therefore needs the full mpi-goal surface (tools + lifecycle) on start.
 */
export function sessionNeedsGoalWire(ctx: ExtensionContext): boolean {
	return withGoalSessionFromCtx(ctx, () => {
		replayGoalState(ctx);
		replayQueueState(ctx);
		const goal = getGoal();
		if (goal && (goal.status === "active" || goal.status === "paused" || goal.status === "budgetLimited")) {
			return true;
		}
		return getQueue().length > 0;
	});
}
