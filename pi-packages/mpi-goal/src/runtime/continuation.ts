import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	BUDGET_LIMIT_MESSAGE_TYPE,
	CONTINUATION_MESSAGE_TYPE,
	PAUSE_MESSAGE_TYPE,
	MAX_CONSECUTIVE_AUTO_TURNS,
	MAX_NO_PROGRESS_AUTO_TURNS,
} from "../domain/constants.js";
import { isBudgetExhausted } from "../domain/budget.js";
import { evaluateCompletionFloor } from "../domain/floor.js";
import { buildBudgetLimitPrompt, buildContinuationPrompt, buildPausePrompt } from "./prompts.js";
import { getQueue } from "../persistence/queue-store.js";
import { decideTerminalContinuationTicket, dispatchContinuationTicket, revalidateContinuationTicket } from "./continuation-ticket.js";
import { getGoal, getTelemetry, persistTelemetry } from "../persistence/goal-store.js";
import { notifyWarning } from "../surface/ui/notify.js";
import {
	isApiGateBlocked,
	noteApiGate,
	noteBudgetWrapUpSent,
	noteCompactionContinuation,
	noteContinuationScheduled,
	noteContinuationSkipped,
	setNextTurnOrigin,
} from "../domain/telemetry.js";
import type { ContinuationReason, ContinuationSkipReason, GoalState } from "../domain/types.js";
import { currentGoalSessionKey, runInGoalSession } from "../domain/session-scope.js";

type PendingContinuation = {
	goalId: string;
	reason: ContinuationReason;
	timer: ReturnType<typeof setTimeout>;
};

type PendingBudgetWrapUp = {
	goalId: string;
	timer: ReturnType<typeof setTimeout>;
};

type CompactionContinuationWork =
	| { kind: "activeGoal"; goalId: string; key: string }
	| { kind: "queueHandoff"; goalId: string; queueId: string; key: string };

type ContinuationAttemptResult =
	| { kind: "sent" }
	| { kind: "transientSkip"; reason: "notIdle" | "pendingMessages" }
	| { kind: "terminalSkip"; reason: ContinuationSkipReason | "queueMissing" | "queueChanged" | "retryExhausted" };

const DEFAULT_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 2_000];

type ContinuationSessionState = {
	pendingContinuation?: PendingContinuation;
	budgetWrapUps: Map<string, PendingBudgetWrapUp>;
	compactionActive: boolean;
	compactionWork?: CompactionContinuationWork;
	prequeuedCompactionKey?: string;
	fallbackTimer?: ReturnType<typeof setTimeout>;
	fallbackAttempts: number;
	fallbackRetryDelaysMs: number[];
};

const continuationBySession = new Map<string, ContinuationSessionState>();

function contState(): ContinuationSessionState {
	const key = currentGoalSessionKey();
	let state = continuationBySession.get(key);
	if (!state) {
		state = {
			budgetWrapUps: new Map(),
			compactionActive: false,
			fallbackAttempts: 0,
			fallbackRetryDelaysMs: [...DEFAULT_RETRY_DELAYS_MS],
		};
		continuationBySession.set(key, state);
	}
	return state;
}

function scheduleInSession(delayMs: number, fn: () => void): ReturnType<typeof setTimeout> {
	const sessionKey = currentGoalSessionKey();
	return setTimeout(() => {
		runInGoalSession(sessionKey, fn);
	}, delayMs);
}

