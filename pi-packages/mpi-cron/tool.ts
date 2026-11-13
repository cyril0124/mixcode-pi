/**
 * mpi-cron: the `cron` tool.
 *
 * The tool is the primary surface: an agent can schedule, inspect, pause, and
 * fire jobs without a slash command. It writes through the shared hub, so a job
 * created from a subagent session appears in every tab's widget for this cwd.
 */

import type { ExtensionContext, Theme, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CronParseError, describeSchedule, formatUntil, parseSchedule } from "./cron-engine.js";
import type { CronHub } from "./hub.js";
import type { CronJob } from "./types.js";

/** Custom-entry type used to mark a fired prompt; also blocks recursive scheduling. */
export const SCHEDULED_PROMPT_TYPE = "scheduled_prompt";

const cronActionSchema = Type.Union(
  [
    Type.Literal("add"),
    Type.Literal("list"),
    Type.Literal("update"),
    Type.Literal("remove"),
    Type.Literal("enable"),
    Type.Literal("disable"),
    Type.Literal("fire"),
    Type.Literal("cleanup"),
  ],
  { description: "Operation to perform" },
);

const cronToolSchema = Type.Object({
  action: cronActionSchema,
  schedule: Type.Optional(
    Type.String({
      description:
        "When to run. Cron (`0 9 * * *`, `*/15 * * * *`, 6-field with seconds), interval (`5m`, `every 2h`), relative (`+30s`), or an ISO timestamp. Required for add.",
    }),
  ),
  prompt: Type.Optional(
    Type.String({
      description: "Prompt or instruction to run at each fire time. Required for add.",
    }),
  ),
  name: Type.Optional(
    Type.String({ description: "Short job name; defaults to a name derived from the prompt." }),
  ),
  description: Type.Optional(
    Type.String({ description: "Optional note shown in the management view." }),
  ),
  jobId: Type.Optional(
    Type.String({
      description: "Target job id (or unique name prefix) for update/remove/enable/disable/fire.",
    }),
  ),
  enabled: Type.Optional(
    Type.Boolean({ description: "For update: set the enabled state explicitly." }),
  ),
});

export type CronToolDetails = {
  action: string;
  jobs: CronJob[];
  jobId?: string;
  jobName?: string;
  error?: string;
  /** Set for a fire action that reached the store but did not deliver. */
  skipped?: boolean;
};

const cronJobOutputSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  description: Type.Optional(Type.String()),
  prompt: Type.String(),
  schedule: Type.Union([
    Type.Object({ kind: Type.Literal("cron"), expr: Type.String(), source: Type.String() }),
    Type.Object({
      kind: Type.Literal("interval"),
      intervalMs: Type.Number(),
      source: Type.String(),
    }),
    Type.Object({ kind: Type.Literal("once"), atMs: Type.Number(), source: Type.String() }),
    Type.Object({ kind: Type.Literal("relative"), delayMs: Type.Number(), source: Type.String() }),
  ]),
  enabled: Type.Boolean(),
  runCount: Type.Number(),
  lastRun: Type.Optional(Type.Number()),
  lastStatus: Type.Optional(
    Type.Union([Type.Literal("ok"), Type.Literal("error"), Type.Literal("running")]),
  ),
  nextRun: Type.Optional(Type.Number()),
  claim: Type.Optional(Type.String()),
  createdAt: Type.Number(),
  createdBy: Type.Optional(Type.String()),
  expiresAt: Type.Optional(Type.Number()),
});

const cronToolOutputSchema = Type.Object({
  action: cronActionSchema,
  jobs: Type.Array(cronJobOutputSchema),
  jobId: Type.Optional(Type.String()),
  jobName: Type.Optional(Type.String()),
  error: Type.Optional(Type.String()),
  skipped: Type.Optional(Type.Boolean()),
});

function cronToolResult(details: CronToolDetails, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details,
    structuredContent: details,
  };
}

/** Resolve a job by exact id first, then by unique name or id prefix. */
export function findJob(jobs: CronJob[], key: string): CronJob | undefined {
  const exact = jobs.find((job) => job.id === key);
  if (exact) return exact;
  const lowered = key.toLowerCase();
  const byName = jobs.filter((job) => job.name.toLowerCase() === lowered);
  if (byName.length === 1) return byName[0];
  const byPrefix = jobs.filter((job) => job.id.startsWith(key));
  if (byPrefix.length === 1) return byPrefix[0];
  return undefined;
}

