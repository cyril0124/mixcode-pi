import assert from "node:assert/strict";
import test from "node:test";
import type { GoalState } from "./src/domain/types.js";
import { renderGoalWidget } from "./src/surface/ui/widget.js";

const theme = {
  fg(_color: string, text: string) {
    return text;
  },
  bold(text: string) {
    return text;
  },
};

function sampleGoal(overrides: Partial<GoalState> = {}): GoalState {
  return {
    goalId: "g1",
    objective: "Ship mpi-goal DynamicBorder widget chrome",
    status: "active",
    tokensUsed: 12_000,
    timeUsedSeconds: 90,
    tokenBudget: 100_000,
    timeBudgetSeconds: 600,
    minTimeSecondsBeforeWrapUp: 60,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

test("widget uses DynamicBorder-style chrome (no box-drawing sides)", () => {
  const lines = renderGoalWidget(sampleGoal(), theme, 72);
  const text = lines.join("\n");
  assert.ok(lines.length >= 4, "border + body + border");
  assert.match(text, /mpi-goal/);
  assert.match(text, /active/);
  assert.match(text, /Ship mpi-goal DynamicBorder/);
  assert.match(text, /Active/);
  assert.match(text, /Tokens/);
  assert.match(text, /floor/);
  assert.match(text, /\/goal/);
  // Old full box chrome must be gone.
  assert.doesNotMatch(text, /[╭╰│]/);
});

test("same layout path for narrow and wide widths", () => {
  const goal = sampleGoal();
  const wide = renderGoalWidget(goal, theme, 72).join("\n");
  const narrow = renderGoalWidget(goal, theme, 24).join("\n");
  assert.match(wide, /mpi-goal/);
  assert.match(narrow, /mpi-goal/);
  assert.doesNotMatch(wide, /[╭╰│]/);
  assert.doesNotMatch(narrow, /[╭╰│]/);
});

test("status badge reflects paused", () => {
  const text = renderGoalWidget(sampleGoal({ status: "paused" }), theme, 60).join("\n");
  assert.match(text, /paused/);
  assert.match(text, /mpi-goal/);
});
