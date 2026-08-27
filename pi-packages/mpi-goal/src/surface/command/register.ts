import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PostCompletionActionSpec } from "../../domain/types.js";
import { GOAL_USAGE, GOAL_USAGE_HINT } from "../../domain/constants.js";
import { canActivateGoal, budgetLimitReason } from "../../domain/budget.js";
import { validateObjective } from "../../domain/format.js";
import { parseGoalTemplateInvocation } from "../../templates/discover.js";
import { buildDirectGoalIntent, buildTemplateGoalIntent } from "../../domain/goal-intent.js";
import {
  createPostCompletionActionStates,
  recordPostStartActionAnchors,
} from "../../runtime/post-completion.js";
import { captureContextResetCommandContext } from "../../runtime/context-reset.js";
import {
  goalSessionKeyFromManager,
  runInGoalSession,
  withGoalSessionFromCtx,
} from "../../domain/session-scope.js";
import { flushAndStopGoalActiveTime } from "../../runtime/lifecycle.js";
import { createTelemetry, resetSafetyCounters } from "../../domain/telemetry.js";
import {
  createGoalState,
  getGoal,
  getTelemetry,
  persistClearGoal,
  persistSetGoal,
  persistUpdateGoal,
  replayGoalState,
} from "../../persistence/goal-store.js";
import { parseQueueBlockItems, type QueueBlockItem } from "../../queue/block-parser.js";
import {
  getQueue,
  enqueueGoal,
  persistEnqueue,
  persistRemove,
  removeGoal,
  replayQueueState,
} from "../../persistence/queue-store.js";
import {
  notifyGoal,
  notifyInfo,
  notifyWarning,
  showGoalSummary,
  showNoGoal,
  syncGoalUi,
} from "../ui/notify.js";
import { GoalManagementView } from "../ui/goal-overlay.js";
import { enableGoalTools, isGoalToolsActive } from "../tools/dynamic.js";
import { GOAL_TOOL_NAMES } from "../tools/names.js";
import type {
  GoalCommandScheduler,
  GoalContinuationCanceller,
  GoalPauseInterrupter,
  GoalQueueSteeringSender,
  GoalState,
} from "../../domain/types.js";

export type GoalCommandRuntime = {
  scheduleContinuation: GoalCommandScheduler;
  cancelContinuation: GoalContinuationCanceller;
  interruptActiveTurn: GoalPauseInterrupter;
  sendQueueSteering: GoalQueueSteeringSender;
  /** Called for every /goal invocation so goal tools can be progressively enabled. */
  onCommand?: () => void;
};

export async function handleGoalCommand(
  pi: ExtensionAPI,
  args: string,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): Promise<void> {
  // Bind per-tab session scope and rehydrate from this session's branch so
  // another MixCode tab's in-memory goal cannot leak into this command.
  await withGoalSessionFromCtx(ctx, async () => {
    replayGoalState(ctx);
    replayQueueState(ctx);
    const trimmed = args.trim();
    if (!trimmed || trimmed === "help") {
      await openGoalOverlay(pi, ctx, runtime);
      return;
    }

    const handled = handleGoalControlCommand(pi, trimmed, ctx, runtime);
    if (handled) return;

    const resolved = resolveTemplateOrObjectiveDetails(trimmed, ctx);
    if (resolved) await setGoalObjective(pi, resolved, ctx, runtime);
  });
}

