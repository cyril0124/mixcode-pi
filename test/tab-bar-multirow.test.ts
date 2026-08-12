import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  renderTabBar,
  renderTabBarSeparator,
  tabBarHitRegions,
  tabBarMaxRows,
} from "../src/index.js";
import type { OverlayTui } from "../src/index.js";

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, "");

function manyTabState(count: number) {
  const state = createInitialState("/repo");
  for (let index = 1; index <= count; index++) {
    state.tabs.push(createTab(index, `s${index}`, "/repo", { title: `Agent-${index}` }));
  }
  state.activeTabId = "config";
  return state;
}

function noopTui(): OverlayTui {
  return { requestRender: () => {}, showOverlay: () => {} } as unknown as OverlayTui;
}

test("tab bar wraps onto multiple rows at narrow width without dropping any tab", () => {
  const width = 40;
  const state = manyTabState(12);
  const lines = renderTabBar(state, width);
  // Greedy wrap must produce more than one row when 12 tabs cannot fit in 40 cols.
  assert.ok(lines.length > 1, `expected multiple rows, got ${lines.length}`);
  // Every tab title must remain visible somewhere in the bar (no silent truncation).
  const joined = stripAnsi(lines.join("\n"));
  for (let index = 1; index <= 12; index++) {
    assert.match(joined, new RegExp(`Agent-${index}\\b`), `Agent-${index} missing`);
  }
  // No rendered row may exceed the requested width.
  for (const line of lines) {
    assert.ok(visibleWidth(line) <= width, `row wider than width: ${visibleWidth(line)}`);
  }
});

test("a single tab is never split across two rows", () => {
  const width = 40;
  const state = manyTabState(12);
  const regions = tabBarHitRegions(state, width);
  // Each region stays within a single row span (endX >= startX, fits the width).
  for (const region of regions) {
    assert.ok(region.endX >= region.startX);
    assert.ok(region.endX <= width, `region overflows width: ${region.endX}`);
    assert.equal(typeof region.row, "number");
  }
  // Wrapping must put later tabs on rows beyond the first.
  assert.ok(
    regions.some((region) => (region.row ?? 0) >= 1),
    "expected at least one region on a wrapped row",
  );
});

test("wrapped rows are indented to align under the first tab (after MixCode Home)", () => {
  const width = 46;
  const state = manyTabState(12);
  const regions = tabBarHitRegions(state, width);
  // Row 0: Home sits at the left edge (x=1); the first real tab starts after it.
  const home = regions.find((region) => region.id === "config");
  assert.ok(home && home.startX === 1, "Home tab must start at column 1");
  const firstTab = regions.find((region) => (region.row ?? 0) === 0 && region.id !== "config");
  assert.ok(firstTab, "need a first agent tab on row 0");
  const indent = firstTab.startX;
  assert.ok(indent > 1, "first tab must be indented past Home");
  // Every wrapped row's leading tab must start exactly under that first tab.
  const wrappedRows = new Set(
    regions.filter((region) => (region.row ?? 0) >= 1).map((region) => region.row),
  );
  assert.ok(wrappedRows.size >= 1, "expected wrapped rows");
  for (const row of wrappedRows) {
    const leading = regions
      .filter((region) => region.row === row)
      .sort((a, b) => a.startX - b.startX)[0]!;
    assert.equal(leading.startX, indent, `wrapped row ${row} not aligned under first tab`);
  }
  // The rendered wrapped lines must begin with whitespace up to the indent and
  // place their first tab glyph at the same column as row 0's first tab.
  const lines = renderTabBar(state, width).map(stripAnsi);
  const firstGlyphCol = (line: string): number => line.search(/\S/);
  const row0FirstTabCol = firstTab.startX - 1 + lines[0]!.slice(firstTab.startX - 1).search(/\S/);
  for (let row = 1; row < lines.length; row++) {
    assert.match(
      lines[row]!.slice(0, indent - 1),
      /^ *$/,
      `wrapped row ${row} leaked content into the indent`,
    );
    assert.equal(
      firstGlyphCol(lines[row]!),
      row0FirstTabCol,
      `wrapped row ${row} first glyph not aligned under row 0's first tab`,
    );
  }
});

