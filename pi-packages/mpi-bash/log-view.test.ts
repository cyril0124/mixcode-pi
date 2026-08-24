import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { LogView, openInExternalEditor, type SuspendableTui } from "./log-view.js";

const ROWS = 10;
const WIDTH = 40;

function view(lineCount = 100) {
  let closed = false;
  let renders = 0;
  let externals = 0;
  const text = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`).join("\n");
  const log = new LogView(
    { fg: (_color: string, value: string) => value } as never,
    "/tmp/mpi-bash-1.log",
    text,
    () => {
      renders++;
    },
    () => {
      closed = true;
    },
    () => ROWS,
    () => {
      externals++;
    },
  );
  /** Content rows only: the panel adds a header, a blank, a rule and a hint. */
  const body = () => log.render(WIDTH).slice(2, 2 + ROWS);
  return { log, body, isClosed: () => closed, renderCount: () => renders, externals: () => externals };
}

test("the viewer opens on the newest output", () => {
  const { log, body } = view();
  // A log is read for its tail: the pager must land there, like `less +F`.
  assert.match(body()[0] ?? "", /line 91\b/);
  assert.match(body().at(-1) ?? "", /line 100\b/);
  // Narrow panels shorten the word to a marker, so accept either spelling.
  assert.match(log.render(WIDTH)[0] ?? "", /(following|▼) 91-100\/100/);
});

test("the viewer scrolls with arrows and vim keys, and clamps at both ends", () => {
  const { log, body } = view();
  log.handleInput("g");
  assert.match(body()[0] ?? "", /line 1\b/);

  log.handleInput("j");
  assert.match(body()[0] ?? "", /line 2\b/);
  log.handleInput("k");
  assert.match(body()[0] ?? "", /line 1\b/);

  // Up at the top must not scroll into negative space.
  log.handleInput("k");
  assert.match(body()[0] ?? "", /line 1\b/);

  log.handleInput("\u0004"); // ctrl+d, half page
  assert.match(body()[0] ?? "", /line 6\b/);
  log.handleInput("\u0015"); // ctrl+u
  assert.match(body()[0] ?? "", /line 1\b/);

  log.handleInput("\u0006"); // ctrl+f, full page
  assert.match(body()[0] ?? "", /line 11\b/);
  log.handleInput("\u0002"); // ctrl+b
  assert.match(body()[0] ?? "", /line 1\b/);

  log.handleInput("G");
  // The last page ends on the final line, so the view stops at 91-100.
  assert.match(body()[0] ?? "", /line 91\b/);
  assert.match(body().at(-1) ?? "", /line 100\b/);

  // Down at the bottom must stay on the last page.
  log.handleInput("j");
  assert.match(body()[0] ?? "", /line 91\b/);
});

test("one k leaves the follow, even while the log keeps growing", () => {
  // Long lines wrap, so the wrapped line count differs from the raw one - the
  // case where deriving "am I at the bottom?" from a stale count breaks j/k.
  let closed = false;
  const line = (index: number) => `line ${index} ${"x".repeat(WIDTH * 2)}`;
  const text = (count: number) =>
    Array.from({ length: count }, (_, index) => line(index + 1)).join("\n");
  const log = new LogView(
    { fg: (_color: string, value: string) => value } as never,
    "/tmp/mpi-bash-1.log",
    text(40),
    () => {},
    () => {
      closed = true;
    },
    () => ROWS,
  );
  // Wrapped rows all look alike, so the header's range is the honest witness.
  const range = () => /(\d+)-(\d+)\/(\d+)/.exec(log.render(WIDTH)[0] ?? "")?.[0] ?? "";
  const header = () => log.render(WIDTH)[0] ?? "";

  assert.match(header(), /following|▼/);
  const atBottom = range();

  // A follow refresh lands between the render and the keypress, as the
  // one-second timer does in the TUI.
  log.setText(text(41));
  log.handleInput("k");

  assert.doesNotMatch(header(), /following|▼/, "one k must stop the follow");
  const [first, last, total] = range().split(/[-/]/).map(Number);
  const [, , previousTotal] = atBottom.split(/[-/]/).map(Number);
  assert.ok(total! > previousTotal!, "the refresh must have added lines");
  assert.equal(last, total! - 1, "one k must sit exactly one line above the end");
  assert.equal(last! - first! + 1, ROWS);
  assert.equal(closed, false);
});

test("a growing log follows the tail until the reader scrolls away", () => {
  const { log, body } = view(100);
  const grow = (count: number) =>
    log.setText(Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n"));

  grow(120);
  assert.match(body().at(-1) ?? "", /line 120\b/, "a following view must show new output");

  // Scrolling up parks the reader: later output must not yank the view away.
  log.handleInput("k");
  const parked = body()[0];
  assert.match(log.render(WIDTH)[0] ?? "", /\b110-119\/120/);
  grow(140);
  assert.equal(body()[0], parked, "a parked reader must keep their position");

  // Returning to the bottom resumes following.
  log.handleInput("G");
  grow(160);
  assert.match(body().at(-1) ?? "", /line 160\b/);
  assert.match(log.render(WIDTH)[0] ?? "", /(following|▼) 151-160\/160/);
});

test("the viewer closes on q and escape but never on typing", () => {
  const typed = view();
  typed.log.handleInput("h");
  typed.log.handleInput("x");
  typed.log.handleInput("\r");
  assert.equal(typed.isClosed(), false, "a read-only pager must not submit or close on text keys");

  const quit = view();
  quit.log.handleInput("q");
  assert.equal(quit.isClosed(), true);

  const escaped = view();
  escaped.log.handleInput("\u001b");
  assert.equal(escaped.isClosed(), true);
});

test("ctrl+e and v hand the log to the external editor", () => {
  const ctrlE = view();
  ctrlE.log.handleInput("\u0005");
  assert.equal(ctrlE.externals(), 1);

  const vim = view();
  vim.log.handleInput("v");
  assert.equal(vim.externals(), 1);
  // Handing over is not scrolling: the view must stay where it was.
  assert.match(vim.body()[0] ?? "", /line 91\b/);
});

test("the external editor runs on the log and the TUI always comes back", async () => {
  const logPath = path.join(os.tmpdir(), `mpi-bash-editor-${process.pid}.log`);
  fs.writeFileSync(logPath, "hello\n");
  const marker = path.join(os.tmpdir(), `mpi-bash-editor-${process.pid}.seen`);
  const fakeEditor = path.join(os.tmpdir(), `mpi-bash-editor-${process.pid}.sh`);
  const calls: string[] = [];
  const tui: SuspendableTui = {
    stop: () => calls.push("stop"),
    start: () => calls.push("start"),
    requestRender: () => calls.push("render"),
  };

  const previous = { visual: process.env.VISUAL, editor: process.env.EDITOR };
  delete process.env.VISUAL;
  try {
    // A fake editor that records the file it was handed. It has to be a real
    // executable: the command string is split on spaces, so quoting would not
    // survive (that split is what makes `EDITOR="code -w"` work).
    fs.writeFileSync(fakeEditor, `#!/bin/sh\ncp "$1" "${marker}"\n`, { mode: 0o755 });
    process.env.EDITOR = fakeEditor;
    assert.equal(await openInExternalEditor(tui, logPath), undefined);
    assert.equal(fs.readFileSync(marker, "utf8"), "hello\n", "the editor must receive the log file");
    assert.deepEqual(calls, ["stop", "start", "render"]);

    // A broken editor must still hand the terminal back, or the session freezes.
    calls.length = 0;
    process.env.EDITOR = "/definitely/not/an/editor";
    assert.match((await openInExternalEditor(tui, logPath)) ?? "", /Cannot run/);
    assert.deepEqual(calls, ["stop", "start", "render"]);

    calls.length = 0;
    delete process.env.EDITOR;
    assert.match((await openInExternalEditor(tui, logPath)) ?? "", /Set \$EDITOR/);
    assert.deepEqual(calls, [], "without an editor the TUI must not be stopped at all");
  } finally {
    if (previous.visual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previous.visual;
    if (previous.editor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previous.editor;
    fs.rmSync(logPath, { force: true });
    fs.rmSync(marker, { force: true });
    fs.rmSync(fakeEditor, { force: true });
  }
});