async function openGoalOverlay(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): Promise<void> {
  // Capture session key now: overlay render/actions run later outside the command ALS.
  const sessionKey = goalSessionKeyFromManager(ctx.sessionManager);
  const inSession = <T>(fn: () => T): T => runInGoalSession(sessionKey, fn);

  if (!ctx.hasUI) {
    const goal = getGoal();
    if (goal) showGoalSummary(ctx, goal);
    else showNoGoal(ctx);
    return;
  }

  await ctx.ui.custom<void>(
    (tui, theme, _kb, done) =>
      new GoalManagementView(
        theme,
        () => tui.requestRender(),
        () => done(undefined),
        () => Math.floor(tui.terminal.rows * 0.8) - 4,
        {
          getSnapshot: () =>
            inSession(() => ({
              goal: getGoal(),
              queue: getQueue().map((item) => ({
                queueId: item.queueId,
                objective: item.objective,
                template: item.template,
              })),
            })),
          pause: () => inSession(() => pauseGoal(pi, ctx, runtime)),
          resume: () => inSession(() => resumeGoal(pi, ctx, runtime)),
          clear: () => inSession(() => clearGoal(pi, ctx, runtime)),
          enableTools: () => inSession(() => activateGoalToolsCommand(pi, ctx)),
          removeQueueItem: (queueId) =>
            inSession(() => {
              if (!removeGoal(queueId)) return;
              persistRemove(pi, queueId, "overlay_remove");
            }),
          clearQueue: () =>
            inSession(() => {
              for (const item of [...getQueue()]) {
                removeGoal(item.queueId);
                persistRemove(pi, item.queueId, "overlay_clear_queue");
              }
            }),
        },
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "72%",
        maxHeight: "82%",
        margin: 1,
      },
    },
  );
}

function handleGoalControlCommand(
  pi: ExtensionAPI,
  trimmed: string,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): boolean {
  // split() yields "" for an empty command, which matches none of the branches below.
  const firstToken = (trimmed.split(/\s+/, 1)[0] ?? "").toLowerCase();
  if (firstToken === "queue") {
    handleQueueCommand(pi, trimmed, ctx);
    return true;
  }
  if (trimmed === "pause") pauseGoal(pi, ctx, runtime);
  else if (trimmed === "resume") resumeGoal(pi, ctx, runtime);
  else if (trimmed === "clear") clearGoal(pi, ctx, runtime);
  else if (trimmed === "tools") activateGoalToolsCommand(pi, ctx);
  else return false;
  return true;
}

type ResolvedObjectiveInput = {
  objective: string;
  template?: string;
  templateFlags?: Record<string, string>;
  templateArgs?: string;
  postCompletionActions?: PostCompletionActionSpec[];
};

function resolveTemplateOrObjectiveDetails(
  input: string,
  ctx: ExtensionCommandContext,
): ResolvedObjectiveInput | null {
  if (parseGoalTemplateInvocation(input)) {
    const templateIntent = buildTemplateGoalIntent({ invocation: input });
    if (templateIntent.ok && templateIntent.intent.kind === "template")
      return {
        objective: templateIntent.intent.objective,
        template: templateIntent.intent.template,
        templateFlags: templateIntent.intent.flags,
        templateArgs: templateIntent.intent.args,
        postCompletionActions: templateIntent.intent.postCompletionActions,
      };
  }
  const directIntent = buildDirectGoalIntent({ objective: input });
  if (directIntent.ok)
    return {
      objective: directIntent.intent.objective,
      postCompletionActions: directIntent.intent.postCompletionActions,
    };
  notifyWarning(ctx, directIntent.error);
  return null;
}

async function setGoalObjective(
  pi: ExtensionAPI,
  input: ResolvedObjectiveInput,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): Promise<void> {
  if (!input.objective) return;
  captureContextResetCommandContext(ctx);
  const validation = validateObjective(input.objective);
  if (!validation.ok) {
    notifyWarning(
      ctx,
      validation.hint ? `${validation.message}\n${validation.hint}` : validation.message,
    );
    return;
  }

  const existing = getGoal();
  if (existing) {
    const choices = ["Replace", "Queue", "Cancel"];
    const choice = await ctx.ui.select(replacementChoicePrompt(validation.objective), choices);
    if (choice === "Queue" || choice === "Cancel") {
      if (choice === "Queue") {
        const queued = enqueueGoal(validation.objective, "command", {
          postCompletionActions: input.postCompletionActions,
        });
        persistEnqueue(pi, queued);
        notifyInfo(ctx, `Queued goal: ${queued.queueId}`);
      } else {
        notifyInfo(ctx, "Goal creation cancelled.");
      }
      return;
    }
    runtime.cancelContinuation(existing.goalId);
  }

  let goal = createGoalState({
    objective: validation.objective,
    postCompletionActions: createPostCompletionActionStates(input.postCompletionActions ?? []),
  });
  goal = recordPostStartActionAnchors(ctx, goal);
  const telemetry = createTelemetry(goal.goalId, goal.createdAt);
  persistSetGoal(pi, goal, telemetry, "command");
  syncGoalUi(ctx, goal);
  notifyGoal(ctx, goal);
  runtime.scheduleContinuation(ctx, "created");
}

