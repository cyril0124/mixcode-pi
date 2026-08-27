import type {
  ContextEvent,
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
  TurnEndEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

// Not re-exported from package root; keep local shapes for the fields we read.
type MessageUpdateEvent = {
  message: {
    role?: string;
    usage?: { totalTokens?: number };
  };
};
type ContextEventResult = {
  messages: ContextEvent["messages"];
};
import {
  BUDGET_LIMIT_MESSAGE_TYPE,
  BUDGET_WARNING_PROMPT_ID,
  CONTINUATION_MESSAGE_TYPE,
  MAX_CONSECUTIVE_AUTO_TURNS,
  MAX_NO_PROGRESS_AUTO_TURNS,
  PAUSE_MESSAGE_TYPE,
  QUEUE_MESSAGE_TYPE,
  AGENT_END_HANDOFF_DELAY_MS,
} from "../domain/constants.js";
import {
  currentGoalSessionKey,
  runInGoalSession,
  withGoalSessionFromCtx,
} from "../domain/session-scope.js";
import {
  beginActiveTime,
  discardActiveTime,
  isActiveTimeRunning,
  liveActiveExtraSeconds,
  stopActiveTime,
  takeActiveElapsedSeconds,
  withLiveActiveTime,
} from "../domain/active-time.js";
import {
  evaluateBudgetPressure,
  isBudgetHardStop,
  isBudgetReached,
  isBudgetWarning,
  queueHandoffReason,
} from "../domain/budget.js";
import {
  beginGoalCompaction,
  cancelGoalContinuation,
  failGoalCompaction,
  finishGoalCompaction,
  interruptActiveGoalTurn,
  openApiGate,
  scheduleBudgetLimitWrapUp,
  scheduleMaybeContinueGoal,
} from "./continuation.js";
import { buildBudgetLimitPrompt } from "./prompts.js";
import {
  ensureGoalHydrated,
  getGoal,
  getTelemetry,
  persistAccountGoal,
  persistTelemetry,
  persistUpdateGoal,
  replayGoalState,
} from "../persistence/goal-store.js";
import { getQueue, replayQueueState } from "../persistence/queue-store.js";
import { queueSteeringStillValid, sendQueueHandoff } from "../queue/steering.js";
import {
  createNoopPostCompletionActionRunner,
  type PostCompletionActionRunner,
} from "./post-completion.js";
import { processTerminalGoalWorkflow } from "./terminal-workflow.js";
import {
  applyTurnTelemetry,
  consumeNextTurnOrigin,
  isApiGateBlocked,
  makeTurnSnapshot,
  noteApiGate,
  noteBudgetHardStop,
  noteBudgetLimit,
  noteBudgetWarning,
  noteContinuationSkipped,
  noteSafetyPause,
} from "../domain/telemetry.js";
import {
  notifyWarning,
  promptContinueActiveGoal,
  promptResumePausedGoal,
  syncGoalUi,
} from "../surface/ui/notify.js";
import type {
  BudgetHardStopReason,
  BudgetPressure,
  GoalState,
  GoalTelemetrySnapshot,
  PiGoalEventReason,
  SafetyPauseReason,
  StreamBudgetSignal,
  TurnAccountingSnapshot,
} from "../domain/types.js";

type AgentEndContinueArm =
  | { kind: "idle" }
  | { kind: "await-settle"; goalId: string; timer?: ReturnType<typeof setTimeout> }
  | { kind: "dispatched" };

type LifecycleSessionState = {
  activeTurn: TurnAccountingSnapshot | null;
  streamBudgetSignalsSent: Set<StreamBudgetSignal>;
  agentEndContinue: AgentEndContinueArm;
  /** Final assistant stopReason from the last agent_end (after Pi retries finished). */
  lastAgentEndStopReason?: string;
};

const lifecycleBySession = new Map<string, LifecycleSessionState>();

function lifecycleState(): LifecycleSessionState {
  const key = currentGoalSessionKey();
  let state = lifecycleBySession.get(key);
  if (!state) {
    state = {
      activeTurn: null,
      streamBudgetSignalsSent: new Set(),
      agentEndContinue: { kind: "idle" },
      lastAgentEndStopReason: undefined,
    };
    lifecycleBySession.set(key, state);
  }
  return state;
}

const AGENT_SETTLED_CONTINUE_FALLBACK_MS = 500;

/** Persist whole active seconds if any; O(1). Returns seconds written. */
export function flushGoalActiveTime(pi: ExtensionAPI, reason: PiGoalEventReason = "turn"): number {
  const goal = getGoal();
  if (!goal || (goal.status !== "active" && goal.status !== "budgetLimited")) {
    return 0;
  }
  const elapsed = takeActiveElapsedSeconds();
  if (elapsed <= 0) return 0;
  persistAccountGoal(pi, goal.goalId, { timeUsedSeconds: elapsed }, getTelemetry(), reason);
  return elapsed;
}

/** Flush then stop the active-time clock (pause/clear/end of turn idle). */
export function flushAndStopGoalActiveTime(
  pi: ExtensionAPI,
  reason: PiGoalEventReason = "turn",
): void {
  flushGoalActiveTime(pi, reason);
  stopActiveTime();
}

export type GoalLifecycleOptions = {
  /** Invoked after goal/queue state is restored from the session branch. */
  onStateRestored?: () => void;
};

export function registerGoalLifecycle(
  pi: ExtensionAPI,
  postCompletionRunner: PostCompletionActionRunner = createNoopPostCompletionActionRunner(
    "post-completion runner unavailable",
  ),
  options: GoalLifecycleOptions = {},
): void {
  const onStateRestored = options.onStateRestored;
  pi.on("session_start", async (event, ctx) => {
    await withGoalSessionFromCtx(ctx, async () => {
      await handleSessionStart(pi, event, ctx);
      onStateRestored?.();
    });
  });
  pi.on("session_tree", async (_event, ctx) => {
    await withGoalSessionFromCtx(ctx, async () => {
      const state = replayGoalState(ctx);
      replayQueueState(ctx);
      syncGoalUi(ctx, state.goal);
      onStateRestored?.();
    });
  });
  pi.on("session_before_compact", (_event, ctx) => {
    withGoalSessionFromCtx(ctx, () => {
      flushGoalActiveTime(pi, "compact");
      beginGoalCompaction(pi, ctx);
    });
  });
  pi.on("session_compact_failed", (_event, ctx) => {
    withGoalSessionFromCtx(ctx, failGoalCompaction);
  });
  pi.on("session_compact", async (_event, ctx) => {
    await withGoalSessionFromCtx(ctx, async () => {
      handleSessionCompact(pi, ctx);
      onStateRestored?.();
    });
  });
  pi.on("turn_start", (event, ctx) => {
    withGoalSessionFromCtx(ctx, () => {
      handleTurnStart(pi, event, ctx);
      lifecycleState().streamBudgetSignalsSent.clear();
    });
  });
  pi.on("tool_call", (event, ctx) => {
    withGoalSessionFromCtx(ctx, () => handleToolCall(event));
  });
  pi.on("tool_result", (event, ctx) => {
    withGoalSessionFromCtx(ctx, () => handleToolResult(pi, event));
  });
  pi.on("turn_end", async (event, ctx) => {
    await withGoalSessionFromCtx(ctx, async () =>
      handleTurnEnd(pi, event, ctx, postCompletionRunner),
    );
  });
  // agent_end fires while isIdle is still false (Pi keeps the run active until
  // post-run work finishes). Queue handoff can still arm on agent_end; auto-continue
  // must wait for agent_settled so attemptContinueGoal does not silent-skip notIdle.
  pi.on("agent_end", async (event, ctx) => {
    await withGoalSessionFromCtx(ctx, async () =>
      handleAgentEnd(pi, event, ctx, postCompletionRunner),
    );
  });
  pi.on("agent_settled", async (_event, ctx) => {
    await withGoalSessionFromCtx(ctx, async () => handleAgentSettled(pi, ctx));
  });
  // Drop already-queued goal continuations after pause/clear: they still message_start
  // even when status is no longer active (Pi followUp queue is not cleared by extensions).
  pi.on("message_start", (event, ctx) => {
    withGoalSessionFromCtx(ctx, () => handleGoalSteeringMessageStart(event, ctx));
  });
  pi.on("message_update", (event, ctx) => {
    withGoalSessionFromCtx(ctx, () => handleMessageUpdate(pi, event, ctx));
  });
  pi.on("context", (event, ctx) => {
    return withGoalSessionFromCtx(ctx, () => filterGoalContext(event));
  });
}

async function handleSessionStart(
  pi: ExtensionAPI,
  event: SessionStartEvent,
  ctx: ExtensionContext,
): Promise<void> {
  const state = replayGoalState(ctx);
  replayQueueState(ctx);
  syncGoalUi(ctx, state.goal);
  // Reload is an in-process extension refresh; do not interrupt with prompts.
  if (event.reason === "reload" || !ctx.hasUI || !state.goal) return;

  if (state.goal.status === "paused") {
    const resume = await promptResumePausedGoal(ctx, state.goal);
    if (!resume) return;
    const active: GoalState = { ...state.goal, status: "active", updatedAt: Date.now() };
    persistUpdateGoal(pi, active, state.telemetry, "resume");
    syncGoalUi(ctx, active);
    scheduleMaybeContinueGoal(pi, ctx, "resumed");
    return;
  }

  // Active goals are not running after session restore until something kicks them.
  // Prompt instead of silent idle UI that looks like work is already underway.
  if (state.goal.status === "active") {
    const cont = await promptContinueActiveGoal(ctx, state.goal);
    if (cont) scheduleMaybeContinueGoal(pi, ctx, "resumed");
  }
}

function handleSessionCompact(pi: ExtensionAPI, ctx: ExtensionContext): void {
  const state = replayGoalState(ctx);
  replayQueueState(ctx);
  syncGoalUi(ctx, state.goal);
  finishGoalCompaction(pi, ctx);
}

async function handleAgentEnd(
  pi: ExtensionAPI,
  event: { messages?: unknown[] },
  ctx: ExtensionContext,
  postCompletionRunner: PostCompletionActionRunner,
): Promise<void> {
  // Close the active-time window between agent runs so idle wait is not billed.
  // Rehydrate first: mid-session memory loss left getGoal() null while branch still had active goal.
  ensureGoalHydrated(ctx);
  flushAndStopGoalActiveTime(pi, "turn");
  // Latest agent_end stopReason (may be intermediate if Pi still auto-retries).
  lifecycleState().lastAgentEndStopReason = lastAssistantStopReason(event?.messages);
  const goal = getGoal();
  const reason = queueHandoffReason(goal);
  const queueLength = getQueue().length;
  if (reason && goal && queueLength > 0) {
    setAgentEndContinue({ kind: "dispatched" });
    const sessionKey = currentGoalSessionKey();
    setTimeout(() => {
      void runInGoalSession(sessionKey, async () => {
        await processTerminalGoalWorkflow(pi, ctx, {
          goal,
          reason: "turn",
          runner: postCompletionRunner,
        });
      });
    }, AGENT_END_HANDOFF_DELAY_MS);
    return;
  }
  // Error agent_end can fire before Pi auto-retries. Do not arm the 500ms
  // fallback here — that would pause mid-retry. Wait for agent_settled only.
  if (lifecycleState().lastAgentEndStopReason === "error") {
    setAgentEndContinue(
      goal?.status === "active" ? { kind: "await-settle", goalId: goal.goalId } : { kind: "idle" },
    );
    return;
  }
  // Prefer agent_settled; keep a short fallback if settled is dropped by the host.
  armPendingAgentEndContinue(pi, ctx, goal);
}

async function handleAgentSettled(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
  clearAgentEndContinueTimer();
  dispatchAgentEndContinue(pi, ctx);
}

function armPendingAgentEndContinue(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: GoalState | null,
): void {
  if (goal?.status !== "active") {
    setAgentEndContinue({ kind: "idle" });
    return;
  }
  const goalId = goal.goalId;
  const sessionKey = currentGoalSessionKey();
  const timer = setTimeout(() => {
    runInGoalSession(sessionKey, () => {
      const arm = lifecycleState().agentEndContinue;
      if (arm.kind !== "await-settle" || arm.goalId !== goalId) return;
      lifecycleState().agentEndContinue = { kind: "await-settle", goalId };
      dispatchAgentEndContinue(pi, ctx);
    });
  }, AGENT_SETTLED_CONTINUE_FALLBACK_MS);
  setAgentEndContinue({ kind: "await-settle", goalId, timer });
}

function dispatchAgentEndContinue(pi: ExtensionAPI, ctx: ExtensionContext): void {
  if (lifecycleState().agentEndContinue.kind !== "await-settle") return;
  ensureGoalHydrated(ctx);
  const goal = getGoal();
  if (goal?.status !== "active") return;
  setAgentEndContinue({ kind: "dispatched" });
  // Upstream API exhausted retries: pause goal (not active+idle fake work).
  if (lifecycleState().lastAgentEndStopReason === "error") {
    void pauseForSafety(
      pi,
      ctx,
      goal,
      "apiError",
      "Upstream API failed after retries. Goal paused. Run /goal resume when the API is available.",
    );
    return;
  }
  // Queue handoff for a completed/budget-limited goal is started from agent_end;
  // only active goals need the settle-time continuation nudge.
  scheduleMaybeContinueGoal(pi, ctx, "agentEnd");
}

function lastAssistantStopReason(messages: unknown[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (typeof message !== "object" || message === null) continue;
    const candidate = message as { role?: unknown; stopReason?: unknown };
    if (candidate.role !== "assistant") continue;
    return typeof candidate.stopReason === "string" ? candidate.stopReason : undefined;
  }
  return undefined;
}

function clearAgentEndContinueTimer(): void {
  const arm = lifecycleState().agentEndContinue;
  if (arm.kind !== "await-settle" || !arm.timer) return;
  clearTimeout(arm.timer);
  lifecycleState().agentEndContinue = { kind: "await-settle", goalId: arm.goalId };
}

function setAgentEndContinue(next: AgentEndContinueArm): void {
  const arm = lifecycleState().agentEndContinue;
  if (arm.kind === "await-settle" && arm.timer) clearTimeout(arm.timer);
  lifecycleState().agentEndContinue = next;
}

/** Cancel armed agent_end auto-continue (timers + settle dispatch). Call on pause/clear. */
export function cancelAgentEndContinueArm(): void {
  setAgentEndContinue({ kind: "dispatched" });
}

function handleGoalSteeringMessageStart(
  event: { message?: { role?: string; customType?: string } },
  ctx: ExtensionContext,
): void {
  const message = event.message;
  if (message?.role !== "custom") return;
  if (message.customType !== CONTINUATION_MESSAGE_TYPE) return;
  ensureGoalHydrated(ctx);
  const goal = getGoal();
  if (goal && goal.status === "active") return;
  // Stale continuation still in Pi's followUp queue after pause/complete/clear.
  ctx.abort();
}

function handleTurnStart(pi: ExtensionAPI, event: TurnStartEvent, ctx: ExtensionContext): void {
  ensureGoalHydrated(ctx);
  const goal = getGoal();
  if (!goal) {
    lifecycleState().activeTurn = null;
    discardActiveTime();
    return;
  }
  // Track turns for active and budget-limited goals so budget hard-stop detection
  // still works during the budget wrap-up turn. Paused and completed goals are
  // excluded because no agent work should be in progress for them.
  if (goal.status !== "active" && goal.status !== "budgetLimited") {
    lifecycleState().activeTurn = null;
    discardActiveTime();
    return;
  }
  // If a previous turn left the clock running (missing turn_end), bill residual first.
  if (isActiveTimeRunning()) flushGoalActiveTime(pi, "turn");
  const startedAt = event.timestamp || Date.now();
  lifecycleState().activeTurn = makeTurnSnapshot(goal.goalId, consumeNextTurnOrigin(), startedAt);
  beginActiveTime(startedAt);
}

function handleMessageUpdate(
  pi: ExtensionAPI,
  event: MessageUpdateEvent,
  ctx: ExtensionContext,
): void {
  if (event.message.role !== "assistant") return;

  const goal = getGoal();
  if (goal?.status !== "active") return;

  // Live estimate only — never persist on this hot path.
  const streamTokens = event.message.usage?.totalTokens ?? 0;
  const estimated: GoalState = {
    ...withLiveActiveTime(goal),
    tokensUsed: goal.tokensUsed + (streamTokens > 0 ? streamTokens : 0),
  };

  const pressure = evaluateBudgetPressure(estimated);

  if (isBudgetHardStop(pressure.kind)) {
    // Skip if already handled by a prior stream event or turn_end.
    if (
      lifecycleState().streamBudgetSignalsSent.has("hardStop") ||
      getTelemetry()?.lastBudgetHardStopReason
    )
      return;
    lifecycleState().streamBudgetSignalsSent.add("hardStop");
    // Commit live time before status change so used matches the stop decision.
    flushGoalActiveTime(pi, "budget");
    const billed = getGoal() ?? goal;
    const stopped: GoalState = { ...billed, status: "budgetLimited", updatedAt: Date.now() };
    const nextTelemetry = noteBudgetHardStop(
      noteBudgetLimit(getTelemetry()),
      budgetHardStopReason(pressure),
    );
    persistUpdateGoal(pi, stopped, nextTelemetry, "budget");
    syncGoalUi(ctx, stopped);
    notifyWarning(
      ctx,
      `${budgetResourceText(pressure)} budget hard stop enforced. Goal work stopped.`,
    );
    const prompt = buildBudgetLimitPrompt(withLiveActiveTime(stopped));
    pi.sendMessage(
      {
        customType: BUDGET_LIMIT_MESSAGE_TYPE,
        content: prompt.content,
        display: false,
        details: prompt.details,
      },
      { deliverAs: "steer" },
    );
    sendQueueHandoff(pi, "goal-budget-limited", { goalId: goal.goalId });
    cancelGoalContinuation(goal.goalId);
    ctx.abort();
    return;
  }

  // Reached (100%): Send a steering message so the agent sees budget context
  // mid-stream. State transition to budgetLimited happens at turn_end, not here,
  // because the wrap-up turn needs to complete so the agent can summarize progress.
  if (isBudgetReached(pressure.kind)) {
    if (lifecycleState().streamBudgetSignalsSent.has("reached")) return;
    lifecycleState().streamBudgetSignalsSent.add("reached");
    const prompt = buildBudgetLimitPrompt(estimated);
    pi.sendMessage(
      {
        customType: BUDGET_LIMIT_MESSAGE_TYPE,
        content: prompt.content,
        display: false,
        details: prompt.details,
      },
      { deliverAs: "steer" },
    );
    return;
  }

  // Warning: Two dedup layers — (1) per-stream signal tracker prevents repeat
  // mid-turn, (2) telemetry flags prevent re-sending if turn_end already warned.
  if (isBudgetWarning(pressure.kind)) {
    if (lifecycleState().streamBudgetSignalsSent.has("warning")) return;
    const telemetry = getTelemetry();
    if (pressure.kind === "tokenWarning" && telemetry?.tokenBudgetWarningSent) return;
    if (pressure.kind === "timeWarning" && telemetry?.timeBudgetWarningSent) return;

    lifecycleState().streamBudgetSignalsSent.add("warning");
    const resource = pressure.kind.startsWith("time") ? "Time" : "Token";
    const remaining = Math.max(0, Math.floor(pressure.remaining ?? 0));
    const unit = pressure.kind.startsWith("time") ? "seconds" : "tokens";
    pi.sendMessage(
      {
        customType: BUDGET_LIMIT_MESSAGE_TYPE,
        content: `${resource} budget warning: ${remaining} ${unit} remaining before target. Start wrapping up.`,
        display: false,
        details: {
          goalId: goal.goalId,
          kind: "budgetLimit",
          promptId: BUDGET_WARNING_PROMPT_ID,
          createdAt: Date.now(),
        },
      },
      { deliverAs: "steer" },
    );
    return;
  }
}

function handleToolCall(_event: ToolCallEvent): void {
  const turn = lifecycleState().activeTurn;
  if (!turn) return;
  turn.toolCallCount++;
}

function handleToolResult(pi: ExtensionAPI, event: ToolResultEvent): void {
  const turn = lifecycleState().activeTurn;
  if (!turn) return;
  turn.toolResultCount++;
  // Mid-turn checkpoint: persist only whole seconds (avoids per-tool write storms).
  if (liveActiveExtraSeconds() >= 1) flushGoalActiveTime(pi, "turn");
  if (event.isError) return;
  if (event.toolName === "update_goal") {
    noteGoalUpdateResult(event.details);
    return;
  }
  turn.progressCount++;
}

function noteGoalUpdateResult(details: unknown): void {
  const turn = lifecycleState().activeTurn;
  if (!turn || hasToolError(details)) return;
  if (typeof details !== "object" || details === null) return;
  const result = details as Record<string, unknown>;
  const goal = result.goal;
  if (typeof goal === "object" && goal !== null) {
    turn.progressCount++;
    if ((goal as Record<string, unknown>).status === "complete") turn.completedGoal = true;
  }
}

function hasToolError(details: unknown): boolean {
  return typeof details === "object" && details !== null && "error" in details;
}

async function handleTurnEnd(
  pi: ExtensionAPI,
  event: TurnEndEvent,
  ctx: ExtensionContext,
  postCompletionRunner: PostCompletionActionRunner,
): Promise<void> {
  const turn = lifecycleState().activeTurn;
  lifecycleState().activeTurn = null;
  if (!turn) {
    // No tracked turn — still stop the clock so idle is not billed.
    flushAndStopGoalActiveTime(pi, "turn");
    return;
  }

  const goal = getGoal();
  if (!goal || goal.goalId !== turn.goalId) {
    // Stale/replaced goal: drop residual time for the abandoned turn identity.
    discardActiveTime();
    return;
  }
  // Residual active seconds since last mid-turn flush (not full turn span — avoids double count).
  const elapsed = takeActiveElapsedSeconds();
  stopActiveTime();
  const tokens = assistantTokens(event.message);
  const madeProgress = turn.completedGoal || turn.progressCount > 0;
  // Successful model stop re-opens API gate (upstream recovered without explicit resume).
  if (
    event.message.role === "assistant" &&
    event.message.stopReason === "stop" &&
    isApiGateBlocked(getTelemetry())
  ) {
    openApiGate(pi);
  }
  let telemetry = applyTurnTelemetry(getTelemetry(), turn, madeProgress);
  let result = persistAccountGoal(
    pi,
    turn.goalId,
    { timeUsedSeconds: elapsed, tokensUsed: tokens },
    telemetry,
    "turn",
  );
  let updated = result.goal;

  if (updated?.status === "active") {
    result = handleBudgetPressure(pi, ctx, updated, result.telemetry);
    updated = result.goal;
  }

  // Check for budget hard stop on budget-limited goals — the wrap-up turn or an
  // untracked turn may push usage past 110%, requiring an immediate abort.
  if (updated?.status === "budgetLimited") {
    const pressure = evaluateBudgetPressure(updated);
    if (isBudgetHardStop(pressure.kind)) {
      enforceBudgetHardStop(pi, ctx, updated, pressure, result.telemetry);
      return;
    }
  }

  if (
    updated?.status === "active" &&
    event.message.role === "assistant" &&
    event.message.stopReason === "aborted"
  ) {
    await pauseForSafety(
      pi,
      ctx,
      updated,
      "abort",
      "Goal paused because the assistant response was aborted. Run /goal resume to continue.",
    );
    return;
  }

  telemetry = result.telemetry;
  updated = result.goal;
  if (updated?.status === "active" && shouldPauseForSafety(telemetry) && telemetry) {
    const reason =
      telemetry.consecutiveAutoTurns >= MAX_CONSECUTIVE_AUTO_TURNS ? "maxAutoTurns" : "noProgress";
    await pauseForSafety(
      pi,
      ctx,
      updated,
      reason,
      "Goal paused by pi-goal safety limits. Run /goal resume to continue.",
    );
    return;
  }

  await finishTurnGoal(pi, ctx, updated, turn.completedGoal, postCompletionRunner);
}

async function finishTurnGoal(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: GoalState | null,
  completedThisTurn: boolean,
  postCompletionRunner: PostCompletionActionRunner,
): Promise<void> {
  syncGoalUi(ctx, goal);
  if (goal?.status === "complete" && completedThisTurn)
    await processTerminalGoalWorkflow(pi, ctx, {
      goal,
      reason: "turn",
      runner: postCompletionRunner,
    });
}

async function pauseForSafety(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: GoalState,
  reason: SafetyPauseReason,
  message: string,
): Promise<void> {
  cancelGoalContinuation(goal.goalId);
  cancelAgentEndContinueArm();
  flushAndStopGoalActiveTime(pi, reason === "abort" ? "abort" : "safety");
  const current = getGoal() ?? goal;
  if (current.status === "paused" && reason === "apiError" && current.goalId === goal.goalId) {
    // Already paused (e.g. double settle); still refresh API gate telemetry once.
    let telemetry = noteSafetyPause(getTelemetry(), reason);
    telemetry = noteApiGate(telemetry, "blocked");
    telemetry = noteContinuationSkipped(telemetry, "apiError");
    if (telemetry) persistTelemetry(pi, telemetry, "safety");
    return;
  }
  const paused: GoalState = { ...current, status: "paused", updatedAt: Date.now() };
  let telemetry = noteSafetyPause(getTelemetry(), reason);
  if (reason === "apiError") {
    telemetry = noteApiGate(telemetry, "blocked");
    telemetry = noteContinuationSkipped(telemetry, "apiError");
  }
  persistUpdateGoal(pi, paused, telemetry, reason === "abort" ? "abort" : "safety");
  syncGoalUi(ctx, paused);
  notifyWarning(ctx, message);
}

function shouldPauseForSafety(telemetry: GoalTelemetrySnapshot | null): boolean {
  if (!telemetry) return false;
  return (
    telemetry.consecutiveAutoTurns >= MAX_CONSECUTIVE_AUTO_TURNS ||
    telemetry.consecutiveNoProgressTurns >= MAX_NO_PROGRESS_AUTO_TURNS
  );
}

function handleBudgetPressure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: GoalState,
  telemetry: GoalTelemetrySnapshot | null,
) {
  const pressure = evaluateBudgetPressure(goal);
  if (isBudgetHardStop(pressure.kind))
    return enforceBudgetHardStop(pi, ctx, goal, pressure, telemetry);
  if (isBudgetReached(pressure.kind)) return markBudgetReached(pi, ctx, goal, telemetry);
  if (isBudgetWarning(pressure.kind)) warnBudgetPressure(pi, ctx, pressure, telemetry);
  return { ok: true, goal, telemetry };
}

