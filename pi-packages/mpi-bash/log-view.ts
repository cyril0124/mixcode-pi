import { spawn } from "node:child_process";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

/** Theme surface used by the log viewer overlay. */
export type LogViewTheme = Pick<Theme, "fg">;

/** One rendered row: a log line, or a continuation of the one above it. */
interface LogRow {
  /** 1-based log line number; absent on continuation rows. */
  number: number | undefined;
  text: string;
}

/** The part of pi's TUI this pager drives while an external editor owns the tty. */
export interface SuspendableTui {
  stop(): void;
  start(): void;
  requestRender(force?: boolean): void;
}

/**
 * Open `filePath` in `$VISUAL`/`$EDITOR` on the inherited tty.
 *
 * Stops the TUI first and always restarts it, including when the editor cannot
 * be launched - leaving it stopped would freeze the session. Resolves with an
 * error message to show the user, or undefined on success.
 */
export async function openInExternalEditor(
  tui: SuspendableTui,
  filePath: string,
): Promise<string | undefined> {
  const editor = process.env.VISUAL || process.env.EDITOR;
  if (!editor) return "No external editor configured. Set $EDITOR or $VISUAL.";
  // Split so `EDITOR="code -w"` style commands keep their flags.
  const [command, ...args] = editor.split(" ").filter(Boolean);
  if (!command) return "No external editor configured. Set $EDITOR or $VISUAL.";

  tui.stop();
  try {
    const child = spawn(command, [...args, filePath], { stdio: "inherit" });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", () => resolve());
    });
    return undefined;
  } catch (error) {
    return `Cannot run ${editor}: ${(error as Error).message}`;
  } finally {
    tui.start();
    tui.requestRender(true);
  }
}

/**
 * Read-only pager for a background command's log.
 *
 * Contract: renders a bordered panel of `rows` content lines, scrolls with the
 * arrow/page keys, and calls `done` on escape or `q`. It never edits the log.
 * The only state it can change is whether the job is still running, via `x`.
 */
export class LogView implements Component {
  private scroll = 0;
  private lines: string[];
  /**
   * Armed by `x`, disarmed by the next keypress. Killing a job cannot be undone,
   * so it never happens on a single keystroke.
   */
  private confirmingKill = false;
  /**
   * Pinned to the end, like `less +F`: the pager opens on the newest output and
   * keeps following it until the reader scrolls away from the bottom.
   */
  private following = true;
  /** Wrapped rows cached per width; recomputed when the terminal resizes. */
  private wrapped: { width: number; lines: LogRow[] } | undefined;
  /** Last rendered width, so a refresh can rewrap without waiting for a render. */
  private lastWidth: number | undefined;

  constructor(
    private readonly theme: LogViewTheme,
    private readonly title: string,
    text: string,
    private readonly requestRender: () => void,
    private readonly done: () => void,
    private readonly getRows: () => number,
    /** Hands the log to `$EDITOR`; omitted only in tests that ignore that path. */
    private readonly openExternal: () => void = () => {},
    /** Kills the job, after confirmation. Absent when the run already ended. */
    private kill?: { pid: number; run: () => void },
  ) {
    this.lines = text.replace(/\n$/, "").split("\n");
  }

  invalidate(): void {}

  /**
   * Replace the contents with a fresh read of the log. Keeps the reader's
   * position unless the view is following, in which case it jumps to the new
   * end.
   */
  setText(text: string): void {
    this.lines = text.replace(/\n$/, "").split("\n");
    // A keypress can land before the next render, so the wrapped line count
    // has to be current the moment the text changes.
    this.wrapped = undefined;
    if (this.lastWidth !== undefined) this.wrap(this.lastWidth);
    if (this.following) this.scrollTo(Number.MAX_SAFE_INTEGER);
    this.requestRender();
  }

