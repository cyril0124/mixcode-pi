import * as fs from "node:fs";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { type DetachedRun, type DetachedStart, formatElapsed } from "./exec.js";

/**
 * Surfaces for background commands: the widget above the editor, the rows of
 * the `/bash-logs` overlay, and the session's record of what has been detached.
 */

/** Marks a still-running command in the `/bash-logs` list. */
const RUNNING_DOT = "●";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

/**
 * Tree above the editor: a `Jobs` header, then one branch per run.
 * A wrapped row would silently double the widget's height.
 */
export function renderBackgroundWidget(
  runs: readonly DetachedStart[],
  theme: Theme,
  width: number,
  now = Date.now(),
): string[] {
  if (runs.length === 0) return [];

  const container = new Container();
  const inner = Math.max(24, width - 3);
  const sorted = [...runs].sort((a, b) => a.startedAt - b.startedAt);
  const rows = sorted.map((run, index) => {
    const time = formatElapsed(now - run.startedAt);
    const spin =
      SPINNER_FRAMES[
        Math.floor(Math.max(0, now - run.startedAt) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length
      ]!;
    const branch = index === sorted.length - 1 ? "└" : "├";
    const command = run.command.replace(/\s+/g, " ").trim();
    const suffix = ` · #${run.id}`;
    const text = truncateToWidth(
      command,
      Math.max(4, inner - 6 - time.length - suffix.length),
      "…",
    );
    return `${theme.fg("dim", branch)} ${theme.fg("warning", spin)} ${theme.bold(theme.fg("accent", time))} ${theme.fg("dim", text)}${theme.fg("dim", suffix)}`;
  });
  const count = sorted.length === 1 ? "1 running" : `${sorted.length} running`;
  const header = truncateToWidth(
    `${theme.fg("dim", "○")} ${theme.fg("muted", "Jobs")} ${theme.fg("dim", `· ${count} · /bash-logs to inspect`)}`,
    inner,
    "…",
  );
  const body = [header, ...rows].join("\n");
  container.addChild(new Text(body, 1, 0));

  return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
}

/** Structured fields on the `bash-detached-exit` custom message. */
export interface DetachedExitDetails {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  /** Total output lines; used to number the tail and to mark a cut. */
  lineCount: number;
  elapsedMs: number;
  logPath: string;
  logError?: string;
}

/** Last lines of output shown under the status row. */
const COMPLETION_TAIL_LINES = 10;

function completionLogLines(details: DetachedExitDetails, theme: Theme, inner: number): string[] {
  if (details.logError) {
    return [theme.fg("error", truncateToWidth(details.logError, inner, "…"))];
  }
  const lines = details.tail.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  const shown = lines.slice(-COMPLETION_TAIL_LINES);
  if (shown.length === 0) return [];
  const total = details.lineCount;
  const start = Math.max(1, total - shown.length + 1);
  const gutter = String(Math.max(total, start + shown.length - 1)).length;
  const textWidth = Math.max(4, inner - gutter - 3);
  const body = shown.map((line, index) => {
    const number = theme.fg("dim", String(start + index).padStart(gutter));
    return `${number} │ ${theme.fg("dim", truncateToWidth(line, textWidth, "…"))}`;
  });
  const omitted = total - shown.length;
  if (omitted > 0) {
    const label = omitted === 1 ? "1 line omitted" : `${omitted} lines omitted`;
    return [
      theme.fg("dim", truncateToWidth(`… ${label} (full log at ${details.logPath})`, inner, "…")),
      ...body,
    ];
  }
  return body;
}

/**
 * Chat panel shared by every background-job message: a title, a status row
 * (icon, elapsed, command, right-aligned marker), then an optional body under
 * a rule. `body` receives the usable inner width.
 */
function renderJobPanel(
  theme: Theme,
  width: number,
  panel: {
    title: string;
    icon: string;
    color: ThemeColor;
    elapsedMs: number;
    command: string;
    right: string;
    body: (inner: number) => string[];
  },
): string[] {
  const container = new Container();
  const inner = Math.max(24, width - 3);
  const command = panel.command.replace(/\s+/g, " ").trim();
  const time = formatElapsed(panel.elapsedMs);
  // `⏳` is East-Asian Wide while `✓`/`✗`/`⏱` are not, so the icon costs one
  // column in some panels and two in others, and the right column has to land
  // in the same place in all of them.
  const iconWidth = visibleWidth(panel.icon);
  const text = truncateToWidth(
    command,
    Math.max(4, inner - 4 - iconWidth - time.length - panel.right.length),
    "…",
  );
  const gap = panel.right
    ? Math.max(2, inner - 2 - iconWidth - time.length - visibleWidth(text) - panel.right.length)
    : 0;
  const status =
    `${theme.fg(panel.color, panel.icon)} ${theme.bold(theme.fg("accent", time))} ${theme.fg("text", text)}` +
    (panel.right ? `${" ".repeat(gap)}${theme.fg(panel.color, panel.right)}` : "");

  const body = panel.body(inner);
  const rule = body.length > 0 ? [theme.fg("dim", "─".repeat(inner))] : [];
  const title = theme.bold(theme.fg("accent", panel.title));

  container.addChild(new Text([title, status, ...rule, ...body].join("\n"), 1, 0));
  return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
}

/** Chat render of a finished background command. */
export function renderCompletionMessage(
  details: DetachedExitDetails,
  theme: Theme,
  width: number,
): string[] {
  const [icon, color, right] = details.timedOut
    ? (["⏱", "warning", "timeout"] as const)
    : details.exitCode === 0
      ? (["✓", "success", ""] as const)
      : (["✗", "error", String(details.exitCode ?? "?")] as const);

  return renderJobPanel(theme, width, {
    title: "Background job finished",
    icon,
    color,
    elapsedMs: details.elapsedMs,
    command: details.command,
    right,
    body: (inner) => completionLogLines(details, theme, inner),
  });
}

/** Structured fields on the `bash-detached-stall` message, one per job. */
export interface StallDetails {
  id: number;
  command: string;
  /** How long the log has not grown. */
  silenceMs: number;
  elapsedMs: number;
  /** Last bytes of the log, header already stripped. */
  tail: string;
}

/** Lines of output quoted under a stalled job's status row. */
const STALL_TAIL_LINES = 3;

/**
 * Chat render of jobs that stopped writing. Reuses the completion panel's
 * layout, putting the silence where a finished job shows its exit code.
 */
export function renderStallMessage(jobs: StallDetails[], theme: Theme, width: number): string[] {
  return jobs.flatMap((job, index) => [
    // One check can report several jobs in one message; without this the next
    // title sits directly under the previous panel's output.
    ...(index > 0 ? [""] : []),
    ...renderJobPanel(theme, width, {
      title: "Background job stalled",
      icon: "⏳",
      color: "warning",
      elapsedMs: job.elapsedMs,
      command: job.command,
      right: `silent ${formatElapsed(job.silenceMs)}`,
      body: (inner) => {
        const lines = job.tail.split(/\r?\n/).filter((line) => line.trim() !== "");
        const shown = lines.slice(-STALL_TAIL_LINES);
        if (shown.length === 0) return [theme.fg("dim", "no output yet")];
        return shown.map((line) => theme.fg("dim", truncateToWidth(line, inner, "…")));
      },
    }),
  ]);
}

/** A detached run that has ended; kept so `/bash-logs` can still reach its log. */
export interface FinishedRun extends DetachedStart {
  exitCode: number | null;
  timedOut: boolean;
  endedAt: number;
}

export function hasEnded(run: DetachedStart | FinishedRun): run is FinishedRun {
  return "endedAt" in run;
}

/** Detached runs remembered per session for `/bash-logs`. */
const HISTORY_LIMIT = 50;
/** Log bytes shown by `/bash-logs`; the file itself keeps everything. */
const LOG_VIEW_BYTES = 200_000;

/** Command column of a `/bash-logs` row; the rest is fixed-width. */
const CHOICE_COMMAND_WIDTH = 48;

/**
 * One `/bash-logs` list row, laid out in fixed columns so the list reads as a
 * table: `<icon> <state> <time>  <command>  #<pid>`.
 *
 * The pid also keeps rows unique when the same command is run twice.
 */
export function formatRunChoice(run: DetachedStart | FinishedRun, now = Date.now()): string {
  const command = run.command.replace(/\s+/g, " ").trim();
  const [icon, state, elapsed] = hasEnded(run)
    ? [
        run.timedOut ? "⏱" : run.exitCode === 0 ? "✓" : "✗",
        run.timedOut ? "timeout" : `exit ${run.exitCode ?? "?"}`,
        formatElapsed(run.endedAt - run.startedAt),
      ]
    : [RUNNING_DOT, "running", formatElapsed(now - run.startedAt)];
  const text = truncateToWidth(command, CHOICE_COMMAND_WIDTH, "…");
  const padding = " ".repeat(Math.max(1, CHOICE_COMMAND_WIDTH - visibleWidth(text)));
  return `${icon} ${state.padEnd(8)} ${elapsed.padStart(6)}  ${text}${padding}  #${run.id}`;
}

/**
 * Last `limit` bytes of a log, with nothing added.
 *
 * Throws the underlying fs error (e.g. ENOENT for a log the user deleted).
 */
export async function readLogTail(
  logPath: string,
  limit: number,
): Promise<{ text: string; bytes: number; size: number }> {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return { text: buffer.toString("utf8"), bytes: length, size };
  } finally {
    await handle.close();
  }
}