/** Short readable id derived from the prompt, so jobs are addressable by name. */
export function deriveJobName(prompt: string, taken: Set<string>): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 1)
    .slice(0, 4);
  const base = words.join("-").slice(0, 32) || "job";
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index++) {
    const candidate = `${base}-${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}-${taken.size + 1}`;
}

/**
 * True when the prompt currently being executed is itself a fired job prompt.
 *
 * The scan walks backwards from the newest entry and stops at the first user
 * message, so a marker left by an earlier run cannot block a legitimate `add` in
 * a later turn. Only a marker that arrived after the last real user message
 * counts. A session with no marker at all is never a fired-prompt run.
 */
export function isInsideScheduledRun(ctx: ExtensionContext): boolean {
  const entries = ctx.sessionManager.getEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as {
      type?: string;
      customType?: string;
      message?: { role?: string };
    };
    if (entry.type === "message" && entry.message?.role === "user") return false;
    if (entry.type === "custom" && entry.customType === SCHEDULED_PROMPT_TYPE) return true;
  }
  return false;
}

function summarizeJob(job: CronJob, now: number): string {
  const state = job.claim !== undefined ? "running" : job.enabled ? "enabled" : "paused";
  const next =
    job.nextRun !== undefined && job.enabled && job.claim === undefined
      ? `next ${formatUntil(job.nextRun, now)}`
      : "no pending run";
  return `${job.id}  ${job.name}  [${state}]  ${describeSchedule(job.schedule)}  ${next}  runs=${job.runCount}`;
}