export function beginGoalCompaction(pi: ExtensionAPI, ctx: ExtensionContext): void {
	logRuntime("beginGoalCompaction.start");
	contState().compactionActive = true;
	cancelFallbackTimer();
	contState().fallbackAttempts = 0;
	contState().prequeuedCompactionKey = undefined;
	const work = currentCompactionWork();
	contState().compactionWork = work;
	logRuntime("beginGoalCompaction.workSelected", workFields(work));
	if (!work) return;
	const pending = contState().pendingContinuation;
	if (work.kind === "activeGoal" && pending?.goalId === work.goalId) {
		logRuntime("beginGoalCompaction.cancelPendingContinuation", { pendingGoalId: pending.goalId, pendingReason: pending.reason });
		clearTimeout(pending.timer);
		contState().pendingContinuation = undefined;
	}
	skip(pi, "compacting");
	if (ctx.isIdle()) {
		logRuntime("beginGoalCompaction.prequeueSkippedIdle", workFields(work));
		finishCompactionTelemetry(pi, "prequeue", work.key, 0, "prequeueSkippedIdle");
		return;
	}
	const prequeued = prequeueCompactionWork(pi, work);
	if (prequeued) contState().prequeuedCompactionKey = work.key;
	logRuntime("beginGoalCompaction.end", {
		...workFields(work),
		prequeued,
		prequeuedCompactionKey: contState().prequeuedCompactionKey,
	});
}

export function finishGoalCompaction(pi: ExtensionAPI, ctx: ExtensionContext): void {
	logRuntime("finishGoalCompaction.start", workFields(contState().compactionWork));
	contState().compactionActive = false;
	const work = contState().compactionWork;
	if (!work) {
		logRuntime("finishGoalCompaction.noWork");
		return;
	}
	if (!compactionWorkStillApplies(work)) {
		logRuntime("finishGoalCompaction.workNoLongerApplies", workFields(work));
		clearCompactionRuntime();
		return;
	}
	if (contState().prequeuedCompactionKey === work.key) {
		logRuntime("finishGoalCompaction.prequeuedAlready", workFields(work));
		finishCompactionTelemetry(pi, "fallbackFinished", work.key, 0, "prequeued");
		clearCompactionRuntime({ keepPrequeueKey: true });
		return;
	}
	logRuntime("finishGoalCompaction.scheduleFallback", workFields(work));
	scheduleCompactionFallbackRetry(pi, ctx, work);
}

export function scheduleMaybeContinueGoal(pi: ExtensionAPI, ctx: ExtensionContext, reason: ContinuationReason): void {
	const goal = getGoal();
	if (goal?.status !== "active") {
		logRuntime("scheduleMaybeContinueGoal.skip.notActive", { reason });
		if (isUserConfirmedContinuation(reason) && ctx.hasUI) {
			notifyWarning(ctx, "Could not start goal continuation: no active goal in this session.");
		}
		return;
	}
	// User resume/create always re-opens the API gate (upstream may be back).
	if (isUserConfirmedContinuation(reason)) {
		openApiGate(pi);
	} else if (reason === "agentEnd" && isApiGateBlocked(getTelemetry())) {
		logRuntime("scheduleMaybeContinueGoal.skip.apiError", { reason, goalId: goal.goalId });
		skip(pi, "apiError");
		return;
	}
	if (shouldSuppressAgentEndContinuation(reason)) {
		logRuntime("scheduleMaybeContinueGoal.skip.noProgress", { reason, goalId: goal.goalId });
		skip(pi, "noProgress");
		return;
	}
	cancelGoalContinuation(goal.goalId, "reschedule-continuation");
	const telemetry = noteContinuationScheduled(getTelemetry(), reason);
	if (telemetry) persistTelemetry(pi, telemetry, "continuation");
	const goalId = goal.goalId;
	// User-confirmed starts must fire now. The async wrapper catches send failures
	// without delaying attemptContinueGoal before its first await.
	if (isUserConfirmedContinuation(reason)) {
		void safelyRun(async () => {
			attemptContinueGoal(pi, ctx, reason, goalId, { force: true });
		});
		logRuntime("scheduleMaybeContinueGoal.forced", { reason, goalId });
		return;
	}
	// agent_settled / post-compact already mean the previous run finished. A 25ms
	// delay only opens a race where process/subagent wakes steal idle and we drop.
	if (reason === "agentEnd" || reason === "compacted") {
		void safelyRun(async () => {
			attemptContinueGoal(pi, ctx, reason, goalId);
		});
		logRuntime("scheduleMaybeContinueGoal.immediate", { reason, goalId });
		return;
	}
	const timer = scheduleInSession(25, () => {
		if (contState().pendingContinuation?.goalId === goalId) contState().pendingContinuation = undefined;
		void safelyRun(async () => { attemptContinueGoal(pi, ctx, reason, goalId); });
	});
	contState().pendingContinuation = { goalId, reason, timer };
	logRuntime("scheduleMaybeContinueGoal.scheduled", { reason, goalId });
}