function enforceBudgetHardStop(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: GoalState,
  pressure: BudgetPressure,
  telemetry: GoalTelemetrySnapshot | null,
) {
  // If hard stop was already enforced by a mid-stream message_update handler,
  // skip re-persisting and re-notifying. The stream handler already transitioned
  // the goal to budgetLimited, persisted telemetry, and aborted.
  if (telemetry?.lastBudgetHardStopReason) {
    interruptActiveGoalTurn(pi, ctx, goal);
    return { ok: true, goal, telemetry };
  }
  cancelGoalContinuation(goal.goalId);
  const stopped: GoalState = { ...goal, status: "budgetLimited", updatedAt: Date.now() };
  const nextTelemetry = noteBudgetHardStop(
    noteBudgetLimit(telemetry),
    budgetHardStopReason(pressure),
  );
  const result = persistUpdateGoal(pi, stopped, nextTelemetry, "budget");
  syncGoalUi(ctx, result.goal);
  notifyWarning(
    ctx,
    `${budgetResourceText(pressure)} budget hard stop enforced. Goal work stopped.`,
  );
  if (result.goal) {
    sendQueueHandoff(pi, "goal-budget-limited", { goalId: result.goal.goalId });
    interruptActiveGoalTurn(pi, ctx, result.goal);
  }
  return result;
}