function replacementChoicePrompt(objective: string): string {
  const maxPreviewChars = 4_000;
  const preview =
    objective.length > maxPreviewChars ? `${objective.slice(0, maxPreviewChars - 1)}…` : objective;
  return `Goal already active. New resolved goal:\n\n${preview}\n\nChoose action:`;
}

function pauseGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): void {
  const goal = getGoal();
  if (!goal) {
    notifyInfo(ctx, `${GOAL_USAGE}\nNo goal is currently set.`);
    return;
  }
  runtime.cancelContinuation(goal.goalId);
  flushAndStopGoalActiveTime(pi, "command");
  const current = getGoal() ?? goal;
  const paused: GoalState = { ...current, status: "paused", updatedAt: Date.now() };
  persistUpdateGoal(pi, paused, getTelemetry(), "command");
  syncGoalUi(ctx, paused);
  notifyGoal(ctx, paused);
  if (!ctx.isIdle()) {
    runtime.interruptActiveTurn(ctx, paused);
    notifyWarning(
      ctx,
      "Goal paused. The active turn was interrupted; run /goal resume to continue.",
    );
  }
}

function resumeGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): void {
  const goal = getGoal();
  const queue = getQueue();
  if (!goal) {
    if (queue.length > 0) {
      runtime.sendQueueSteering("goal-resume", { triggerTurn: true });
      notifyInfo(
        ctx,
        `No active goal. Resuming queued goal processing for ${queue.length} queued goal${queue.length > 1 ? "s" : ""}.`,
      );
      return;
    }
    notifyInfo(ctx, `${GOAL_USAGE}\n${GOAL_USAGE_HINT}`);
    return;
  }
  if (goal.status === "complete") {
    if (queue.length > 0) {
      runtime.sendQueueSteering("goal-resume", { triggerTurn: true });
      notifyInfo(
        ctx,
        `Goal is complete. Resuming queued goal processing for ${queue.length} queued goal${queue.length > 1 ? "s" : ""}.`,
      );
      return;
    }
    notifyInfo(ctx, "Goal is complete. Use /goal clear before starting a new goal.");
    return;
  }
  if (!canActivateGoal(goal)) {
    const reason = budgetLimitReason(goal);
    const resource =
      reason === "tokenBudget" ? "token" : reason === "timeBudget" ? "time" : "budget";
    notifyWarning(
      ctx,
      `Cannot resume: ${resource} budget is still exhausted. Raise the budget or use /goal clear before resuming.`,
    );
    return;
  }
  const active: GoalState = { ...goal, status: "active", updatedAt: Date.now() };
  const telemetry = resetSafetyCounters(getTelemetry());
  persistUpdateGoal(pi, active, telemetry, "resume");
  syncGoalUi(ctx, active);
  notifyGoal(ctx, active);
  runtime.scheduleContinuation(ctx, "resumed");
}

function clearGoal(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  runtime: GoalCommandRuntime,
): void {
  const goal = getGoal();
  const hadGoal = Boolean(goal);
  runtime.cancelContinuation(goal?.goalId);
  flushAndStopGoalActiveTime(pi, "command");
  const result = persistClearGoal(pi, "command");
  syncGoalUi(ctx, result.goal);
  const queue = getQueue();
  if (queue.length > 0) runtime.sendQueueSteering("goal-clear");
  const queueHint =
    queue.length > 0
      ? `\n${queue.length} queued goal${queue.length > 1 ? "s" : ""} available. Queue steering was sent to the agent context.`
      : "";
  notifyInfo(
    ctx,
    hadGoal
      ? `Goal cleared${queueHint}`
      : `No goal to clear\nThis session does not currently have a goal.${queueHint}`,
  );
}