test("the viewer fills its panel and reports the visible range", () => {
  const { log } = view(100);
  const lines = log.render(WIDTH);

  assert.equal(lines.length, ROWS + 5, "header + blank + rows + rule + hint + bottom border");
  assert.ok(
    lines.every((line) => visibleWidth(line) === WIDTH),
    `every panel line must span the width: ${JSON.stringify(lines)}`,
  );
  assert.match(lines[0] ?? "", /91-100\/100/);
  // The key hints must survive narrow panels: closing the pager is the one
  // thing a user cannot guess from the content.
  for (const width of [40, 60, 80, 120]) {
    const hint = view(100).log.render(width).at(-2) ?? "";
    assert.match(hint, /q\/esc close/, `width ${width} dropped the close hint: ${hint}`);
    assert.ok(visibleWidth(hint) <= width, `width ${width} overflowed: ${hint}`);
  }

  // A log shorter than the viewport reports its size instead of a range, and
  // still pads to a stable panel height.
  const short = view(3);
  const shortLines = short.log.render(WIDTH);
  assert.match(shortLines[0] ?? "", /3 lines/);
  assert.equal(shortLines.length, ROWS + 5);
});

test("line numbers mark real lines and stay blank on wrapped continuations", () => {
  const directory = "/var/tmp/some-agent-tmpdir";
  const log = new LogView(
    { fg: (_color: string, value: string) => value } as never,
    `${directory}/mpi-bash-42.log`,
    ["short one", `long ${"y".repeat(60)}`, "short two"].join("\n"),
    () => {},
    () => {},
    () => 5,
  );
  const [header, , ...rows] = log.render(40);

  // The header carries the file name, not the whole tmp path.
  assert.match(header ?? "", /^\S* mpi-bash-42\.log · /);
  assert.doesNotMatch(header ?? "", new RegExp(directory));

  // Panel column layout: border, space, one-digit gutter, two spaces, text.
  const gutters = rows.slice(0, 5).map((row) => row.slice(2, 3).trim());
  // The long line spans three rows; only its first row carries a number.
  assert.deepEqual(gutters, ["1", "2", "", "", "3"], `wrapped rows must have no number: ${rows}`);
});
