import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  HOME_PIN_FULL_MAX_RATIO,
  renderTabBar,
  renderTabBarSeparator,
  tabBarHitRegions,
  tabBarMaxRows,
} from "./helpers/mixcode.js";
import type { OverlayTui } from "./helpers/mixcode.js";

const stripAnsi = (text: string): string =>
  // eslint-disable-next-line no-control-regex
  text.replace(/\x1b\[[0-9;]*m/g, "");

function manyTabState(count: number) {
  const state = createInitialState("/repo");
  for (let index = 1; index <= count; index++) {
    state.tabs.push(createTab(index, `s${index}`, "/repo", { title: `Agent-${index}` }));
  }
  state.activeTabId = "home";
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
  const width = 20;
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "VeryLongAgentTitleThatExceedsWidth" }));
  state.activeTabId = "s1";
  // Cap to one row: long titles clip, they must not wrap mid-title onto row 2.
  const lines = renderTabBar(state, width, undefined, 1).map(stripAnsi);
  assert.equal(lines.length, 1);
});

test("wrapped rows are indented to align under the first tab (after MixCode Home)", () => {
  const width = 40;
  const state = manyTabState(12);
  const lines = renderTabBar(state, width).map(stripAnsi);
  assert.ok(lines.length > 1);
  // Row 0 starts at column 0; later rows are indented (leading spaces).
  assert.notEqual(lines[1]?.match(/^ */)?.[0]?.length, 0);
});

test("first tab-bar row fills leftover space instead of reserving last-row … +N", () => {
  const width = 40;
  const state = manyTabState(16);
  state.activeTabId = "s1";
  const lines = renderTabBar(state, width, undefined, 2).map(stripAnsi);
  assert.ok(lines.length >= 2, `expected wrap, got: ${lines.join(" | ")}`);
  // Agent-3 must sit on row 0 when the first row still has a hole the size of `… +N`.
  assert.match(lines[0] ?? "", /Agent-3/);
  assert.doesNotMatch(lines[1] ?? "", /^\s*- Agent-3/);
});

test("pinned H keeps wrapped agent rows indented under the agent column", () => {
  // Force multi-row under a sliding window with compact Home pin.
  const width = 36;
  const state = manyTabState(16);
  state.activeTabId = "s12";
  // Enough rows for wrap, still capped so Home stays pinned (not inline).
  const lines = renderTabBar(state, width, undefined, 3).map(stripAnsi);
  assert.ok(lines.length > 1, `expected wrapped rows, got ${lines.length}: ${lines.join(" | ")}`);
  assert.match(lines[0] ?? "", /^ H /);
  const indent = lines[1]?.match(/^ */)?.[0]?.length ?? 0;
  assert.ok(indent > 0, `wrapped row must indent under agents, got: ${JSON.stringify(lines[1])}`);
  // Indent should clear the leading H chip (at least 3 cols for " H ").
  assert.ok(indent >= 3, `indent ${indent} should be >= home pin width`);
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
  assert.match(plain, /Agent-17/);
  assert.match(plain, /53\.4k\/500k\*/);
});

