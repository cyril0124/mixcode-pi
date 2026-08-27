import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type DetachedStart, formatElapsed } from "./exec.js";
import { LogView, type LogViewTheme } from "./log-view.js";
import { type FinishedRun, hasEnded, readLogForView, reloadLogIfChanged } from "./widget.js";

/** Visible job rows; extra jobs scroll with j/k. */
const LIST_MAX = 6;
/** Overlay body as a fraction of the terminal height. */
const OVERLAY_RATIO = 0.6;
/** Floor so a short terminal still shows a usable preview. */
const PREVIEW_MIN = 8;
/** Top, rule, hint, foot rule, footer, bottom. */
const OVERLAY_CHROME = 6;
const FOLLOW_MS = 1000;
const RUNNING_DOT = "●";

export interface BashLogsOptions {
  theme: LogViewTheme & { bg?: Theme["bg"]; bold?: Theme["bold"] };
  list: () => Array<DetachedStart | FinishedRun>;
  requestRender: () => void;
  done: () => void;
  openExternal: (logPath: string) => void;
  kill: (run: DetachedStart | FinishedRun) => void;
  readLog?: (logPath: string) => Promise<string>;
  /** First selected log, already read so the first paint is not empty. */
  initialText?: string;
  /** 0 disables the follow timer. */
  followMs?: number;
  /** Terminal rows; preview height scales from this. */
  terminalRows?: () => number;
}

/**
 * Overlay: job list on top, log preview below.
 *
 * Preview height is `OVERLAY_RATIO` of the terminal, minus list and chrome,
 * and at least `PREVIEW_MIN` rows. `j`/`k` move the list; `J`/`K` scroll the
 * preview. `q`/`Esc` close. Kill confirmation is the log pane's `x`/`y` flow.
 */
export class BashLogs implements Component {
  private selectedId: number | undefined;
  private listOffset = 0;
  private log: LogView | undefined;
  private logKillable = false;
  private stamp = "";
  private inflight: Promise<void> = Promise.resolve();
  private gen = 0;
  private timer: ReturnType<typeof setInterval> | undefined;
  private closed = false;

  constructor(private readonly opts: BashLogsOptions) {
    const runs = opts.list();
    this.selectedId = runs[0]?.id;
    if (runs[0]) {
      this.attachLog(runs[0], opts.initialText ?? "");
      if (opts.initialText === undefined) this.queueLoad(runs[0]);
    }
    const followMs = opts.followMs ?? FOLLOW_MS;
    if (followMs > 0) {
      this.timer = setInterval(() => void this.tick(), followMs);
      this.timer.unref?.();
    }
  }

  /** Resolves when the selected log has been applied (or failed). */
  pending(): Promise<void> {
    return this.inflight;
  }

