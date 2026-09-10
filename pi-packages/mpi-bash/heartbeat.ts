import * as fs from "node:fs";
import { type DetachedStart, formatElapsed, stripLogHeader, xmlElement } from "./exec.js";
import { readLogTail, type StallDetails } from "./widget.js";

/**
 * Stall reminders for detached commands.
 *
 * Between the detach notice and the exit notice the model hears nothing, so
 * nothing surfaces a hung command until its timeout kills it. Reminders track
 * silence rather than age: a build that streams output for ten minutes is
 * healthy and must not cost a turn, while a log that stopped growing is worth
 * a turn.
 *
 * Each reminder doubles the wait for the next one, so a command hung for hours
 * produces a handful of reminders instead of one a minute. Any new output
 * resets the ladder to the start.
 */

/** Log silence before the first reminder. */
export const DEFAULT_STALL_SECONDS = 60;

/** Each reminder waits this many times longer than the previous one. */
const BACKOFF_FACTOR = 2;

/** Upper and lower bounds on how often running commands' logs are stat'ed. */
const MAX_CHECK_INTERVAL_MS = 15_000;
const MIN_CHECK_INTERVAL_MS = 500;

/**
 * Silence before the first reminder, in seconds. `0` disables stall reminders,
 * which restores silence between the detach notice and the exit notice.
 *
 * Throws on a malformed value instead of silently using the default.
 */
export function resolveStallSeconds(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.MPI_BASH_STALL_SECONDS;
  if (raw === undefined || raw.trim() === "") return DEFAULT_STALL_SECONDS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`MPI_BASH_STALL_SECONDS must be a non-negative number of seconds, got: ${raw}`);
  }
  return value;
}

/**
 * Poll often enough to catch the threshold without overshooting it: a quarter
 * of the silence window, clamped so a long window still polls every 15s and a
 * very short one cannot spin.
 */
export function stallCheckIntervalMs(firstQuietMs: number): number {
  return Math.min(MAX_CHECK_INTERVAL_MS, Math.max(MIN_CHECK_INTERVAL_MS, firstQuietMs / 4));
}

/** Log bytes read to quote a stalled command's last output. */
const TAIL_BYTES = 2000;

/** Lines of that tail quoted in the reminder. */
const TAIL_LINES = 3;

interface StallState {
  /** `size:mtime` at the last check; a change means the command wrote output. */
  stamp: string;
  /** Log mtime when it last changed, i.e. when output last appeared. */
  quietSince: number;
  /** Wall clock at which the next reminder is due. */
  nextAt: number;
  /** Current backoff wait, doubled after every reminder. */
  interval: number;
}

/** One stalled job: what the model reads, and what the chat panel renders. */
export interface StallReport {
  jobs: StallDetails[];
  /** Advance backoff only for jobs actually delivered, once per report. */
  markDelivered(jobIds: readonly number[], now?: number): void;
}

export function formatStallNotice(options: StallDetails & { logPath: string }): string {
  const silence = formatElapsed(options.silenceMs);
  const elapsed = formatElapsed(options.elapsedMs);
  const output = options.tail
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "")
    .slice(-TAIL_LINES)
    .join("\n");
  return [
    `<bash_stall job_id="${options.id}">`,
    xmlElement(
      "summary",
      `Background job #${options.id} may be stuck after ${silence} of silence.`,
    ),
    xmlElement("command", options.command),
    xmlElement("silence", silence),
    xmlElement("elapsed", elapsed),
    xmlElement("log_path", options.logPath),
    xmlElement("output", output),
    xmlElement("logs_hint", `Use tail -n 50 ${options.logPath} to inspect recent output.`),
    xmlElement("stop_hint", `Use kill -- -${options.id} to stop the whole process group.`),
    xmlElement(
      "action_hint",
      "Ignore this event if long periods without output are expected for this command.",
    ),
    "</bash_stall>",
  ].join("\n");
}

/**
 * Watches detached runs for log silence.
 *
 * Stateful across calls: `check` must be called with every currently running
 * run, since a run missing from the list is treated as finished and forgotten.
 */
export class StallMonitor {
  private readonly states = new Map<number, StallState>();

  constructor(private readonly firstQuietMs = DEFAULT_STALL_SECONDS * 1000) {}

  /**
   * Returns due candidates without consuming their reminder intervals. The
   * caller rechecks session/job liveness, sends, then calls markDelivered.
   */
  async check(runs: readonly DetachedStart[], now = Date.now()): Promise<StallReport | undefined> {
    const live = new Set(runs.map((run) => run.id));
    for (const id of this.states.keys()) {
      if (!live.has(id)) this.states.delete(id);
    }

    const due: StallDetails[] = [];
    const dueStates = new Map<number, StallState>();
    for (const run of runs) {
      let stats: fs.Stats;
      try {
        stats = await fs.promises.stat(run.logPath);
      } catch {
        // Any fs error here (deleted log, unwritable tmpdir, EIO) leaves no way
        // to measure silence, so this tick is skipped and the next one retries.
        // The run's exit notice reports it either way. The ladder is kept: a
        // failed read must not pass for fresh output and reset the wait.
        continue;
      }
      const stamp = `${stats.size}:${stats.mtimeMs}`;
      let state = this.states.get(run.id);
      if (!state || state.stamp !== stamp) {
        // Anchored on the log's mtime, not on `now`, so a run already silent
        // when it is first seen is reported without waiting a full interval.
        state = {
          stamp,
          quietSince: stats.mtimeMs,
          interval: this.firstQuietMs,
          nextAt: stats.mtimeMs + this.firstQuietMs,
        };
        this.states.set(run.id, state);
      }
      if (now < state.nextAt) continue;
      let tail: string;
      try {
        // Read only once a reminder is due, and after the stat, which the log
        // can disappear between. A short log is read from its first byte, so
        // the text still carries the header naming the command, which the
        // command never printed.
        const log = await readLogTail(run.logPath, TAIL_BYTES);
        if (log.size !== stats.size || log.mtimeMs !== stats.mtimeMs) {
          // Output changed between the silence check and tail read.
          // Reset the quiet interval before the next check.
          this.states.delete(run.id);
          continue;
        }
        tail = stripLogHeader(log.text);
      } catch {
        // Same contract as a failed stat. No report, ladder untouched, and the
        // whole check keeps running for the other jobs.
        continue;
      }
      dueStates.set(run.id, state);
      const job: StallDetails = {
        id: run.id,
        command: run.command.replace(/\s+/g, " ").trim(),
        silenceMs: now - state.quietSince,
        elapsedMs: now - run.startedAt,
        tail,
      };
      due.push(job);
    }
    if (due.length === 0) return undefined;
    return {
      jobs: due,
      markDelivered: (jobIds, deliveredAt = Date.now()) => {
        for (const id of jobIds) {
          const state = dueStates.get(id);
          if (!state || this.states.get(id) !== state) continue;
          state.interval *= BACKOFF_FACTOR;
          state.nextAt = deliveredAt + state.interval;
          dueStates.delete(id);
        }
      },
    };
  }
}