test("tab bar separator agentChrome can omit context when not overridden", () => {
  const plain = stripAnsi(
    renderTabBarSeparator(40, {
      agentChrome: { title: "Agent-17" },
    })[0]!,
  );
  assert.match(plain, /Agent-17/);
  assert.doesNotMatch(plain, /k\//);
});

test("tab bar capped to one row keeps active visible with right overflow hint", () => {
  const width = 40;
  const state = manyTabState(12);
  // Home active: full Home pin + agents from the start → right-side +R only.
  const lines = renderTabBar(state, width, undefined, 1).map(stripAnsi);
  assert.equal(lines.length, 1, "overflow must not add an extra row");
  assert.match(lines[0] ?? "", /MixCode Home/);
  assert.match(lines[0] ?? "", /… \+\d+/);
  assert.doesNotMatch(lines[0] ?? "", /^ H /);
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

test("sliding window: Home pin is independent of agent window", () => {
  const width = 40;
  const state = manyTabState(12);
  // total segments = Home + 12 agents = 13

  // Active near the end → compact H when full Home + agent window is too wide.
  state.activeTabId = "s12";
  const endLine = stripAnsi(renderTabBar(state, width, undefined, 1)[0] ?? "");
  assert.match(endLine, /Agent-12/);
  assert.ok(
    /^ H |MixCode Home/.test(endLine),
    `expected Home pin, got: ${endLine}`,
  );
  if (endLine.startsWith(" H ")) {
    // Gap outside the H chip: " H  +N …" not " H+N".
    assert.match(endLine, /^ H  \+\d+ …/);
    assert.doesNotMatch(endLine, / H\+/);
  }
  const endRegions = tabBarHitRegions(state, width, 1);
  assert.ok(endRegions.some((region) => region.id === "s12"));
  assert.ok(endRegions.some((region) => region.id === "home"), "Home pin must hit config");
  const endLeft = Number(endLine.match(/\+(\d+) …/)?.[1] ?? 0);
  const endRight = Number(endLine.match(/… \+(\d+)/)?.[1] ?? 0);
  // regions include Home pin + visible agents; +L/+R are agents only.
  assert.equal(endRegions.length + endLeft + endRight, 13);

  // Active at Home → full Home, only right overflow.
  state.activeTabId = "home";
  const homeLine = stripAnsi(renderTabBar(state, width, undefined, 1)[0] ?? "");
  assert.match(homeLine, /MixCode Home/);
  assert.doesNotMatch(homeLine, /^ H /);
  assert.match(homeLine, /… \+\d+/);
  const homeRegions = tabBarHitRegions(state, width, 1);
  assert.ok(homeRegions.some((region) => region.id === "home"));
  const homeRight = Number(homeLine.match(/… \+(\d+)/)?.[1] ?? 0);
  assert.equal(homeRegions.length + homeRight, 13);

  // Active in the middle: Home pin + active agent visible.
  state.activeTabId = "s6";
  const midLine = stripAnsi(renderTabBar(state, width, undefined, 1)[0] ?? "");
  assert.match(midLine, /Agent-6/);
  assert.ok(tabBarHitRegions(state, width, 1).some((region) => region.id === "s6"));
  assert.ok(tabBarHitRegions(state, width, 1).some((region) => region.id === "home"));
  const midLeft = Number(midLine.match(/\+(\d+) …/)?.[1] ?? 0);
  const midRight = Number(midLine.match(/… \+(\d+)/)?.[1] ?? 0);
  assert.equal(tabBarHitRegions(state, width, 1).length + midLeft + midRight, 13);
});

test("pinned Home uses full label only when chip width share is within 15%", () => {
  const state = manyTabState(12);
  state.activeTabId = "s8";
  // " MixCode Home " is 14 cols → needs width >= ceil(14 / 0.15) = 94 for full pin.
  const fullMinWidth = Math.ceil(14 / HOME_PIN_FULL_MAX_RATIO);
  assert.equal(HOME_PIN_FULL_MAX_RATIO, 0.15);

  const wide = stripAnsi(renderTabBar(state, fullMinWidth, undefined, 1)[0] ?? "");
  assert.match(wide, /MixCode Home/, `expected full Home at width ${fullMinWidth}, got: ${wide}`);
  assert.doesNotMatch(wide, /^ H /);

  const narrow = stripAnsi(renderTabBar(state, fullMinWidth - 1, undefined, 1)[0] ?? "");
  assert.match(narrow, /^ H /, `expected H when Home share > 15%, got: ${narrow}`);
  assert.doesNotMatch(narrow, /MixCode Home/);

  // On Home itself, always keep the full label for orientation.
  state.activeTabId = "home";
  const onHome = stripAnsi(renderTabBar(state, 40, undefined, 1)[0] ?? "");
  assert.match(onHome, /MixCode Home/);
});

test("pinned Home/H leaves a gutter before the first agent tab", () => {
  const state = manyTabState(12);
  state.activeTabId = "s8";
  const width = 80;
  const regions = tabBarHitRegions(state, width, 2);
  const home = regions.find((region) => region.id === "home");
  const firstAgent = regions.find((region) => region.id.startsWith("s") && (region.row ?? 0) === 0);
  assert.ok(home && firstAgent);
  assert.equal(
    firstAgent.startX,
    home.endX + 2,
    `expected one unstyled column between Home and first agent (home ${home.startX}-${home.endX}, agent ${firstAgent.startX})`,
  );
});

test("H home anchor click activates MixCode Home", () => {
  const width = 40;
  const state = manyTabState(12);
  state.activeTabId = "s12";
  state.tabBarTopRow = 1;
  // One visible tab-bar row so hit regions match the sliding-window layout.
  state.tabBarHitRow = 1;
  state.lastRenderWidth = width;
  const home = tabBarHitRegions(state, width, 1).find((region) => region.id === "home");
  assert.ok(home, "expected Home pin hit region for config");
  const y = (state.tabBarTopRow ?? 1) + (home.row ?? 0);
  const result = handleMixCodeKeyInput(
    state,
    `\x1b[<0;${home.startX};${y}M`,
    noopTui(),
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
});
