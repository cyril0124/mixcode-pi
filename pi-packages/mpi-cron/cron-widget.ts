/**
 * mpi-cron: the always-visible widget below the editor.
 *
 * Shows this directory's cron jobs, including jobs created in another tab, by a
 * subagent, or before a restart.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Spacer,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { describeSchedule, formatRunCount, formatUntil } from "./cron-engine.js";
import type { CronJob } from "./types.js";

export const CRON_WIDGET_ID = "mpi-cron-widget";

/** Rows shown at once; the widget stays compact even with many jobs. */
const MAX_ROWS = 6;
/** Refresh cadence for the "in 3m" countdown column. */
export const WIDGET_REFRESH_MS = 30_000;

/** Width of the run-count column, sized for `999999 runs`. */
const RUNS_WIDTH = 11;

/** Glyphs per run state; plain ASCII fallbacks keep narrow terminals readable. */
function statusGlyph(job: CronJob): {
  glyph: string;
  tone: "success" | "warning" | "error" | "dim";
} {
  if (job.claim !== undefined) return { glyph: "~", tone: "warning" };
  if (!job.enabled) return { glyph: "x", tone: "dim" };
  if (job.lastStatus === "error") return { glyph: "!", tone: "error" };
  return { glyph: "*", tone: "success" };
}

function pad(text: string, width: number): string {
  const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

/** Same clipping rules as `pad`, aligned to the right so digits line up. */
function leftPad(text: string, width: number): string {
  const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
  return " ".repeat(Math.max(0, width - visibleWidth(clipped))) + clipped;
}

/** Rows the widget wants to show for these jobs, or an empty list when hidden. */
export function renderCronWidgetRows(
  jobs: CronJob[],
  width: number,
  theme: Theme,
  now: number,
): string[] {
  if (jobs.length === 0) return [];
  const sorted = sortJobs(jobs);
  const shown = sorted.slice(0, MAX_ROWS);
  const hidden = sorted.length - shown.length;

  const borderColor = (text: string) => theme.fg("accent", text);
  const container = new Container();
  container.addChild(new DynamicBorder(borderColor));
  container.addChild(
    new Text(
      theme.fg("accent", theme.bold("Cron")) +
        theme.fg("dim", ` (${jobs.length})`) +
        theme.fg("dim", "  ·  /cron to manage"),
      1,
      0,
    ),
  );
  container.addChild(new Spacer(1));

  // Column budget: status(1) + name + schedule + next + runs. Name and schedule
  // share the flexible space; the numeric columns keep fixed widths so CJK
  // names cannot shift them.
  const contentWidth = Math.max(24, width - 6);
  const fixed = 1 + 1 + 11 + RUNS_WIDTH + 2;
  const flexible = Math.max(10, contentWidth - fixed);
  const nameWidth = Math.min(24, Math.max(8, Math.floor(flexible * 0.45)));
  const scheduleWidth = Math.max(8, flexible - nameWidth);

  const lines: string[] = [];
  for (const job of shown) {
    const { glyph, tone } = statusGlyph(job);
    const status = theme.fg(tone, pad(glyph, 1));
    const name = theme.fg(job.enabled ? "text" : "dim", pad(job.name, nameWidth));
    const schedule = theme.fg("dim", pad(describeSchedule(job.schedule), scheduleWidth));
    // A published next run can outlive the plan it came from (a one-shot that
    // just fired is disabled but keeps its old value in the view model), so the
    // disabled state wins over any timestamp.
    const next =
      job.claim !== undefined
        ? "running"
        : !job.enabled
          ? "paused"
          : job.nextRun !== undefined
            ? formatUntil(job.nextRun, now)
            : "—";
    const nextCell = theme.fg(
      job.enabled && job.claim === undefined ? "accent" : "dim",
      pad(next, 11),
    );
    const runs = theme.fg("dim", leftPad(formatRunCount(job.runCount), RUNS_WIDTH));
    lines.push(` ${status} ${name} ${schedule} ${nextCell} ${runs}`.trimEnd());
  }
  if (hidden > 0) {
    lines.push(theme.fg("dim", ` … ${hidden} more`));
  }
  container.addChild(new Text(lines.join("\n"), 1, 0));
  container.addChild(new DynamicBorder(borderColor));
  return container.render(width);
}

/** Enabled jobs first, then by soonest next run. */
export function sortJobs(jobs: CronJob[]): CronJob[] {
  return [...jobs].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    const aNext = a.nextRun ?? Number.POSITIVE_INFINITY;
    const bNext = b.nextRun ?? Number.POSITIVE_INFINITY;
    if (aNext !== bNext) return aNext - bNext;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Owns the widget registration for one session. The hub drives `update` after
 * every state change, and a timer keeps the relative-time column honest.
 */
export class CronWidget {
  private timer?: ReturnType<typeof setTimeout>;
  private live = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private getJobs: () => CronJob[],
  ) {}

  /** Render once; returns [] so the caller can hide the widget when empty. */
  render(width: number): string[] {
    return renderCronWidgetRows(this.getJobs(), width, this.theme, Date.now());
  }

  /** Start (or keep) the periodic repaint. */
  start(): void {
    this.live = true;
    this.scheduleRefresh();
  }

  stop(): void {
    this.live = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Repaint now, e.g. after a job fired or the job list changed. */
  update(): void {
    if (!this.live) return;
    this.tui.requestRender();
  }

  private scheduleRefresh(): void {
    if (!this.live) return;
    this.timer = setTimeout(() => {
      if (!this.live) return;
      this.tui.requestRender();
      this.scheduleRefresh();
    }, WIDGET_REFRESH_MS);
    // A pending repaint must not keep the process alive at shutdown.
    this.timer.unref?.();
  }
}