function markBudgetReached(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  goal: GoalState,
  telemetry: GoalTelemetrySnapshot | null,
) {
  cancelGoalContinuation(goal.goalId);
  const limited: GoalState = { ...goal, status: "budgetLimited", updatedAt: Date.now() };
  const result = persistUpdateGoal(pi, limited, noteBudgetLimit(telemetry), "budget");
  if (result.goal) {
    const handedOff = sendQueueHandoff(pi, "goal-budget-limited", { goalId: result.goal.goalId });
    if (!handedOff) scheduleBudgetLimitWrapUp(pi, ctx, result.goal);
  }
  return result;
}

function warnBudgetPressure(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  pressure: BudgetPressure,
  telemetry: GoalTelemetrySnapshot | null,
): void {
  if (warningAlreadySent(pressure, telemetry)) return;
  const nextTelemetry = noteBudgetWarning(
    telemetry,
    pressure.kind === "tokenWarning" ? "tokenWarning" : "timeWarning",
  );
  if (nextTelemetry) persistTelemetry(pi, nextTelemetry, "budget");
  notifyWarning(
    ctx,
    `${budgetResourceText(pressure)} budget warning: ${budgetRemainingText(pressure)} remaining before target. Start wrapping up.`,
  );
}

function warningAlreadySent(
  pressure: BudgetPressure,
  telemetry: GoalTelemetrySnapshot | null,
): boolean {
  if (pressure.kind === "tokenWarning") return Boolean(telemetry?.tokenBudgetWarningSent);
  if (pressure.kind === "timeWarning") return Boolean(telemetry?.timeBudgetWarningSent);
  return true;
}