/**
 * Log text for the viewer. Reads at most the last `LOG_VIEW_BYTES` and says so,
 * so a huge log cannot stall the TUI. That banner is a reader affordance; code
 * that quotes a log back to the model wants `readLogTail`.
 *
 * Throws the underlying fs error (e.g. ENOENT for a log the user deleted).
 */
export async function readLogForView(logPath: string, limit = LOG_VIEW_BYTES): Promise<string> {
  const { text, bytes, size } = await readLogTail(logPath, limit);
  if (bytes === size) return text;
  return `[mpi-bash] Showing the last ${bytes} of ${size} bytes. Full log: ${logPath}\n\n${text}`;
}

/**
 * Re-read `logPath` only when it changed since `stamp` (size and mtime).
 * Returns the new text with its stamp, or undefined when nothing moved.
 */
export async function reloadLogIfChanged(
  logPath: string,
  stamp: string,
): Promise<{ text: string; stamp: string } | undefined> {
  const stats = await fs.promises.stat(logPath);
  const current = `${stats.size}:${stats.mtimeMs}`;
  if (current === stamp) return undefined;
  return { text: await readLogForView(logPath), stamp: current };
}

/** Status key for the background-command footer entry. */
const BACKGROUND_WIDGET_KEY = "mpi-bash-background";
/** Widget refresh cadence; matches the spinner interval so the glyph moves. */
const STATUS_REFRESH_MS = SPINNER_INTERVAL_MS;

