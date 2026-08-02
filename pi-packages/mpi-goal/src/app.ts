import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getGoalFeatureFlags } from "./domain/feature-flags.js";
import { getGoal } from "./persistence/goal-store.js";
import { createContextResetActionRunner } from "./runtime/context-reset.js";
import {
	cancelGoalContinuation,
	interruptActiveGoalTurn,
	scheduleBudgetLimitWrapUp,
	scheduleMaybeContinueGoal,
} from "./runtime/continuation.js";
import { cancelAgentEndContinueArm, registerGoalLifecycle } from "./runtime/lifecycle.js";
import { createNoopPostCompletionActionRunner } from "./runtime/post-completion.js";
import { getQueue } from "./persistence/queue-store.js";
import { sendQueueHandoff, sendQueueSteering } from "./queue/steering.js";
import { handleGoalCommand, registerGoalCommand, type GoalCommandRuntime } from "./surface/command/register.js";
import { disableGoalTools, enableGoalTools } from "./surface/tools/dynamic.js";
import { registerGoalTools } from "./surface/tools/goal-tools.js";

function hasUnfinishedGoal(): boolean {
	const goal = getGoal();
	if (!goal) return false;
	return goal.status === "active" || goal.status === "paused" || goal.status === "budgetLimited";
}

function syncGoalToolActivation(pi: ExtensionAPI): void {
	// Pi auto-activates newly registered extension tools after bindCore/refresh.
	// Progressive disclosure therefore requires an explicit disable on session start
	// unless an unfinished goal/queue already needs the tools.
	if (hasUnfinishedGoal() || getQueue().length > 0) {
		enableGoalTools(pi);
		return;
	}
	disableGoalTools(pi);
}

function buildGoalCommandRuntime(pi: ExtensionAPI): GoalCommandRuntime {
	const scheduleContinuation = (
		ctx: Parameters<typeof scheduleMaybeContinueGoal>[1],
		reason: Parameters<typeof scheduleMaybeContinueGoal>[2],
	) => scheduleMaybeContinueGoal(pi, ctx, reason);
	const cancelContinuation = (goalId?: string, reason?: string) => {
		cancelGoalContinuation(goalId, reason);
		// Pause/clear must also drop armed agent_end settle/fallback continues.
		cancelAgentEndContinueArm();
	};
	const interruptActiveTurn = (
		ctx: Parameters<typeof interruptActiveGoalTurn>[1],
		goal: Parameters<typeof interruptActiveGoalTurn>[2],
	) => interruptActiveGoalTurn(pi, ctx, goal);
	return {
		scheduleContinuation,
		cancelContinuation,
		interruptActiveTurn,
		sendQueueSteering: (reason, opts) => sendQueueSteering(pi, reason, opts),
		onCommand: () => {
			enableGoalTools(pi);
		},
	};
}

export type WireMpiGoalOptions = {
	/** When false, skip registerCommand (shell already owns /goal). Default true. */
	registerCommand?: boolean;
};

/**
 * Wire the full mpi-goal surface into a Pi ExtensionAPI.
 * Goal/queue tools are registered but left inactive until /goal (or unfinished state).
 */
export function wireMpiGoal(pi: ExtensionAPI, options: WireMpiGoalOptions = {}): void {
	const registerCommand = options.registerCommand !== false;
	const flags = getGoalFeatureFlags();
	const postCompletionRunner = flags.postCompletionActions
		? createContextResetActionRunner(flags)
		: createNoopPostCompletionActionRunner("disabled by PI_GOAL_POST_COMPLETION_ACTIONS");

	const commandRuntime = buildGoalCommandRuntime(pi);
	const scheduleContinuation = commandRuntime.scheduleContinuation;
	const cancelContinuation = commandRuntime.cancelContinuation;

	if (registerCommand) {
		registerGoalCommand(pi, commandRuntime);
	}

	registerGoalTools(pi, {
		scheduleContinuation,
		cancelContinuation,
		scheduleBudgetLimitWrapUp: (ctx, goal) => scheduleBudgetLimitWrapUp(pi, ctx, goal),
		getQueueSize: () => getQueue().length,
		sendQueueSteering: (reason, opts) => sendQueueSteering(pi, reason, opts),
		sendQueueHandoff: (reason, opts) => sendQueueHandoff(pi, reason, opts),
		postCompletionRunner,
	});

	// Do NOT call getActiveTools/setActiveTools during factory load.
	// Pi throws: "Extension runtime not initialized. Action methods cannot be
	// called during extension loading." Defer active-set changes to session_start
	// (onStateRestored) and /goal handlers after bindCore.
	registerGoalLifecycle(pi, postCompletionRunner, {
		onStateRestored: () => syncGoalToolActivation(pi),
	});
}

/** Dispatch /goal after full wire (used by the cold shell command handler). */
export async function dispatchGoalCommand(
	pi: ExtensionAPI,
	args: string,
	ctx: ExtensionCommandContext,
): Promise<void> {
	const runtime = buildGoalCommandRuntime(pi);
	runtime.onCommand?.();
	await handleGoalCommand(pi, args, ctx, runtime);
}
