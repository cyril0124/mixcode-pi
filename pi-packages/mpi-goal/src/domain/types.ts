import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";
export type ContextResetMode = "clear" | "summarize";
export type PostCompletionActionSpec = { type: "context.reset"; mode: ContextResetMode };
export type PostCompletionActionStatus = "pending" | "running" | "done" | "failed" | "skipped";
export type PostCompletionActionState = PostCompletionActionSpec & {
  id: string;
  status: PostCompletionActionStatus;
  anchorEntryId?: string;
  failure?: string;
  skippedReason?: string;
  completedAt?: number;
  updatedAt?: number;
};

export type GoalState = {
  goalId: string;
  objective: string;
  status: GoalStatus;
  tokenBudget?: number;
  timeBudgetSeconds?: number;
  minTokensBeforeWrapUp?: number;
  minTimeSecondsBeforeWrapUp?: number;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
  sourceQueueId?: string;
  postCompletionActions?: PostCompletionActionState[];
};

export type TurnOrigin = "user" | "auto" | "budgetWrapUp";
export type ContinuationReason = "created" | "resumed" | "agentEnd" | "compacted";
export type ContinuationSkipReason =
  | "notIdle"
  | "pendingMessages"
  | "notActive"
  | "safetyCap"
  | "noProgress"
  | "compacting"
  | "apiError";
export type ApiGateState = "open" | "blocked";
export type SafetyPauseReason = "maxAutoTurns" | "noProgress" | "abort" | "apiError";
export type BudgetLimitReason = "tokenBudget" | "timeBudget";
export type BudgetWarningReason = "tokenWarning" | "timeWarning";
export type BudgetHardStopReason = "tokenHardStop" | "timeHardStop";
export type BudgetPressureKind =
  | "none"
  | BudgetWarningReason
  | "tokenReached"
  | "timeReached"
  | BudgetHardStopReason;
export type BudgetPressure = { kind: BudgetPressureKind; remaining?: number };

export type FloorValuePassId =
  | "requirement_gap_audit"
  | "adversarial_review"
  | "alternate_perspective"
  | "research_expansion"
  | "validation_expansion"
  | "simplification_deslop"
  | "compatibility_review"
  | "docs_handoff_evidence";

export type NoMoreValuableWorkReason = "no_safe_autonomous_work" | "max_budget_requires_wrap_up";

export type GoalTelemetrySnapshot = {
  version: 1;
  goalId: string;
  consecutiveAutoTurns: number;
  consecutiveNoProgressTurns: number;
  lastTurnOrigin?: TurnOrigin;
  lastSkipReason?: ContinuationSkipReason;
  /** When blocked, agentEnd auto-continue is suppressed until user resume or a successful stop. */
  apiGate?: ApiGateState;
  lastTurnToolCallCount?: number;
  lastTurnToolResultCount?: number;
  lastTurnCompletedGoal?: boolean;
  lastSafetyPauseReason?: SafetyPauseReason;
  lastBudgetHardStopReason?: BudgetHardStopReason;
  tokenBudgetWarningSent?: boolean;
  timeBudgetWarningSent?: boolean;
  lastFloorCardId?: FloorValuePassId;
  floorSteerCount?: number;
  noMoreValuableWorkReason?: NoMoreValuableWorkReason;
  updatedAt: number;
};

export type PiGoalEventKind = "set" | "update" | "account" | "telemetry" | "clear";
export type PiGoalEventReason =
  | "command"
  | "tool"
  | "turn"
  | "budget"
  | "abort"
  | "resume"
  | "continuation"
  | "safety"
  | "floor"
  | "compact";

export type PiGoalStateEvent = {
  version: 1;
  kind: PiGoalEventKind;
  goalId?: string;
  goal: GoalState | null;
  telemetry?: GoalTelemetrySnapshot | null;
  delta?: { timeUsedSeconds?: number; tokensUsed?: number };
  reason: PiGoalEventReason;
  at: number;
};

export type GoalRuntimeState = {
  goal: GoalState | null;
  telemetry: GoalTelemetrySnapshot | null;
};

export type TurnAccountingSnapshot = {
  goalId: string;
  startedAt: number;
  origin: TurnOrigin;
  toolCallCount: number;
  toolResultCount: number;
  progressCount: number;
  completedGoal: boolean;
};

export type GoalSteeringKind = "continuation" | "budgetLimit" | "pause";

export type GoalSteeringDetails = {
  goalId: string;
  kind: GoalSteeringKind;
  promptId: string;
  createdAt: number;
  reason?: ContinuationReason | "budget" | "pause";
};

export type StreamBudgetSignal = "hardStop" | "reached" | "warning";

export type GoalCommandScheduler = (ctx: ExtensionContext, reason: ContinuationReason) => void;
export type GoalContinuationCanceller = (goalId?: string) => void;
export type GoalPauseInterrupter = (ctx: ExtensionContext, goal: GoalState) => void;
export type GoalQueueSteeringReason =
  | "goal-complete"
  | "goal-clear"
  | "goal-resume"
  | "goal-budget-limited";
export type GoalQueueSteeringSender = (
  reason: GoalQueueSteeringReason,
  opts?: {
    triggerTurn?: boolean;
    goalId?: string;
    deliverAs?: "steer" | "followUp";
    force?: boolean;
  },
) => boolean;

export type MutationResult = {
  ok: boolean;
  goal: GoalState | null;
  telemetry: GoalTelemetrySnapshot | null;
};