function activateGoalToolsCommand(pi: ExtensionAPI, ctx: ExtensionCommandContext): void {
  // Capture tree-nav context for post-completion actions (side benefit of /goal tools).
  captureContextResetCommandContext(ctx);

  const already = isGoalToolsActive(pi);
  const added = enableGoalTools(pi);
  const allMeta = pi
    .getAllTools()
    .filter((tool) => (GOAL_TOOL_NAMES as readonly string[]).includes(tool.name));
  const names = allMeta.map((tool) => tool.name);
  const listed = (names.length > 0 ? names : [...GOAL_TOOL_NAMES]).join(", ");

  if (already || added.length === 0) {
    notifyInfo(
      ctx,
      `Goal tools already active (${GOAL_TOOL_NAMES.length}): ${listed}\nThey are in the model tool list for subsequent turns (Pi setActiveTools).`,
    );
    return;
  }

  notifyInfo(
    ctx,
    `Activated ${added.length} goal tools via Dynamic Tool Loading:\n${added.join(", ")}\n\nFull goal tool set (${GOAL_TOOL_NAMES.length}): ${listed}\nThese tools stay registered; only the active set changed (additive setActiveTools).`,
  );
}

function handleQueueCommand(pi: ExtensionAPI, input: string, ctx: ExtensionCommandContext): void {
  const rest = input.slice("queue".length).trim();
  if (!rest) {
    const queue = getQueue();
    if (queue.length === 0) {
      notifyInfo(ctx, "No queued goals.");
      return;
    }
    const lines = queue.map((g, i) => `${i + 1}. [${g.queueId}] ${truncateObjective(g.objective)}`);
    notifyInfo(ctx, `Queued goals (${queue.length}):\n${lines.join("\n")}`);
    return;
  }

  const blockItems = parseQueueBlockItems(rest);
  if (blockItems) {
    const validatedItems = resolveAndValidateQueueItems(blockItems, ctx);
    if (!validatedItems) return;
    const queued = validatedItems.map((item) => {
      const goal = enqueueGoal(item.objective, "command", {
        template: item.template,
        templateFlags: item.templateFlags,
        templateArgs: item.templateArgs,
        postCompletionActions: item.postCompletionActions,
      });
      persistEnqueue(pi, goal);
      return goal;
    });
    const lines = queued.map(
      (g, i) => `${i + 1}. [${g.queueId}] ${truncateObjective(g.objective)}`,
    );
    notifyInfo(ctx, `Queued ${queued.length} goals:\n${lines.join("\n")}`);
    return;
  }

  const resolved = resolveTemplateOrObjectiveDetails(rest, ctx);
  if (!resolved) return;
  const validation = validateObjective(resolved.objective);
  if (!validation.ok) {
    notifyWarning(
      ctx,
      validation.hint ? `${validation.message}\n${validation.hint}` : validation.message,
    );
    return;
  }
  const queued = enqueueGoal(validation.objective, "command", {
    template: resolved.template,
    templateFlags: resolved.templateFlags,
    templateArgs: resolved.templateArgs,
    postCompletionActions: resolved.postCompletionActions,
  });
  persistEnqueue(pi, queued);
  notifyInfo(
    ctx,
    `Queued goal: ${queued.queueId} \u2014 ${truncateObjective(validation.objective)}`,
  );
}

function truncateObjective(objective: string): string {
  return objective.length > 80 ? `${objective.slice(0, 77)}\u2026` : objective;
}

function resolveAndValidateQueueItems(
  items: QueueBlockItem[],
  ctx: ExtensionCommandContext,
): ResolvedObjectiveInput[] | null {
  const resolvedItems: ResolvedObjectiveInput[] = [];
  for (const [i, item] of items.entries()) {
    const resolved = resolveTemplateOrObjectiveDetails(item.objectiveInput, ctx);
    if (!resolved) {
      notifyWarning(
        ctx,
        `Queue item ${i + 1} (${item.marker} on line ${item.lineIndex + 1}) could not be resolved. No goals were queued.`,
      );
      return null;
    }
    const validation = validateObjective(resolved.objective);
    if (!validation.ok) {
      const message = validation.hint
        ? `${validation.message}\n${validation.hint}`
        : validation.message;
      notifyWarning(
        ctx,
        `Queue item ${i + 1} (${item.marker} on line ${item.lineIndex + 1}) is invalid. No goals were queued.\n${message}`,
      );
      return null;
    }
    resolvedItems.push({ ...resolved, objective: validation.objective });
  }
  return resolvedItems;
}