test("clicking a tab on a wrapped (non-first) row activates it", () => {
  const width = 40;
  const state = manyTabState(12);
  // Simulate the render wiring that the mouse handler depends on.
  state.lastRenderWidth = width;
  state.tabBarTopRow = 1;
  const regions = tabBarHitRegions(state, width);
  const wrapped = regions.find((region) => (region.row ?? 0) >= 1 && region.id.startsWith("s"));
  assert.ok(wrapped, "need a wrapped agent tab region to click");
  const mouseY = (state.tabBarTopRow ?? 1) + (wrapped.row ?? 0);
  const result = handleMixCodeKeyInput(
    state,
    `\x1b[<0;${wrapped.startX};${mouseY}M`,
    noopTui(),
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, wrapped.id);
});

test("tab bar separator is a single full-width horizontal rule", () => {
  const width = 40;
  const lines = renderTabBarSeparator(width);
  // One row that fully spans the width with the box-drawing rule character.
  assert.equal(lines.length, 1);
  assert.equal(visibleWidth(lines[0]!), width);
  const bare = stripAnsi(lines[0]!);
  assert.equal(bare, "\u2500".repeat(width));
});

test("tab bar separator color tracks vim vs thinking-level border", () => {
  const width = 12;
  // Distinct editor-border states must yield distinct ANSI color sequences so
  // the rule visually matches the input editor's top/bottom border.
  const off = renderTabBarSeparator(width, { thinkingLevel: "off" })[0]!;
  const high = renderTabBarSeparator(width, { thinkingLevel: "high" })[0]!;
  const vim = renderTabBarSeparator(width, { vimMode: true })[0]!;
  assert.notEqual(off, high, "thinking level must change the rule color");
  assert.notEqual(off, vim, "vim mode must change the rule color");
  // Bare glyphs are identical regardless of color.
  assert.equal(stripAnsi(off), "\u2500".repeat(width));
  assert.equal(stripAnsi(vim), "\u2500".repeat(width));
});

test("tab bar separator agentChrome embeds title and optional override context", () => {
  const width = 48;
  const plain = stripAnsi(
    renderTabBarSeparator(width, {
      agentChrome: { title: "Agent-17", contextText: "53.4k/500k*" },
    })[0]!,
  );
  assert.equal(visibleWidth(plain), width);
  assert.match(plain, /Agent-17/);
  assert.match(plain, /53\.4k\/500k\*/);
});

