import { isBudgetExhausted } from "./budget.js";
import { evaluateCompletionFloor, type CompletionFloorEvaluation } from "./floor.js";
import {
  buildFloorCompletionRefusal,
  selectFloorWorkCard,
  type FloorWorkCard,
} from "./floor-steering.js";
import type { GoalState, GoalTelemetrySnapshot, NoMoreValuableWorkReason } from "./types.js";

export type CompletionDecision =
  | { kind: "allow" }
  | {
      kind: "defer_and_steer";
      floor: CompletionFloorEvaluation;
      card: FloorWorkCard;
      message: string;
    }
  | {
      kind: "allow_with_reason";
      reason: NoMoreValuableWorkReason | "max_budget_requires_wrap_up";
      floor: CompletionFloorEvaluation;
    };

export type GoalCompletionGateInput = {
  currentGoal: GoalState;
  candidateGoal: GoalState;
  telemetry: GoalTelemetrySnapshot | null;
};

export function decideGoalCompletion(input: GoalCompletionGateInput): CompletionDecision {
  if (input.candidateGoal.status !== "complete") return { kind: "allow" };
  const floor = evaluateCompletionFloor(input.currentGoal);
  if (!floor.anyFloorConfigured || floor.allFloorsMet) return { kind: "allow" };
  if (isBudgetExhausted(input.currentGoal)) {
    return { kind: "allow_with_reason", reason: "max_budget_requires_wrap_up", floor };
  }
  if (canAllowNoValuableWorkEscape(input.telemetry)) {
    return { kind: "allow_with_reason", reason: "no_safe_autonomous_work", floor };
  }
  const card = selectFloorWorkCard({ goal: input.currentGoal, telemetry: input.telemetry, floor });
  if (!card && hasPriorFloorWork(input.telemetry)) {
    return { kind: "allow_with_reason", reason: "no_safe_autonomous_work", floor };
  }
  const selected = card ?? selectFloorWorkCard({ goal: input.currentGoal, telemetry: null, floor });
  if (!selected) return { kind: "allow_with_reason", reason: "no_safe_autonomous_work", floor };
  return {
    kind: "defer_and_steer",
    floor,
    card: selected,
    message: buildFloorCompletionRefusal({
      goal: input.currentGoal,
      floor,
      card: selected,
    }),
  };
}

function canAllowNoValuableWorkEscape(telemetry: GoalTelemetrySnapshot | null): boolean {
  return Boolean(telemetry?.noMoreValuableWorkReason);
}

function hasPriorFloorWork(telemetry: GoalTelemetrySnapshot | null): boolean {
  return (telemetry?.floorSteerCount ?? 0) > 0;
}
