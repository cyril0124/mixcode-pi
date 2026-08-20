import assert from "node:assert/strict";
import { test } from "node:test";
import { buildLabeledTopBorder, isPlainBorderLine } from "../src/ui/components/editor-top-border.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

const identity = (s: string) => s;

function build(opts: {
  width: number;
  title: string;
  vimMode: boolean;
  zenMode?: boolean;
  customBasePrompt?: boolean;
}): string {
  return buildLabeledTopBorder({
    width: opts.width,
    title: opts.title,
    vimMode: opts.vimMode,
    zenMode: opts.zenMode,
    customBasePrompt: opts.customBasePrompt,
    dash: identity,
    vimLabel: identity,
    titleLabel: identity,
  });
}

test("normal mode embeds the title at the right end of the top border", () => {
  const line = stripAnsi(build({ width: 40, title: "Agent-1", vimMode: false }));
  assert.equal([...line].length, 40, "visible width must match the requested width");
  assert.match(line, /─ Agent-1 ──$/, "title sits at the right, flanked by dashes");
  assert.doesNotMatch(line, /VIM/, "no vim badge in normal mode");
  assert.ok(line.startsWith("─"), "left side is filled with dashes");
});

test("vim mode adds a [VIM] badge near the left and keeps the title", () => {
  const line = stripAnsi(build({ width: 40, title: "Agent-1", vimMode: true }));
  assert.equal([...line].length, 40, "visible width must match the requested width");
  assert.match(line, /^── \[VIM\] ─/, "vim badge sits after a short left margin");
  assert.match(line, /─ Agent-1 ──$/, "title still anchored to the right");
});

test("title is truncated with an ellipsis when the width is tight", () => {
  const line = stripAnsi(build({ width: 16, title: "VeryLongAgentName", vimMode: false }));
  assert.equal([...line].length, 16, "visible width must stay exact even when truncated");
  assert.match(line, /…/, "long title is truncated with an ellipsis");
});

test("vim badge is dropped (not the title) when width cannot fit both", () => {
  // Width fits the title but not the extra [VIM] badge -> badge omitted.
  const line = stripAnsi(build({ width: 14, title: "Agent-1", vimMode: true }));
  assert.equal([...line].length, 14, "visible width must match the requested width");
  assert.doesNotMatch(line, /VIM/, "vim badge is sacrificed before the title");
  assert.match(line, /Agent-1/, "title is preserved");
});

test("falls back to a plain border when too narrow for any label", () => {
  const line = stripAnsi(build({ width: 4, title: "Agent-1", vimMode: true }));
  assert.equal(line, "────", "degrades to a plain dashed border");
});

test("empty title yields a plain border", () => {
  const line = stripAnsi(build({ width: 20, title: "   ", vimMode: false }));
  assert.equal(line, "─".repeat(20), "blank title means no label");
});

test("colorizers are applied to their own segments", () => {
  const line = buildLabeledTopBorder({
    width: 40,
    title: "Agent-1",
    vimMode: true,
    dash: (s) => `<d>${s}</d>`,
    vimLabel: (s) => `<v>${s}</v>`,
    titleLabel: (s) => `<t>${s}</t>`,
  });
  assert.match(line, /<v>\[VIM\]<\/v>/, "vim label uses the vim colorizer");
  assert.match(line, /<t>Agent-1<\/t>/, "title uses the title colorizer");
  assert.match(line, /<d>─+<\/d>/, "dashes use the dash colorizer");
});

test("toggling vim off drops [VIM] but keeps the title", () => {
  // Mirrors the exit-vim transition: same title, vimMode flips false.
  const on = stripAnsi(build({ width: 40, title: "Agent-1", vimMode: true }));
  const off = stripAnsi(build({ width: 40, title: "Agent-1", vimMode: false }));
  assert.match(on, /VIM/, "badge present while in vim mode");
  assert.doesNotMatch(off, /VIM/, "badge gone after leaving vim mode");
  assert.match(off, /─ Agent-1 ──$/, "title preserved after leaving vim mode");
});

test("custom base prompt appends [sys] after the title on the right", () => {
  const line = stripAnsi(
    build({ width: 40, title: "reviewer", vimMode: false, customBasePrompt: true }),
  );
  assert.equal([...line].length, 40);
  assert.match(line, /─ reviewer \[sys\] ──$/, "[sys] sits after the title on the right");
  assert.doesNotMatch(line, /VIM/);
});

test("vim badge stays left while [sys] stays after the title", () => {
  const line = stripAnsi(
    build({ width: 48, title: "reviewer", vimMode: true, customBasePrompt: true }),
  );
  assert.equal([...line].length, 48);
  assert.match(line, /^── \[VIM\] /);
  assert.match(line, /─ reviewer \[sys\] ──$/);
});

test("without customBasePrompt no [sys] badge is shown", () => {
  const line = stripAnsi(build({ width: 40, title: "reviewer", vimMode: false }));
  assert.doesNotMatch(line, /\[sys\]/);
  assert.match(line, /─ reviewer ──$/);
});

test("isPlainBorderLine guards the scroll indicator and content lines", () => {
  // Plain dashed borders (optionally colored) are the only labelable lines.
  assert.equal(isPlainBorderLine("─".repeat(40)), true);
  assert.equal(isPlainBorderLine(`\x1b[38;2;1;2;3m${"─".repeat(40)}\x1b[39m`), true);
  // The editor's scroll indicator must never be clobbered.
  assert.equal(isPlainBorderLine("─── ↑ 3 more ──"), false);
  assert.equal(isPlainBorderLine("─── ↓ 5 more ──"), false);
  // Content / blank first lines are not borders.
  assert.equal(isPlainBorderLine("  hello"), false);
  assert.equal(isPlainBorderLine(""), false);
});