  invalidate(): void {}

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.opts.done();
  }

  handleInput(data: string): void {
    if (!this.log) {
      this.close();
      return;
    }
    if (this.log.isConfirmingKill()) {
      this.log.handleInput(data);
      return;
    }
    if (matchesKey(data, "j")) {
      this.moveSelection(1);
      return;
    }
    if (matchesKey(data, "k")) {
      this.moveSelection(-1);
      return;
    }
    if (matchesKey(data, "shift+j")) {
      this.log.scrollBy(1);
      this.opts.requestRender();
      return;
    }
    if (matchesKey(data, "shift+k")) {
      this.log.scrollBy(-1, false);
      this.opts.requestRender();
      return;
    }
    this.log.handleInput(data);
  }

  render(width: number): string[] {
    const runs = this.opts.list();
    this.syncSelection(runs);
    const inner = Math.max(8, width - 2);
    const listCount = Math.min(LIST_MAX, Math.max(1, runs.length));
    const previewHeight = this.previewRows(listCount);
    this.clampListOffset(runs.length, listCount);

    const t = this.opts.theme;
    const border = (text: string) => t.fg("border", text);
    const dim = (text: string) => t.fg("dim", text);
    const bold = (text: string) => t.bold?.(text) ?? text;
    const row = (line: string) => `${border("│")}${this.pad(line, inner)}${border("│")}`;
    const running = runs.filter((run) => !hasEnded(run)).length;
    const pane = this.log?.pane(inner) ?? {
      body: Array.from({ length: previewHeight }, () => ""),
      footer: dim(hintLine(inner, false)),
      range: "0 lines",
      following: false,
    };

    const visible = runs.slice(this.listOffset, this.listOffset + listCount);
    const listRows = Array.from({ length: listCount }, (_, offset) => {
      const run = visible[offset];
      if (!run) return row("");
      const selectedRow = run.id === this.selectedId;
      const line = formatListRow(run, inner, selectedRow, t);
      const innerLine = this.pad(line, inner);
      if (selectedRow && t.bg)
        return `${border("│")}${t.bg("selectedBg", innerLine)}${border("│")}`;
      return `${border("│")}${innerLine}${border("│")}`;
    });

    const preview = pane.body.slice(0, previewHeight);
    while (preview.length < previewHeight) preview.push("");
    const hint = pane.following
      ? `  ${t.fg("warning", "following")}  ${dim(pane.range)}  ${dim("(J/K scroll)")}`
      : `  ${dim(pane.range)}  ${dim("(J/K scroll)")}`;
    const footer = this.log?.isConfirmingKill()
      ? pane.footer
      : dim(hintLine(inner, this.logKillable));
    const head = ` ${dim(`${running}/${runs.length} running`)} ${border("──")} ${bold(t.fg("accent", "Bash logs"))} `;
    const headFill = border("─".repeat(Math.max(0, inner - visibleWidth(head))));

    return [
      `${border("╭")}${head}${headFill}${border("╮")}`,
      ...listRows,
      `${border("│")}${border("─".repeat(inner))}${border("│")}`,
      ...preview.map(row),
      row(truncateToWidth(hint, inner, "…")),
      `${border("├")}${border("─".repeat(inner))}${border("┤")}`,
      row(footer),
      `${border("╰")}${border("─".repeat(inner))}${border("╯")}`,
    ];
  }

  private syncSelection(runs: Array<DetachedStart | FinishedRun>): void {
    if (runs.length === 0) {
      this.selectedId = undefined;
      return;
    }
    if (!runs.some((run) => run.id === this.selectedId)) {
      this.selectedId = runs[Math.min(this.listOffset, runs.length - 1)]?.id;
    }
  }

  private moveSelection(delta: number): void {
    const runs = this.opts.list();
    if (runs.length === 0) return;
    const current = runs.findIndex((run) => run.id === this.selectedId);
    const next = (Math.max(0, current) + delta + runs.length) % runs.length;
    const run = runs[next];
    if (!run || run.id === this.selectedId) return;
    this.selectedId = run.id;
    const listCount = Math.min(LIST_MAX, runs.length);
    this.clampListOffset(runs.length, listCount);
    this.attachLog(run, "");
    this.queueLoad(run);
    this.opts.requestRender();
  }

  private previewRows(listCount: number): number {
    const rows = this.opts.terminalRows?.() ?? 32;
    return Math.max(PREVIEW_MIN, Math.floor(rows * OVERLAY_RATIO) - OVERLAY_CHROME - listCount);
  }

  private clampListOffset(total: number, visible: number): void {
    const index = Math.max(
      0,
      this.opts.list().findIndex((run) => run.id === this.selectedId),
    );
    if (index < this.listOffset) this.listOffset = index;
    else if (index >= this.listOffset + visible) this.listOffset = index - visible + 1;
    this.listOffset = Math.max(0, Math.min(this.listOffset, Math.max(0, total - visible)));
  }

  private attachLog(run: DetachedStart | FinishedRun, text: string): void {
    this.stamp = "";
    this.logKillable = !hasEnded(run);
    this.log = new LogView(
      this.opts.theme,
      run.logPath,
      text,
      this.opts.requestRender,
      () => this.close(),
      () => this.previewRows(Math.min(LIST_MAX, Math.max(1, this.opts.list().length))),
      () => {
        const path = run.logPath;
        this.close();
        this.opts.openExternal(path);
      },
      this.logKillable ? { pid: run.id, run: () => this.opts.kill(run) } : undefined,
    );
  }

  private queueLoad(run: DetachedStart | FinishedRun): void {
    const gen = ++this.gen;
    this.inflight = this.load(run, gen);
  }

  private async load(run: DetachedStart | FinishedRun, gen: number): Promise<void> {
    const read = this.opts.readLog ?? readLogForView;
    try {
      const text = await read(run.logPath);
      if (gen !== this.gen || this.closed) return;
      this.log?.setText(text);
    } catch (error) {
      if (gen !== this.gen || this.closed) return;
      this.log?.setText(`Cannot read ${run.logPath}: ${(error as Error).message}`);
    }
  }

  private async tick(): Promise<void> {
    const runs = this.opts.list();
    const run = runs.find((item) => item.id === this.selectedId);
    if (!run || this.closed) {
      this.opts.requestRender();
      return;
    }
    if (hasEnded(run)) {
      if (this.logKillable) {
        this.attachLog(run, "");
        this.queueLoad(run);
      }
      this.opts.requestRender();
      return;
    }
    let result: { text: string; stamp: string } | undefined;
    try {
      result = await reloadLogIfChanged(run.logPath, this.stamp);
    } catch {
      // ENOENT: the user deleted the log mid-run. Keep the last preview.
      this.opts.requestRender();
      return;
    }
    if (!result || this.closed || this.selectedId !== run.id) {
      this.opts.requestRender();
      return;
    }
    this.stamp = result.stamp;
    this.log?.setText(result.text);
  }

  private pad(text: string, width: number): string {
    const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}