export function createCronTool(
  getHub: () => CronHub,
  /**
   * Creator recorded on a new job: the session whose widget the job belongs to.
   * Return undefined for a session that hosts no widget, which leaves the job
   * unowned so every interactive tab shows it.
   */
  resolveCreatedBy?: (ctx: ExtensionContext) => string | undefined,
): ToolDefinition<typeof cronToolSchema, CronToolDetails> {
  return {
    name: "cron",
    label: "Cron",
    description:
      "Use this tool when the user requests a reminder, a delayed or future task, a specific run time, or recurring checks. " +
      "For monitoring requests without an interval, confirm the interval before adding a recurring job. Do not use this tool for work that should happen now. " +
      "Actions: add (needs schedule + prompt), list, update, remove, enable, disable, fire (run now), cleanup (drop finished jobs). " +
      "Schedule formats: cron with 5 fields (`0 9 * * *`) or 6 with seconds, interval (`5m`, `every 2h`), relative (`+30s`), or an ISO timestamp. Times are local.",
    parameters: cronToolSchema,
    outputSchema: cronToolOutputSchema,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const hub = getHub();
      const details: CronToolDetails = { action: params.action, jobs: [] };
      const now = Date.now();

      try {
        switch (params.action) {
          case "add": {
            if (!params.schedule) throw new Error("`schedule` is required for add.");
            if (!params.prompt) throw new Error("`prompt` is required for add.");
            if (isInsideScheduledRun(ctx)) {
              // A fired prompt must not schedule more work; without this guard a
              // job can chain into runaway growth.
              throw new Error(
                "Refusing to schedule a job from inside a fired prompt. Mention the schedule to the user instead.",
              );
            }
            const schedule = parseSchedule(params.schedule, now);
            const jobs = await hub.refresh();
            const name =
              params.name ?? deriveJobName(params.prompt, new Set(jobs.map((job) => job.name)));
            if (jobs.some((job) => job.name === name)) {
              throw new Error(
                `A job named "${name}" already exists. Pick another name or remove it first.`,
              );
            }
            const job = await hub.add({
              name,
              description: params.description,
              prompt: params.prompt,
              schedule,
              createdBy: resolveCreatedBy
                ? resolveCreatedBy(ctx)
                : ctx.sessionManager.getSessionId(),
            });
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;
            return cronToolResult(
              details,
              `Created cron job "${job.name}" (${job.id})\n` +
                `Schedule: ${describeSchedule(job.schedule)}\n` +
                `Next run: ${job.nextRun !== undefined ? new Date(job.nextRun).toLocaleString() : "none"}\n` +
                `Prompt: ${job.prompt}`,
            );
          }

          case "list": {
            const jobs = await hub.refresh();
            details.jobs = jobs;
            if (jobs.length === 0) {
              return cronToolResult(details, "No cron jobs configured.");
            }
            const lines = [`Cron jobs (${jobs.length}):`, ""];
            for (const job of jobs) {
              lines.push(summarizeJob(job, now));
              lines.push(`  prompt: ${job.prompt.replace(/[\r\n]+/g, " ").slice(0, 120)}`);
            }
            return cronToolResult(details, lines.join("\n"));
          }

          case "update": {
            if (!params.jobId) throw new Error("`jobId` is required for update.");
            const jobs = await hub.refresh();
            const job = findJob(jobs, params.jobId);
            if (!job) throw new Error(`No cron job matching "${params.jobId}".`);
            const patch: Partial<CronJob> = {};
            if (params.name !== undefined) patch.name = params.name;
            if (params.description !== undefined) patch.description = params.description;
            if (params.prompt !== undefined) patch.prompt = params.prompt;
            if (params.enabled !== undefined) patch.enabled = params.enabled;
            if (params.schedule !== undefined) patch.schedule = parseSchedule(params.schedule, now);
            const updated = await hub.update(job.id, patch);
            details.jobs = [updated];
            details.jobId = updated.id;
            details.jobName = updated.name;
            return cronToolResult(
              details,
              `Updated cron job "${updated.name}" (${updated.id})\n${summarizeJob(updated, now)}`,
            );
          }

          case "remove": {
            if (!params.jobId) throw new Error("`jobId` is required for remove.");
            const jobs = await hub.refresh();
            const job = findJob(jobs, params.jobId);
            if (!job) throw new Error(`No cron job matching "${params.jobId}".`);
            await hub.remove(job.id);
            details.jobId = job.id;
            details.jobName = job.name;
            return cronToolResult(details, `Removed cron job "${job.name}" (${job.id}).`);
          }

          case "enable":
          case "disable": {
            if (!params.jobId) throw new Error(`\`jobId\` is required for ${params.action}.`);
            const jobs = await hub.refresh();
            const job = findJob(jobs, params.jobId);
            if (!job) throw new Error(`No cron job matching "${params.jobId}".`);
            const updated = await hub.update(job.id, { enabled: params.action === "enable" });
            details.jobs = [updated];
            details.jobId = updated.id;
            details.jobName = updated.name;
            return cronToolResult(
              details,
              `${updated.enabled ? "Enabled" : "Paused"} cron job "${updated.name}" (${updated.id}).`,
            );
          }

          case "fire": {
            if (!params.jobId) throw new Error("`jobId` is required for fire.");
            const jobs = await hub.refresh();
            const job = findJob(jobs, params.jobId);
            if (!job) throw new Error(`No cron job matching "${params.jobId}".`);
            const outcome = await hub.fireNow(job.id);
            details.jobs = [job];
            details.jobId = job.id;
            details.jobName = job.name;
            details.skipped = outcome === "skipped";
            return cronToolResult(
              details,
              outcome === "done"
                ? `Fired cron job "${job.name}" (${job.id}).`
                : `Cron job "${job.name}" (${job.id}) was already running or is disabled; nothing fired.`,
            );
          }

          case "cleanup": {
            const jobs = await hub.refresh();
            // Cleanup drops jobs the hub already stopped (a finished one-shot, or
            // an exhausted schedule). A job the user paused on purpose is removed
            // here too; the view asks for confirmation before calling this.
            const disabled = jobs.filter((job) => !job.enabled);
            for (const job of disabled) await hub.remove(job.id);
            details.jobs = disabled;
            return cronToolResult(
              details,
              disabled.length === 0
                ? "No paused jobs to clean up."
                : `Removed ${disabled.length} paused job(s).\n${disabled
                    .map((job) => `  ${job.id}  ${job.name}`)
                    .join("\n")}`,
            );
          }

          default: {
            const exhaustive: never = params.action;
            throw new Error(`Unknown action: ${String(exhaustive)}`);
          }
        }
      } catch (error) {
        const message =
          error instanceof CronParseError || error instanceof Error ? error.message : String(error);
        details.error = message;
        return cronToolResult(details, `Error: ${message}`);
      }
    },

    renderCall(args, theme: Theme) {
      const target = args.jobId ? ` ${args.jobId}` : "";
      const name = args.name ? ` "${args.name}"` : "";
      return new Text(
        theme.fg("accent", `cron ${args.action}`) + theme.fg("text", `${target}${name}`),
        0,
        0,
      );
    },

    renderResult(result, _options, theme: Theme) {
      const text = result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
      if (result.details?.error) return new Text(theme.fg("error", text), 0, 0);
      return new Text(text, 0, 0);
    },
  };
}
