import * as fs from "node:fs";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import type { DetachedRun, DetachedStart } from "./exec.js";

/**
 * Surfaces for background commands: the widget above the editor, the rows of
 * the `/bash-logs` picker, and the session's record of what has been detached.
 */

/** Marks a still-running command in the `/bash-logs` picker. */
const RUNNING_DOT = "●";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const SPINNER_INTERVAL_MS = 80;

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  // Zero-pad seconds so 1m3s and 1m13s stay the same width.
  return minutes > 0 ? `${minutes}m${String(total % 60).padStart(2, "0")}s` : `${total}s`;
}

/** Oldest first. Each command is flattened to one line. */
export function backgroundRows(runs: readonly DetachedStart[], now = Date.now()): string[][] {
  return [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((run) => [run.command.replace(/\s+/g, " ").trim(), formatElapsed(now - run.startedAt)]);
}

/**
 * One line per background command, no chrome: the widget sits directly above
 * the editor, so every extra row costs transcript space.
 *
 * Colour carries the hierarchy - warning spinner, accent elapsed, dim command.
 */
export function renderBackgroundWidget(
  runs: readonly DetachedStart[],
  theme: Theme,
  width: number,
  now = Date.now(),
): string[] {
  if (runs.length === 0) return [];

  const container = new Container();
  // Usable width inside the Text container's indent and padding; a row wider
  // than this wraps and silently doubles the widget's height.
  const inner = Math.max(24, width - 3);
  const body = [...runs]
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((run) => {
      const time = formatElapsed(now - run.startedAt);
      const spin =
        SPINNER_FRAMES[
          Math.floor(Math.max(0, now - run.startedAt) / SPINNER_INTERVAL_MS) % SPINNER_FRAMES.length
        ]!;
      const command = run.command.replace(/\s+/g, " ").trim();
      const text = truncateToWidth(command, Math.max(4, inner - 3 - time.length), "…");
      return `${theme.fg("warning", spin)} ${theme.bold(theme.fg("accent", time))} ${theme.fg("dim", text)}`;
    })
    .join("\n");
  container.addChild(new Text(body, 1, 0));

  return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
}

/** Structured fields on the `bash-detached-exit` custom message. */
export interface DetachedExitDetails {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  tail: string;
  logPath: string;
  logError?: string;
}

/** Last non-empty lines of output shown under the status row. */
const COMPLETION_TAIL_LINES = 3;

/** Chat render of a finished background command: status row, then a short tail. */
export function renderCompletionMessage(
  details: DetachedExitDetails,
  theme: Theme,
  width: number,
): string[] {
  const command = details.command.replace(/\s+/g, " ").trim();
  const [icon, color, right] = details.timedOut
    ? (["⏱", "warning", "timeout"] as const)
    : details.exitCode === 0
      ? (["✓", "success", ""] as const)
      : (["✗", "error", String(details.exitCode ?? "?")] as const);

  const container = new Container();
  const inner = Math.max(24, width - 3);
  const text = truncateToWidth(command, Math.max(4, inner - 4 - right.length), "…");
  const gap = right ? Math.max(2, inner - 2 - visibleWidth(text) - right.length) : 0;
  const status =
    `${theme.fg(color, icon)} ${theme.fg("dim", text)}` +
    (right ? `${" ".repeat(gap)}${theme.fg(color, right)}` : "");

  const tail = details.logError
    ? [theme.fg("error", truncateToWidth(details.logError, inner, "…"))]
    : details.tail
        .trim()
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-COMPLETION_TAIL_LINES)
        .map((line) => theme.fg("dim", truncateToWidth(line, inner, "…")));

  container.addChild(new Text([status, ...tail].join("\n"), 1, 0));
  return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
}

/** A detached run that has ended; kept so `/bash-logs` can still reach its log. */
export interface FinishedRun extends DetachedStart {
  exitCode: number | null;
  timedOut: boolean;
  endedAt: number;
}

function hasEnded(run: DetachedStart | FinishedRun): run is FinishedRun {
  return "endedAt" in run;
}

/** Detached runs remembered per session for `/bash-logs`. */
const HISTORY_LIMIT = 50;
/** Log bytes shown by `/bash-logs`; the file itself keeps everything. */
const LOG_VIEW_BYTES = 200_000;

/** Command column of a `/bash-logs` row; the rest is fixed-width. */
const CHOICE_COMMAND_WIDTH = 48;

/**
 * One `/bash-logs` picker row, laid out in fixed columns so the list reads as a
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
 * Log text for the viewer. Reads at most the last `LOG_VIEW_BYTES` and says so,
 * so a huge log cannot stall the TUI.
 *
 * Throws the underlying fs error (e.g. ENOENT for a log the user deleted).
 */
export async function readLogForView(logPath: string, limit = LOG_VIEW_BYTES): Promise<string> {
  const handle = await fs.promises.open(logPath, "r");
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, limit);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const body = buffer.toString("utf8");
    if (length === size) return body;
    return `[mpi-bash] Showing the last ${length} of ${size} bytes. Full log: ${logPath}\n\n${body}`;
  } finally {
    await handle.close();
  }
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

  /** Running runs first (newest last), then finished ones. */
  list(): Array<DetachedStart | FinishedRun> {
    return [
      ...[...this.runs.values()].sort((a, b) => a.startedAt - b.startedAt),
      ...this.history,
    ];
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
      ctx.ui.setWidget(
        BACKGROUND_WIDGET_KEY,
        this.runs.size === 0 ? undefined : this.widget,
        { placement: "aboveEditor" },
      );
    } catch {
      // The captured context died with its session (replace/reload); stop
      // painting into it and let the next session_start rebind.
      this.ctx = undefined;
      this.stopTicker();
    }
  }
}