test("tab bar separator agentChrome can omit context when not overridden", () => {
  const width = 40;
  const plain = stripAnsi(
    renderTabBarSeparator(width, {
      agentChrome: { title: "Agent-17" },
    })[0]!,
  );
  assert.match(plain, /Agent-17/);
  assert.doesNotMatch(plain, /k\//);
});

test("tab bar capped to one row keeps active visible with right overflow hint", () => {
  const width = 40;
  const state = manyTabState(12);
  // Home active: window anchors at the start → right-side +R only.
  const lines = renderTabBar(state, width, undefined, 1).map(stripAnsi);
  assert.equal(lines.length, 1, "overflow must not add an extra row");
  assert.match(lines[0] ?? "", /MixCode Home/);
  assert.match(lines[0] ?? "", /… \+\d+/);
  assert.doesNotMatch(lines[0] ?? "", /^\+\d+ …/);
  assert.doesNotMatch(lines[0] ?? "", /\+\d+ tabs/);
  assert.ok(visibleWidth(lines[0]!) <= width);
});

test("tabBarMaxRows takes the tighter of 10% terminal height and content cap", () => {
  // 40-row terminal → floor(4); content cap 3 wins.
  assert.equal(tabBarMaxRows(40, 3), 3);
  // Content cap looser than 10% → percent wins.
  assert.equal(tabBarMaxRows(40, 20), 4);
  // Never below 1.
  assert.equal(tabBarMaxRows(3, 0), 1);
  assert.equal(tabBarMaxRows(undefined, 4), 4);
  assert.equal(tabBarMaxRows(40, undefined), 4);
  assert.equal(tabBarMaxRows(undefined, undefined), undefined);
});

test("sliding window: active tab stays visible with left/right +N counts", () => {
  const width = 40;
  const state = manyTabState(12);
  // total segments = Home + 12 agents = 13

  // Active near the end → H anchor + left agent overflow; active still hit-testable.
  state.activeTabId = "s12";
  const endLine = stripAnsi(renderTabBar(state, width, undefined, 1)[0] ?? "");
  assert.match(endLine, /Agent-12/);
  assert.match(endLine, /^ H /);
  assert.match(endLine, /\+\d+ …/);
  const endRegions = tabBarHitRegions(state, width, 1);
  assert.ok(endRegions.some((region) => region.id === "s12"));
  assert.ok(endRegions.some((region) => region.id === "config"), "H must hit MixCode Home");
  const endLeft = Number(endLine.match(/\+(\d+) …/)?.[1] ?? 0);
  const endRight = Number(endLine.match(/… \+(\d+)/)?.[1] ?? 0);
  assert.ok(endLeft >= 1, "expected left agent overflow when active is last");
  // regions include H(config) + visible window tabs; +L is agents only; +R right hidden.
  assert.equal(endRegions.length + endLeft + endRight, 13);

  // Active at Home → full Home chip, only right overflow, no H stub.
  state.activeTabId = "config";
  const homeLine = stripAnsi(renderTabBar(state, width, undefined, 1)[0] ?? "");
  assert.match(homeLine, /MixCode Home/);
  assert.doesNotMatch(homeLine, /^ H /);
  assert.doesNotMatch(homeLine, /^\+\d+ …/);
  assert.match(homeLine, /… \+\d+/);
  const homeRegions = tabBarHitRegions(state, width, 1);
  assert.ok(homeRegions.some((region) => region.id === "config"));
  const homeRight = Number(homeLine.match(/… \+(\d+)/)?.[1] ?? 0);
  assert.equal(homeRegions.length + homeRight, 13);

  // Active in the middle: H when Home is off-window; active remains visible.
  state.activeTabId = "s6";
  const midLine = stripAnsi(renderTabBar(state, width, undefined, 1)[0] ?? "");
  assert.match(midLine, /Agent-6/);
  assert.match(midLine, /^ H /);
  assert.ok(tabBarHitRegions(state, width, 1).some((region) => region.id === "s6"));
  assert.ok(tabBarHitRegions(state, width, 1).some((region) => region.id === "config"));
  const midLeft = Number(midLine.match(/\+(\d+) …/)?.[1] ?? 0);
  const midRight = Number(midLine.match(/… \+(\d+)/)?.[1] ?? 0);
  assert.equal(tabBarHitRegions(state, width, 1).length + midLeft + midRight, 13);
});

test("H home anchor click activates MixCode Home", () => {
  const width = 40;
  const state = manyTabState(12);
  state.activeTabId = "s12";
  state.tabBarTopRow = 1;
  // One visible tab-bar row so hit regions match the sliding-window layout.
  state.tabBarHitRow = 1;
  state.lastRenderWidth = width;
  const home = tabBarHitRegions(state, width, 1).find((region) => region.id === "config");
  assert.ok(home, "expected H hit region for config");
  const y = (state.tabBarTopRow ?? 1) + (home.row ?? 0);
  const result = handleMixCodeKeyInput(
    state,
    `\x1b[<0;${home.startX};${y}M`,
    noopTui(),
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "config");
});