function statusTone(run: DetachedStart | FinishedRun): "accent" | "success" | "error" | "warning" {
  if (!hasEnded(run)) return "accent";
  if (run.timedOut) return "warning";
  return run.exitCode === 0 ? "success" : "error";
}

function formatListRow(
  run: DetachedStart | FinishedRun,
  width: number,
  selected: boolean,
  theme: BashLogsOptions["theme"],
): string {
  const command = run.command.replace(/\s+/g, " ").trim();
  const [icon, state, elapsed] = hasEnded(run)
    ? [
        run.timedOut ? "⏱" : run.exitCode === 0 ? "✓" : "✗",
        run.timedOut ? "timeout" : `exit ${run.exitCode ?? "?"}`,
        formatElapsed(run.endedAt - run.startedAt),
      ]
    : [RUNNING_DOT, "running", formatElapsed(Date.now() - run.startedAt)];
  const tone = statusTone(run);
  const bold = (text: string) => theme.bold?.(text) ?? text;
  const marker = selected ? theme.fg("accent", "> ") : "  ";
  const left =
    `${marker}${theme.fg(tone, icon)} ${theme.fg(tone, state.padEnd(8))} ` +
    `${bold(theme.fg("accent", elapsed.padStart(6)))}  ${theme.fg("dim", `#${run.id}`)}  `;
  const cmd = theme.fg(
    "dim",
    truncateToWidth(command, Math.max(4, width - visibleWidth(left)), "…"),
  );
  return `${left}${cmd}`;
}

function hintLine(width: number, killable: boolean): string {
  const parts = [
    "j/k move",
    "J/K scroll",
    "g/G top/bot",
    "^e editor",
    ...(killable ? ["x kill"] : []),
    "q close",
  ];
  const line = () => `  ${parts.join("  ")}`;
  while (parts.length > 2 && visibleWidth(line()) > width) parts.splice(1, 1);
  return truncateToWidth(line(), width, "…");
}