export function scheduleBudgetLimitWrapUp(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalState): void {
	if (contState().budgetWrapUps.has(goal.goalId)) return;
	const timer = scheduleInSession(25, () => {
		contState().budgetWrapUps.delete(goal.goalId);
		void safelyRun(() => maybeSendBudgetWrapUp(pi, ctx, goal.goalId));
	});
	contState().budgetWrapUps.set(goal.goalId, { goalId: goal.goalId, timer });
}

export function cancelGoalContinuation(goalId?: string, _reason = "cancelled"): void {
	const pending = contState().pendingContinuation;
	if (pending && (!goalId || pending.goalId === goalId)) {
		clearTimeout(pending.timer);
		contState().pendingContinuation = undefined;
	}
	for (const [pendingGoalId, pending] of contState().budgetWrapUps) {
		if (!goalId || pendingGoalId === goalId) {
			clearTimeout(pending.timer);
			contState().budgetWrapUps.delete(pendingGoalId);
		}
	}
}

export function interruptActiveGoalTurn(pi: ExtensionAPI, ctx: ExtensionContext, goal: GoalState): void {
	if (ctx.isIdle()) return;
	const prompt = buildPausePrompt(goal);
	pi.sendMessage(
		{ customType: PAUSE_MESSAGE_TYPE, content: prompt.content, display: false, details: prompt.details },
		{ deliverAs: "steer" },
	);
	ctx.abort();
}

export function resetContinuationRuntime(): void {
	cancelGoalContinuation();
	cancelFallbackTimer();
	const state = contState();
	state.compactionActive = false;
	state.compactionWork = undefined;
	state.prequeuedCompactionKey = undefined;
	state.fallbackAttempts = 0;
	state.fallbackRetryDelaysMs = [...DEFAULT_RETRY_DELAYS_MS];
}

function attemptContinueGoal(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	reason: ContinuationReason,
	goalId: string,
	opts: { force?: boolean } = {},
): ContinuationAttemptResult {
	const goal = getGoal();
	if (!goal || goal.goalId !== goalId || goal.status !== "active") {
		logRuntime("attemptContinueGoal.skip.notActive", { reason, requestedGoalId: goalId });
		skip(pi, "notActive");
		if (isUserConfirmedContinuation(reason) && ctx.hasUI) {
			notifyWarning(ctx, "Could not start goal continuation: no active goal in this session.");
		}
		return { kind: "terminalSkip", reason: "notActive" };
	}
	if (contState().compactionActive) {
		contState().compactionWork = { kind: "activeGoal", goalId, key: activeGoalKey(goalId) };
		logRuntime("attemptContinueGoal.skip.compacting", workFields(contState().compactionWork));
		skip(pi, "compacting");
		return { kind: "terminalSkip", reason: "compacting" };
	}
	const telemetry = getTelemetry();
	if (telemetry && telemetry.consecutiveAutoTurns >= MAX_CONSECUTIVE_AUTO_TURNS) {
		skip(pi, "safetyCap");
		return { kind: "terminalSkip", reason: "safetyCap" };
	}
	if (telemetry && telemetry.consecutiveNoProgressTurns >= MAX_NO_PROGRESS_AUTO_TURNS) {
		skip(pi, "safetyCap");
		return { kind: "terminalSkip", reason: "safetyCap" };
	}

	// Busy session: queue followUp instead of dropping. process/subagent wakes often
	// start a run between agent_end and settle-time continue; skip(notIdle) permanently
	// killed auto-continue once that wake chain ended.
	const triggerTurn = opts.force || ctx.isIdle();
	logRuntime("attemptContinueGoal.send", {
		reason,
		goalId: goal.goalId,
		force: opts.force,
		triggerTurn,
		idle: ctx.isIdle(),
	});
	sendContinuationMessage(pi, goal, telemetry, reason, triggerTurn);
	return { kind: "sent" };
}