function budgetHardStopReason(pressure: BudgetPressure): BudgetHardStopReason {
  return pressure.kind === "timeHardStop" ? "timeHardStop" : "tokenHardStop";
}

function budgetResourceText(pressure: BudgetPressure): "Token" | "Time" {
  return pressure.kind.startsWith("time") ? "Time" : "Token";
}

function budgetRemainingText(pressure: BudgetPressure): string {
  const remaining = Math.max(0, Math.floor(pressure.remaining ?? 0));
  return pressure.kind.startsWith("time") ? `${remaining} seconds` : `${remaining} tokens`;
}

function assistantTokens(message: TurnEndEvent["message"]): number {
  if (message.role !== "assistant") return 0;
  return Math.max(0, Math.floor(message.usage?.totalTokens ?? 0));
}

function filterGoalContext(event: ContextEvent): ContextEventResult | undefined {
  // Keep only the latest status-compatible pi-goal steering message to prevent stale continuations.
  let latestValidIndex = -1;
  let sawGoalSteering = false;
  for (let i = 0; i < event.messages.length; i++) {
    const classification = classifyGoalSteeringMessage(event.messages[i]);
    if (classification === "invalid") sawGoalSteering = true;
    if (classification === "valid") {
      sawGoalSteering = true;
      latestValidIndex = i;
    }
  }
  if (!sawGoalSteering) return undefined;
  return {
    messages: event.messages.filter((message, index) => {
      const classification = classifyGoalSteeringMessage(message);
      if (classification === "none") return true;
      return classification === "valid" && index === latestValidIndex;
    }),
  };
}