  /** Arrow/page keys plus the vim bindings a reader reaches for by reflex. */
  handleInput(data: string): void {
    const rows = this.rows();
    const half = Math.max(1, Math.floor(rows / 2));
    if (this.confirmingKill) {
      // Anything other than `y` cancels, including the keys that would
      // otherwise scroll or close, so a mistyped `x` costs one keystroke.
      this.confirmingKill = false;
      if (matchesKey(data, "y")) {
        this.kill?.run();
        // One kill per view. The pid is spent, so the offer goes with it.
        this.kill = undefined;
      }
      this.requestRender();
      return;
    }
    if (this.kill && matchesKey(data, "x")) {
      this.confirmingKill = true;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      this.done();
      return;
    }
    if (matchesKey(data, "ctrl+e") || matchesKey(data, "v")) {
      this.openExternal();
      return;
    }
    // Following is owned by the keys, never inferred from the scroll position:
    // any move away from the end stops it, only `G`/`End` resumes it.
    if (matchesKey(data, "down") || matchesKey(data, "j")) this.scrollBy(1);
    else if (matchesKey(data, "up") || matchesKey(data, "k")) this.scrollBy(-1, false);
    else if (matchesKey(data, "ctrl+d")) this.scrollBy(half);
    else if (matchesKey(data, "ctrl+u")) this.scrollBy(-half, false);
    else if (
      matchesKey(data, "pageDown") ||
      matchesKey(data, "space") ||
      matchesKey(data, "ctrl+f")
    ) {
      this.scrollBy(rows);
    } else if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+b"))
      this.scrollBy(-rows, false);
    else if (matchesKey(data, "home") || matchesKey(data, "g")) {
      this.following = false;
      this.scrollTo(0);
    } else if (matchesKey(data, "end") || matchesKey(data, "shift+g")) {
      this.following = true;
      this.scrollTo(Number.MAX_SAFE_INTEGER);
    } else return;
    this.requestRender();
  }

  /** True while `x` has armed a kill and the next key decides it. */
  isConfirmingKill(): boolean {
    return this.confirmingKill;
  }

  /** Scroll the log pane; `keepFollowing` is for down/page, not up. */
  scrollBy(delta: number, keepFollowing = true): void {
    if (!keepFollowing) this.following = false;
    this.scrollTo(this.scroll + delta);
  }

  /**
   * Chrome-free pane: headline, padded body, footer. `width` is the inner
   * content width. Body height is `getRows()`.
   */
  pane(width: number): {
    headline: string;
    body: string[];
    footer: string;
    range: string;
    following: boolean;
  } {
    const gutter = String(this.lines.length).length;
    const textWidth = Math.max(4, width - gutter - 4);
    const rows = this.wrap(textWidth);
    const height = this.rows();
    // Clamp here too: the viewport height follows the terminal, so a resize can
    // strand the scroll position past the end. Wrapping is width-dependent, so
    // this is also where a following view lands on the real last page.
    const bottom = Math.max(0, rows.length - height);
    this.scroll = this.following ? bottom : clamp(this.scroll, 0, bottom);
    const visible = rows.slice(this.scroll, this.scroll + height);
    const last = Math.min(rows.length, this.scroll + height);
    const range =
      rows.length > height ? `${this.scroll + 1}-${last}/${rows.length}` : `${rows.length} lines`;
    const body = [
      ...visible.map(
        ({ number, text }) =>
          ` ${this.theme.fg("dim", String(number ?? "").padStart(gutter))}  ${text}`,
      ),
      ...Array.from({ length: Math.max(0, height - visible.length) }, () => ""),
    ];
    return {
      headline: this.headline(width, range),
      body,
      footer: this.footer(width),
      range,
      following: this.following,
    };
  }