function isUserConfirmedContinuation(reason: ContinuationReason): boolean {
	return reason === "created" || reason === "resumed";
}

export function openApiGate(pi: ExtensionAPI): void {
	if (!isApiGateBlocked(getTelemetry())) return;
	const telemetry = noteApiGate(getTelemetry(), "open");
	if (telemetry) persistTelemetry(pi, telemetry, "continuation");
}

async function maybeSendBudgetWrapUp(pi: ExtensionAPI, ctx: ExtensionContext, goalId: string): Promise<void> {
	const goal = getGoal();
	if (!goal || goal.goalId !== goalId || goal.status !== "budgetLimited") return;
	if (!ctx.isIdle()) return;
	if (ctx.hasPendingMessages()) return;
	const prompt = buildBudgetLimitPrompt(goal);
	setNextTurnOrigin("budgetWrapUp");
	pi.sendMessage(
		{ customType: BUDGET_LIMIT_MESSAGE_TYPE, content: prompt.content, display: false, details: prompt.details },
		{ triggerTurn: true, deliverAs: "followUp" },
	);
	const telemetry = noteBudgetWrapUpSent(getTelemetry());
	if (telemetry) persistTelemetry(pi, telemetry, "budget");
}

function currentCompactionWork(): CompactionContinuationWork | undefined {
	const goal = getGoal();
	const queueHead = getQueue()[0];
	logRuntime("currentCompactionWork.inspect", { queueHeadId: queueHead?.queueId });
	if (!goal) return undefined;
	if (goal.status === "active") return { kind: "activeGoal", goalId: goal.goalId, key: activeGoalKey(goal.goalId) };
	if (goal.status === "complete" && queueHead) return { kind: "queueHandoff", goalId: goal.goalId, queueId: queueHead.queueId, key: queueKey(queueHead.queueId) };
	return undefined;
}

function prequeueCompactionWork(pi: ExtensionAPI, work: CompactionContinuationWork): boolean {
	logRuntime("prequeueCompactionWork.start", workFields(work));
	if (work.kind === "activeGoal") {
		const goal = getGoal();
		if (!goal || goal.goalId !== work.goalId || goal.status !== "active") {
			logRuntime("prequeueCompactionWork.activeGoal.mismatch", workFields(work));
			return false;
		}
		sendContinuationMessage(pi, goal, getTelemetry(), "compacted", false);
		finishCompactionTelemetry(pi, "prequeue", work.key, 0, "sent");
		logRuntime("prequeueCompactionWork.activeGoal.sent", workFields(work));
		return true;
	}
	const ticket = decideCompactionQueueHandoffTicket(work, { triggerTurn: false, deliverAs: "followUp", force: true });
	const sent = ticket.kind === "queueHandoff" && dispatchContinuationTicket(pi, ticket);
	if (sent) finishCompactionTelemetry(pi, "prequeue", work.key, 0, "sent");
	logRuntime("prequeueCompactionWork.queueHandoff.end", { ...workFields(work), sent });
	return sent;
}

function scheduleCompactionFallbackRetry(pi: ExtensionAPI, ctx: ExtensionContext, work: CompactionContinuationWork): void {
	cancelFallbackTimer();
	const delay = contState().fallbackRetryDelaysMs[Math.min(contState().fallbackAttempts, contState().fallbackRetryDelaysMs.length - 1)];
	contState().fallbackTimer = scheduleInSession(delay ?? 0, () => {
		contState().fallbackTimer = undefined;
		void safelyRun(async () => runCompactionFallbackAttempt(pi, ctx, work));
	});
}

