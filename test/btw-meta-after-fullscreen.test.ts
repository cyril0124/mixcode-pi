import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeRuntime,
  createInitialState,
  createMixCodeTui,
  createTab,
} from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

/**
 * Records the physical cell grid. Needed because tui.render() can still contain
 * the model meta after a host TUI restart; the bug is that those rows are not
 * written back after MouseReportingTerminal.start() clears the screen.
 */
class ScreenTerminal implements Terminal {
  readonly columns: number;
  readonly rows: number;
  private cells: string[][];
  private saved: string[][] | undefined;
  private row = 0;
  private col = 0;
  fauxWriteCount = 0;

  constructor(columns = 80, rows = 24) {
    this.columns = columns;
    this.rows = rows;
    this.cells = this.blank();
  }

  start(): void {}
  stop(): void {}
  async drainInput(): Promise<void> {}
  get kittyProtocolActive(): boolean {
    return false;
  }
  hideCursor(): void {}
  showCursor(): void {}
  setTitle(): void {}
  setProgress(): void {}
  moveBy(lines: number): void {
    this.row = Math.max(0, Math.min(this.rows - 1, this.row + lines));
  }
  clearLine(): void {
    this.cells[this.row] = Array.from({ length: this.columns }, () => " ");
    this.col = 0;
  }
  clearFromCursor(): void {
    const line = this.cells[this.row]!;
    for (let x = this.col; x < this.columns; x += 1) line[x] = " ";
  }
  clearScreen(): void {
    this.cells = this.blank();
    this.row = 0;
    this.col = 0;
  }
  write(data: string): void {
    if (data.includes("faux-1")) this.fauxWriteCount += 1;
    this.paint(data);
  }
  snapshot(): string[] {
    return this.cells.map((line) => line.join("").replace(/\s+$/g, ""));
  }

  private blank(): string[][] {
    return Array.from({ length: this.rows }, () => Array.from({ length: this.columns }, () => " "));
  }

  private clone(cells: string[][]): string[][] {
    return cells.map((line) => [...line]);
  }

  private paint(data: string): void {
    const text = data.replace(/\x1b\[[?]?2026[hl]/g, "");
    let i = 0;
    while (i < text.length) {
      if (text.startsWith("\x1b[?1049h", i)) {
        this.saved = this.clone(this.cells);
        this.cells = this.blank();
        this.row = 0;
        this.col = 0;
        i += "\x1b[?1049h".length;
        continue;
      }
      if (text.startsWith("\x1b[?1049l", i)) {
        if (this.saved) this.cells = this.saved;
        this.saved = undefined;
        i += "\x1b[?1049l".length;
        continue;
      }
      if (text[i] === "\x1b" && text[i + 1] === "[") {
        const end = text.slice(i + 2).search(/[A-Za-z]/);
        if (end < 0) break;
        const body = text.slice(i + 2, i + 2 + end);
        const cmd = text[i + 2 + end]!;
        const n = Number(body.replace(/^\?/, "").split(";")[0] || "1");
        if (cmd === "J" && (body === "2" || body === "3")) this.clearScreen();
        else if (cmd === "H" || cmd === "f") {
          const [r, c] = body.split(";").map((part) => Number(part || "1"));
          this.row = Math.max(0, (r || 1) - 1);
          this.col = Math.max(0, (c || 1) - 1);
        } else if (cmd === "K") this.clearLine();
        else if (cmd === "A") this.row = Math.max(0, this.row - (Number.isFinite(n) ? n : 1));
        else if (cmd === "B")
          this.row = Math.min(this.rows - 1, this.row + (Number.isFinite(n) ? n : 1));
        else if (cmd === "C")
          this.col = Math.min(this.columns - 1, this.col + (Number.isFinite(n) ? n : 1));
        else if (cmd === "D") this.col = Math.max(0, this.col - (Number.isFinite(n) ? n : 1));
        i += 3 + end;
        continue;
      }
      if (text[i] === "\r") {
        this.col = 0;
        i += 1;
        continue;
      }
      if (text[i] === "\n") {
        this.row = Math.min(this.rows - 1, this.row + 1);
        this.col = 0;
        i += 1;
        continue;
      }
      const ch = text[i]!;
      if (ch === "\x1b") {
        i += 1;
        continue;
      }
      if (this.row >= 0 && this.row < this.rows && this.col >= 0 && this.col < this.columns) {
        this.cells[this.row]![this.col] = ch;
        this.col += 1;
      }
      i += 1;
    }
  }
}

function hasModelMeta(text: string): boolean {
  return /faux-1/.test(text);
}

const BTW_DRAFT = [
  "The following context was brought back from a /btw side discussion.",
  "",
  "<btw_context>",
  "User:",
  "what is the bug",
  "Assistant:",
  "stub editor text.",
  "</btw_context>",
].join("\n");

test("MixCode TUI start() clearScreen + renderNow(false) keeps the model meta row", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-btw-meta-restart-"));
  try {
    const screen = new ScreenTerminal(80, 24);
    const state = createInitialState(process.cwd());
    const tab = createTab(1, "s1", process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: screen });
    tui.start();
    tui.renderNow(true);
    assert.equal(hasModelMeta(screen.snapshot().join("\n")), true);
    assert.equal(hasModelMeta(stripAnsi(tui.render(80).join("\n"))), true);

    tui.stop();
    tui.start();
    tui.renderNow(false);

    assert.equal(hasModelMeta(stripAnsi(tui.render(80).join("\n"))), true, "layout still has meta");
    assert.equal(
      hasModelMeta(screen.snapshot().join("\n")),
      true,
      "physical screen must keep meta after stop/start/renderNow(false)",
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("fullscreen custom() teardown keeps model meta on the physical screen", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-btw-meta-fullscreen-"));
  const screen = new ScreenTerminal(80, 24);
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("btw-fullscreen-bring", {
      description: "Clone fullscreen custom() stop/start lifecycle",
      handler: async (_args, ctx) => {
        ctx.ui.setEditorText("old-draft");
        let live = ctx.ui.getEditorText();
        await ctx.ui.custom((parent, _theme, _keys, done) => {
          queueMicrotask(() => {
            parent.stop({ preserveScreen: true });
            const fullscreen = new TuiAltScreen(parent.terminal, parent.getShowHardwareCursor());
            fullscreen.start();
            ctx.ui.setEditorText(BTW_DRAFT);
            live = ctx.ui.getEditorText();
            fullscreen.stop({ preserveScreen: true });
            parent.start();
            parent.renderNow(false);
            done("ok");
          });
          return {
            render: () => ["Opening btw side thread…"],
            invalidate: () => undefined,
          };
        });
        if (ctx.ui.getEditorText() !== live) ctx.ui.setEditorText(live);
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab = createTab(1, "s1", process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: screen });
    tui.start();
    tui.renderNow(true);
    assert.equal(hasModelMeta(screen.snapshot().join("\n")), true);

    await runtime.prompt("s1", "/btw-fullscreen-bring");
    tui.renderNow(false);

    const rendered = stripAnsi(tui.render(80).join("\n"));
    assert.match(rendered, /btw_context/);
    assert.equal(hasModelMeta(rendered), true, "layout still has meta");
    assert.ok(screen.fauxWriteCount >= 2, "start() full paint must rewrite meta bytes");
    assert.equal(
      hasModelMeta(screen.snapshot().join("\n")),
      true,
      "physical screen must keep meta after fullscreen host restart",
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
