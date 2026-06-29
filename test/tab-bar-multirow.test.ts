import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  renderTabBar,
  tabBarHitRegions,
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