async function runCompactionFallbackAttempt(pi: ExtensionAPI, ctx: ExtensionContext, work: CompactionContinuationWork): Promise<void> {
	if (!compactionWorkStillApplies(work)) return finishAndClear(pi, work.key, "workChanged");
	contState().fallbackAttempts++;
	finishCompactionTelemetry(pi, "fallbackRetry", work.key, contState().fallbackAttempts);
	const result = work.kind === "activeGoal" ? attemptContinueGoal(pi, ctx, "compacted", work.goalId) : attemptQueueHandoff(pi, ctx, work);
	logRuntime("runCompactionFallbackAttempt.result", {
		...workFields(work),
		resultKind: result.kind,
		resultReason: result.kind === "sent" ? undefined : result.reason,
		fallbackAttempts: contState().fallbackAttempts,
	});
	if (result.kind === "sent") return finishAndClear(pi, work.key, "sent");
	if (result.kind === "transientSkip" && contState().fallbackAttempts < contState().fallbackRetryDelaysMs.length) {
		scheduleCompactionFallbackRetry(pi, ctx, work);
		return;
	}
	const reason = result.kind === "transientSkip" ? "retryExhausted" : result.reason;
	finishAndClear(pi, work.key, reason);
}

function attemptQueueHandoff(pi: ExtensionAPI, ctx: ExtensionContext, work: Extract<CompactionContinuationWork, { kind: "queueHandoff" }>): ContinuationAttemptResult {
	if (!ctx.isIdle()) return { kind: "transientSkip", reason: "notIdle" };
	if (ctx.hasPendingMessages()) return { kind: "transientSkip", reason: "pendingMessages" };
	const ticket = decideCompactionQueueHandoffTicket(work, { force: true });
	if (ticket.kind !== "queueHandoff") return { kind: "terminalSkip", reason: ticket.reason === "queue_empty" ? "queueMissing" : "notActive" };
	const validation = revalidateContinuationTicket(ticket, getGoal(), getQueue());
	if (!validation.ok) return { kind: "terminalSkip", reason: validation.reason === "queue_head_changed" ? "queueChanged" : "notActive" };
	const sent = dispatchContinuationTicket(pi, ticket);
	logRuntime("attemptQueueHandoff.sendResult", { ...workFields(work), sent });
	return sent ? { kind: "sent" } : { kind: "terminalSkip", reason: "queueChanged" };
}

function compactionWorkStillApplies(work: CompactionContinuationWork): boolean {
	const goal = getGoal();
	if (work.kind === "activeGoal") return Boolean(goal && goal.goalId === work.goalId && goal.status === "active");
	const queueHead = getQueue()[0];
	return Boolean(goal && goal.goalId === work.goalId && goal.status === "complete" && queueHead?.queueId === work.queueId);
}

function decideCompactionQueueHandoffTicket(work: Extract<CompactionContinuationWork, { kind: "queueHandoff" }>, opts: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp"; force?: boolean }) {
	const ticket = decideTerminalContinuationTicket(getGoal(), getQueue(), opts);
	if (ticket.kind !== "queueHandoff") return ticket;
	if (ticket.goalId !== work.goalId || ticket.queueId !== work.queueId) return { kind: "none" as const, reason: "compaction_work_changed" };
	return ticket;
}

function sendContinuationMessage(
	pi: ExtensionAPI,
	goal: GoalState,
	telemetry: ReturnType<typeof getTelemetry>,
	reason: ContinuationReason,
	triggerTurn: boolean,
): void {
	const prompt = buildContinuationPrompt(goal, telemetry);
	logRuntime("sendContinuationMessage", { reason, goalId: goal.goalId, triggerTurn, deliverAs: "followUp" });
	setNextTurnOrigin("auto");
	pi.sendMessage(
		{ customType: CONTINUATION_MESSAGE_TYPE, content: prompt.content, display: false, details: { ...prompt.details, reason } },
		{ triggerTurn, deliverAs: "followUp" },
	);
}

