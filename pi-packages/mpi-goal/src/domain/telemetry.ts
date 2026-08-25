import { TELEMETRY_SCHEMA_VERSION } from "./constants.js";
import { currentGoalSessionKey } from "./session-scope.js";
import type {
	ApiGateState,
	BudgetHardStopReason,
	BudgetWarningReason,
	ContinuationSkipReason,
	FloorValuePassId,
	GoalTelemetrySnapshot,
	SafetyPauseReason,
	TurnAccountingSnapshot,
	TurnOrigin,
} from "./types.js";

/** Per-session one-shot origin handoff (auto / budgetWrapUp / user). */
const nextTurnOriginBySession = new Map<string, TurnOrigin>();

export function setNextTurnOrigin(origin: TurnOrigin): void {
	nextTurnOriginBySession.set(currentGoalSessionKey(), origin);
}

export function consumeNextTurnOrigin(): TurnOrigin {
	const key = currentGoalSessionKey();
	const origin = nextTurnOriginBySession.get(key) ?? "user";
	nextTurnOriginBySession.set(key, "user");
	return origin;
}

export function createTelemetry(goalId: string, now = Date.now()): GoalTelemetrySnapshot {
	return {
		version: TELEMETRY_SCHEMA_VERSION,
		goalId,
		consecutiveAutoTurns: 0,
		consecutiveNoProgressTurns: 0,
		updatedAt: now,
	};
}

export function isTelemetry(value: unknown): value is GoalTelemetrySnapshot {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return v.version === TELEMETRY_SCHEMA_VERSION && typeof v.goalId === "string";
}

export function noteContinuationScheduled(
	telemetry: GoalTelemetrySnapshot | null,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, lastSkipReason: undefined, updatedAt: now };
}

export function noteContinuationSkipped(
	telemetry: GoalTelemetrySnapshot | null,
	reason: ContinuationSkipReason,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, lastSkipReason: reason, updatedAt: now };
}

export function isApiGateBlocked(telemetry: GoalTelemetrySnapshot | null | undefined): boolean {
	return telemetry?.apiGate === "blocked";
}

export function noteApiGate(
	telemetry: GoalTelemetrySnapshot | null,
	gate: ApiGateState,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, apiGate: gate, updatedAt: now };
}

export function noteBudgetWrapUpSent(
	telemetry: GoalTelemetrySnapshot | null,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, updatedAt: now };
}

export function noteCompactionContinuation(
	telemetry: GoalTelemetrySnapshot | null,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, updatedAt: now };
}

export function noteBudgetLimit(
	telemetry: GoalTelemetrySnapshot | null,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, updatedAt: now };
}

export function noteBudgetWarning(
	telemetry: GoalTelemetrySnapshot | null,
	reason: BudgetWarningReason,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return {
		...telemetry,
		tokenBudgetWarningSent: telemetry.tokenBudgetWarningSent || reason === "tokenWarning",
		timeBudgetWarningSent: telemetry.timeBudgetWarningSent || reason === "timeWarning",
		updatedAt: now,
	};
}

export function noteBudgetHardStop(
	telemetry: GoalTelemetrySnapshot | null,
	reason: BudgetHardStopReason,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, lastBudgetHardStopReason: reason, updatedAt: now };
}

export function noteSafetyPause(
	telemetry: GoalTelemetrySnapshot | null,
	reason: SafetyPauseReason,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return { ...telemetry, lastSafetyPauseReason: reason, updatedAt: now };
}

export function resetSafetyCounters(
	telemetry: GoalTelemetrySnapshot | null,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return {
		...telemetry,
		consecutiveAutoTurns: 0,
		consecutiveNoProgressTurns: 0,
		lastSafetyPauseReason: undefined,
		updatedAt: now,
	};
}

export function applyTurnTelemetry(
	telemetry: GoalTelemetrySnapshot | null,
	turn: TurnAccountingSnapshot,
	madeProgress: boolean,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry || telemetry.goalId !== turn.goalId) return telemetry;
	const auto = turn.origin === "auto" || turn.origin === "budgetWrapUp";
	return {
		...telemetry,
		consecutiveAutoTurns: auto ? telemetry.consecutiveAutoTurns + 1 : 0,
		consecutiveNoProgressTurns: auto && !madeProgress ? telemetry.consecutiveNoProgressTurns + 1 : 0,
		lastTurnOrigin: turn.origin,
		lastTurnToolCallCount: turn.toolCallCount,
		lastTurnToolResultCount: turn.toolResultCount,
		lastTurnCompletedGoal: turn.completedGoal,
		updatedAt: now,
	};
}

export function noteFloorCompletionDeferred(
	telemetry: GoalTelemetrySnapshot | null,
	cardId: FloorValuePassId,
	now = Date.now(),
): GoalTelemetrySnapshot | null {
	if (!telemetry) return null;
	return {
		...telemetry,
		lastFloorCardId: cardId,
		floorSteerCount: (telemetry.floorSteerCount ?? 0) + 1,
		floorQualityState: "steering",
		updatedAt: now,
	};
}

export function makeTurnSnapshot(goalId: string, origin: TurnOrigin, startedAt = Date.now()): TurnAccountingSnapshot {
	return { goalId, origin, startedAt, toolCallCount: 0, toolResultCount: 0, progressCount: 0, completedGoal: false };
}