function classifyGoalSteeringMessage(message: unknown): "none" | "valid" | "invalid" {
  if (typeof message !== "object" || message === null) return "none";
  const candidate = message as Record<string, unknown>;
  if (!isGoalSteeringCustomType(candidate.customType)) return "none";
  return candidate.customType === QUEUE_MESSAGE_TYPE
    ? classifyQueueSteering(candidate)
    : classifyStatusGoalSteering(candidate);
}

function classifyQueueSteering(message: Record<string, unknown>): "valid" | "invalid" {
  return queueSteeringStillValid(message) ? "valid" : "invalid";
}

function classifyStatusGoalSteering(message: Record<string, unknown>): "valid" | "invalid" {
  const details =
    typeof message.details === "object" && message.details !== null
      ? (message.details as Record<string, unknown>)
      : null;
  const current = getGoal();
  if (!current || details?.goalId !== current.goalId) return "invalid";
  return goalSteeringMatchesStatus(String(message.customType), details?.kind, current.status)
    ? "valid"
    : "invalid";
}

function isGoalSteeringCustomType(customType: unknown): customType is string {
  return [
    CONTINUATION_MESSAGE_TYPE,
    BUDGET_LIMIT_MESSAGE_TYPE,
    PAUSE_MESSAGE_TYPE,
    QUEUE_MESSAGE_TYPE,
  ].includes(String(customType));
}

function goalSteeringMatchesStatus(
  customType: string,
  kind: unknown,
  status: GoalState["status"],
): boolean {
  if (customType === CONTINUATION_MESSAGE_TYPE)
    return status === "active" && kind === "continuation";
  if (customType === BUDGET_LIMIT_MESSAGE_TYPE)
    return status === "budgetLimited" && kind === "budgetLimit";
  return status === "paused" && kind === "pause";
}