function workFields(work: CompactionContinuationWork | undefined): Record<string, string | number | boolean | undefined> {
	const state = contState();
	return {
		compactionWorkKind: work?.kind,
		compactionWorkGoalId: work?.goalId,
		compactionWorkQueueId: work?.kind === "queueHandoff" ? work.queueId : undefined,
		compactionWorkKey: work?.key,
		compactionActive: state.compactionActive,
		prequeuedCompactionKey: state.prequeuedCompactionKey,
		fallbackAttempts: state.fallbackAttempts,
		pendingContinuationGoalId: state.pendingContinuation?.goalId,
		pendingContinuationReason: state.pendingContinuation?.reason,
		hasFallbackTimer: Boolean(state.fallbackTimer),
	};
}

function logRuntime(event: string, fields: Record<string, string | number | boolean | undefined> = {}): void {
}

function activeGoalKey(goalId: string): string {
	return `active:${goalId}`;
}

function queueKey(queueId: string): string {
	return `queue:${queueId}`;
}

function finishAndClear(pi: ExtensionAPI, key: string, reason: string): void {
	logRuntime("finishAndClear", { key, reason, fallbackAttempts: contState().fallbackAttempts });
	finishCompactionTelemetry(pi, "fallbackFinished", key, contState().fallbackAttempts, reason);
	clearCompactionRuntime();
}

function finishCompactionTelemetry(pi: ExtensionAPI, action: "prequeue" | "fallbackRetry" | "fallbackFinished", key: string, attempts: number, finalReason?: string): void {
	logRuntime("finishCompactionTelemetry", { action, key, attempts, finalReason });
	const telemetry = noteCompactionContinuation(getTelemetry(), action, { key, attempts, finalReason });
	if (telemetry) persistTelemetry(pi, telemetry, "continuation");
}

function clearCompactionRuntime(opts: { keepPrequeueKey?: boolean } = {}): void {
	logRuntime("clearCompactionRuntime", { keepPrequeueKey: opts.keepPrequeueKey });
	cancelFallbackTimer();
	contState().compactionWork = undefined;
	if (!opts.keepPrequeueKey) contState().prequeuedCompactionKey = undefined;
	contState().fallbackAttempts = 0;
}

function cancelFallbackTimer(): void {
	if (!contState().fallbackTimer) return;
	clearTimeout(contState().fallbackTimer);
	contState().fallbackTimer = undefined;
}

function shouldSuppressAgentEndContinuation(reason: ContinuationReason): boolean {
	if (reason !== "agentEnd") return false;
	const telemetry = getTelemetry();
	const noProgressAutoTurn = telemetry?.lastTurnOrigin === "auto" && telemetry.lastTurnToolCallCount === 0 && telemetry.lastTurnToolResultCount === 0 && !telemetry.lastTurnCompletedGoal;
	if (!noProgressAutoTurn) return false;
	const goal = getGoal();
	if (goal?.status !== "active") return true;
	const floor = evaluateCompletionFloor(goal);
	if (floor.anyFloorConfigured && !floor.allFloorsMet && !isBudgetExhausted(goal) && telemetry.floorQualityState !== "exhausted") return false;
	return true;
}

function skip(pi: ExtensionAPI, reason: ContinuationSkipReason): void {
	const telemetry = noteContinuationSkipped(getTelemetry(), reason);
	if (telemetry) persistTelemetry(pi, telemetry, "continuation");
}

async function safelyRun(task: () => Promise<void>): Promise<void> {
	try {
		await task();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!message.includes("ctx is stale")) console.warn(`[mpi-goal] continuation failed: ${message}`);
	}
}
