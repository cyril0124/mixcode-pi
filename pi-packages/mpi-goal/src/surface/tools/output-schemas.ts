import { Type } from "typebox";

const goalStatusSchema = Type.Union([
  Type.Literal("active"),
  Type.Literal("paused"),
  Type.Literal("budgetLimited"),
  Type.Literal("complete"),
]);

const contextResetModeSchema = Type.Union([Type.Literal("clear"), Type.Literal("summarize")]);

const postCompletionActionSchema = Type.Object(
  {
    id: Type.String(),
    type: Type.Literal("context.reset"),
    mode: contextResetModeSchema,
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("done"),
      Type.Literal("failed"),
      Type.Literal("skipped"),
    ]),
  },
  { additionalProperties: true },
);

const goalStateSchema = Type.Object(
  {
    goalId: Type.String(),
    objective: Type.String(),
    status: goalStatusSchema,
    tokenBudget: Type.Optional(Type.Number()),
    timeBudgetSeconds: Type.Optional(Type.Number()),
    minTokensBeforeWrapUp: Type.Optional(Type.Number()),
    minTimeSecondsBeforeWrapUp: Type.Optional(Type.Number()),
    tokensUsed: Type.Number(),
    timeUsedSeconds: Type.Number(),
    createdAt: Type.Number(),
    updatedAt: Type.Number(),
    sourceQueueId: Type.Optional(Type.String()),
    postCompletionActions: Type.Optional(Type.Array(postCompletionActionSchema)),
  },
  { additionalProperties: true },
);

const telemetrySchema = Type.Object(
  {
    version: Type.Literal(1),
    goalId: Type.String(),
    consecutiveAutoTurns: Type.Number(),
    consecutiveNoProgressTurns: Type.Number(),
    updatedAt: Type.Number(),
  },
  { additionalProperties: true },
);

const nullableGoalSchema = Type.Union([goalStateSchema, Type.Null()]);
const nullableTelemetrySchema = Type.Union([telemetrySchema, Type.Null()]);

export const GetGoalOutputSchema = Type.Object(
  {
    goal: nullableGoalSchema,
    telemetry: Type.Optional(nullableTelemetrySchema),
    remaining_tokens: Type.Optional(Type.Number()),
    remaining_time_seconds: Type.Optional(Type.Number()),
    completion_budget_report: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const goalTemplateSchema = Type.Object({
  name: Type.String(),
  path: Type.String(),
  description: Type.Optional(Type.String()),
  aliases: Type.Array(Type.String()),
  allowCommands: Type.Boolean(),
  requiredPlaceholders: Type.Array(Type.String()),
  requiredFlags: Type.Array(Type.String()),
  requiresArgs: Type.Boolean(),
});

export const ListGoalTemplatesOutputSchema = Type.Object(
  {
    goal: nullableGoalSchema,
    telemetry: Type.Optional(nullableTelemetrySchema),
    templates: Type.Array(goalTemplateSchema),
  },
  { additionalProperties: true },
);

const queuedGoalSchema = Type.Object({
  queueId: Type.String(),
  objective: Type.String(),
  tokenBudget: Type.Optional(Type.Number()),
  timeBudgetSeconds: Type.Optional(Type.Number()),
  minTokensBeforeWrapUp: Type.Optional(Type.Number()),
  minTimeSecondsBeforeWrapUp: Type.Optional(Type.Number()),
  source: Type.Union([Type.Literal("command"), Type.Literal("tool")]),
  template: Type.Optional(Type.String()),
  templateFlags: Type.Optional(Type.Record(Type.String(), Type.String())),
  templateArgs: Type.Optional(Type.String()),
  postCompletionActions: Type.Optional(
    Type.Array(
      Type.Object({
        type: Type.Literal("context.reset"),
        mode: contextResetModeSchema,
      }),
    ),
  ),
  createdAt: Type.Number(),
});

export const ListGoalQueueOutputSchema = Type.Object(
  {
    goal: nullableGoalSchema,
    telemetry: Type.Optional(nullableTelemetrySchema),
    queue: Type.Array(queuedGoalSchema),
  },
  { additionalProperties: true },
);