/**
 * Footer entry listing the commands this session left running in the background.
 *
 * Ticks only while at least one command is detached, so an idle session pays
 * nothing.
 */
export class BackgroundStatus {
  private readonly runs = new Map<number, DetachedStart>();
  /** Detached runs of this session, newest last, for `/bash-logs`. */
  private readonly history: FinishedRun[] = [];
  private ticker: ReturnType<typeof setInterval> | undefined;
  private ctx: ExtensionContext | undefined;
  /** Set by `dispose`, cleared by `bind`; guards a dead session's registry. */
  private disposed = false;
  /** Widget rows are rendered from this live map, so the factory is stable. */
  private readonly widget = (_tui: TUI, theme: Theme) => ({
    render: (width: number) => renderBackgroundWidget([...this.runs.values()], theme, width),
    invalidate: () => {},
  });

  bind(ctx: ExtensionContext): void {
    this.disposed = false;
    this.ctx = ctx;
    this.render();
  }

  add(start: DetachedStart): void {
    if (this.disposed) return;
    this.runs.set(start.id, start);
    this.ticker ??= setInterval(() => this.render(), STATUS_REFRESH_MS);
    this.ticker.unref?.();
    this.render();
  }

  finish(run: DetachedRun): void {
    // A command outlives the session that started it; its exit must not
    // repopulate a registry that was already cleared.
    if (this.disposed) return;
    const start = this.runs.get(run.id);
    this.runs.delete(run.id);
    if (this.runs.size === 0) this.stopTicker();
    this.history.push({
      id: run.id,
      command: run.command,
      startedAt: start?.startedAt ?? Date.now(),
      logPath: run.logPath,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      endedAt: Date.now(),
    });
    // Bounded so a long session cannot grow the history without limit.
    if (this.history.length > HISTORY_LIMIT) this.history.shift();
    this.render();
  }

  /** Runs still executing, oldest first. */
  running(): DetachedStart[] {
    return [...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt);
  }

  /** Running runs first (newest last), then finished ones. */
  list(): Array<DetachedStart | FinishedRun> {
    return [...this.running(), ...this.history];
  }

  dispose(): void {
    this.disposed = true;
    this.runs.clear();
    this.history.length = 0;
    this.stopTicker();
    this.render();
    this.ctx = undefined;
  }

  private stopTicker(): void {
    if (!this.ticker) return;
    clearInterval(this.ticker);
    this.ticker = undefined;
  }

  private render(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    try {
      // Re-setting the widget is how mpi-loop repaints too: the factory reads
      // the live map, so this call is what advances the clock.
      ctx.ui.setWidget(BACKGROUND_WIDGET_KEY, this.runs.size === 0 ? undefined : this.widget, {
        placement: "aboveEditor",
      });
    } catch {
      // The captured context died with its session (replace/reload); stop
      // painting into it and let the next session_start rebind.
      this.ctx = undefined;
      this.stopTicker();
    }
  }
}