  render(width: number): string[] {
    const innerWidth = Math.max(8, width - 2);
    const { headline, body, footer } = this.pane(innerWidth);

    const border = (text: string) => this.theme.fg("border", text);
    const blank = `${border("│")}${" ".repeat(innerWidth)}${border("│")}`;
    const row = (line: string) => `${border("│")}${this.pad(line, innerWidth)}${border("│")}`;

    return [
      `${border("┌")}${border(this.pad(headline, innerWidth))}${border("┐")}`,
      blank,
      ...body.map((line) => row(line)),
      `${border("├")}${border("─".repeat(innerWidth))}${border("┤")}`,
      row(footer),
      `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
    ];
  }

  /** `─ name · status ────` - the file name and where the view sits in it. */
  private headline(innerWidth: number, range: string): string {
    const name = this.title.split("/").pop() || this.title;
    const follow = (text: string) => this.theme.fg("warning", text);
    // Richest first: the name outranks the status, so a narrow panel shortens
    // `following` to `▼`, then drops the range, and truncates the name last.
    const statuses = this.following
      ? [`${follow("following")} ${range}`, `${follow("▼")} ${range}`, follow("▼")]
      : [range, ""];
    const compose = (label: string, status: string) =>
      status
        ? ` ${this.theme.fg("accent", label)} · ${status} `
        : ` ${this.theme.fg("accent", label)} `;

    let head = "";
    for (const status of statuses) {
      const candidate = compose(name, status);
      if (visibleWidth(candidate) <= innerWidth) {
        head = candidate;
        break;
      }
      head = candidate;
    }
    if (visibleWidth(head) > innerWidth) {
      head = compose(truncateToWidth(name, Math.max(4, innerWidth - 2), "…"), "");
    }
    return `${head}${this.theme.fg("border", "─".repeat(Math.max(0, innerWidth - visibleWidth(head))))}`;
  }

  /** Key hints, or the kill confirmation while it is armed. */
  private footer(innerWidth: number): string {
    if (!this.confirmingKill) {
      return this.theme.fg("dim", hintLine(innerWidth, this.kill !== undefined));
    }
    // Richest phrasing that fits, like the headline. Even the shortest form
    // names the key that confirms.
    const pid = this.kill?.pid;
    const prompts = [
      `  kill job #${pid} and its children? y confirms, any other key cancels`,
      `  kill job #${pid}? y confirms, any other key cancels`,
      `  kill #${pid}? y/n`,
    ];
    // The last resort still names the key; a truncated prompt would hide it.
    const prompt = prompts.find((text) => visibleWidth(text) <= innerWidth) ?? " y/n";
    return this.theme.fg("error", truncateToWidth(prompt ?? "", innerWidth, "…"));
  }

  private rows(): number {
    return Math.max(3, this.getRows());
  }

  private scrollTo(target: number): void {
    const lines = this.wrapped?.lines.length ?? this.lines.length;
    this.scroll = clamp(target, 0, Math.max(0, lines - this.rows()));
  }

  /**
   * Rows for `width`, one per visual line. A log line too long for the panel
   * spans several rows; only the first carries the line number, so wrapping is
   * never mistaken for new output.
   */
  private wrap(width: number): LogRow[] {
    this.lastWidth = width;
    if (this.wrapped?.width !== width) {
      this.wrapped = {
        width,
        lines: this.lines.flatMap((line, index) =>
          (line ? wrapTextWithAnsi(line, width) : [""]).map((text, part) => ({
            number: part === 0 ? index + 1 : undefined,
            text,
          })),
        ),
      };
    }
    return this.wrapped.lines;
  }

  private pad(text: string, width: number): string {
    const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width, "…");
    return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Key hints trimmed to `width`. Narrow panels drop the middle hints first: the
 * scroll keys and the way out are the two a user cannot guess.
 */
function hintLine(width: number, killable: boolean): string {
  const parts = [
    "↑↓/jk scroll",
    "^d/^u half",
    "^f/^b page",
    "g/G top/bottom",
    "^e/v editor",
    ...(killable ? ["x kill"] : []),
    "q/esc close",
  ];
  const line = () => `  ${parts.join("  ")}`;
  while (parts.length > 2 && visibleWidth(line()) > width) parts.splice(1, 1);
  return truncateToWidth(line(), width, "…");
}
