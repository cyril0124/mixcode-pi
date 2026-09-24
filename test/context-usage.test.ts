import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  type ContextUsageInput,
  type ContextUsageSection,
  computeContextUsage,
} from "../src/core/context-usage.js";
import {
  contextUsageOverlayWidth,
  renderContextUsageOverlay,
  renderContextUsagePanel,
} from "../src/ui/components/context-usage-panel.js";
import { MIXCODE_DARK_THEME as theme } from "../src/ui/themes.js";

const GRID_GLYPHS = ["⛁", "⛃", "⛶", "⛝"] as const;
const GRID_COLS = 20;
const GRID_ROWS = 10;
/** Grid segment width before the legend gutter: 20 cells joined by single spaces. */
const GRID_WIDTH = GRID_COLS * 2 - 1;

function sections(): ContextUsageSection[] {
  return [
    { name: "preamble", text: "p".repeat(400) },
    { name: "tools", text: "t".repeat(120) },
    { name: "docs", text: "d".repeat(80) },
    { name: "skills", text: "s".repeat(200) },
    {
      name: "project_context",
      text: '<project_instructions path="/repo/AGENTS.md">\nAGENTS\n</project_instructions>\n\n',
    },
    { name: "environment", text: "Current date: 2026-09-24\n" },
    { name: "extension_custom", text: "e".repeat(40) },
  ];
}

function input(overrides: Partial<ContextUsageInput> = {}): ContextUsageInput {
  return {
    contextWindow: 200_000,
    usedTokens: 100_000,
    anchored: true,
    sections: sections(),
    toolTexts: ["read", "r".repeat(400)],
    reserveTokens: 20_000,
    ...overrides,
  };
}

function tokensOf(breakdown: ReturnType<typeof computeContextUsage>, id: string): number {
  return breakdown.categories.find((category) => category.id === id)?.tokens ?? 0;
}

test("category totals follow the section keys and always sum to the anchored total", () => {
  const breakdown = computeContextUsage(input());
  const sum = breakdown.categories.reduce((total, category) => total + category.tokens, 0);

  assert.equal(breakdown.anchored, true);
  assert.equal(breakdown.usedTokens, 100_000);
  assert.equal(sum, breakdown.usedTokens);
  assert.ok(
    tokensOf(breakdown, "systemPrompt") > 0,
    "preamble/docs/extensions count as system prompt",
  );
  assert.ok(
    tokensOf(breakdown, "projectContext") > 0,
    "project_context and environment count as project context",
  );
  assert.ok(tokensOf(breakdown, "skills") > 0);
  assert.ok(tokensOf(breakdown, "toolGuidelines") > 0, "the `tools` section is tool guidelines");
  assert.ok(tokensOf(breakdown, "toolSchemas") > 0);
  assert.ok(tokensOf(breakdown, "messages") > 0, "messages are the anchored remainder");
  // Unknown section keys stay counted instead of vanishing from the legend.
  const withoutExtension = computeContextUsage(
    input({ sections: sections().filter((section) => section.name !== "extension_custom") }),
  );
  assert.equal(
    tokensOf(breakdown, "systemPrompt") - tokensOf(withoutExtension, "systemPrompt"),
    10,
  );
});

test("unknown provider count degrades to estimates without inventing messages", () => {
  const breakdown = computeContextUsage(input({ usedTokens: null, anchored: false }));
  const sum = breakdown.categories.reduce((total, category) => total + category.tokens, 0);

  assert.equal(breakdown.anchored, false);
  assert.equal(breakdown.usedTokens, sum);
  assert.equal(tokensOf(breakdown, "messages"), 0);
  assert.equal(
    breakdown.categories.some((category) => category.id === "messages"),
    false,
  );
  assert.ok(sum > 0);
});

test("estimates that overshoot the anchored total are scaled to fit", () => {
  const breakdown = computeContextUsage(input({ usedTokens: 50 }));
  const sum = breakdown.categories.reduce((total, category) => total + category.tokens, 0);

  assert.equal(sum, 50);
  assert.equal(tokensOf(breakdown, "messages"), 0);
  assert.ok(breakdown.categories.every((category) => category.tokens >= 0));
});

test("an unconfirmed SDK estimate is shown but not presented as provider-anchored", () => {
  // Before any response reports usage the SDK still returns a numeric estimate.
  const breakdown = computeContextUsage(input({ usedTokens: 100_000, anchored: false }));
  assert.equal(breakdown.anchored, false);
  assert.equal(breakdown.usedTokens, 100_000);
  assert.equal(tokensOf(breakdown, "messages") > 0, true);
  assert.equal(
    breakdown.categories.reduce((total, category) => total + category.tokens, 0),
    breakdown.usedTokens,
  );

  const plain = Bun.stripANSI(
    renderContextUsagePanel(breakdown, { modelName: "m", modelId: "m" }, theme),
  );
  assert.match(plain, /~100k\/200k tokens \(\?\)/);
  assert.match(plain, /Estimates until the next response\./);
});

test("buffer and free space always fill the window", () => {
  /** The Budget invariant documented on computeContextUsage. */
  const assertBudget = (breakdown: ReturnType<typeof computeContextUsage>) => {
    assert.equal(
      Math.min(breakdown.usedTokens, breakdown.contextWindow) +
        breakdown.autoCompactBufferTokens +
        breakdown.freeTokens,
      breakdown.contextWindow,
      `budget must fill the window: ${JSON.stringify(breakdown)}`,
    );
    assert.ok(breakdown.autoCompactBufferTokens >= 0);
    assert.ok(breakdown.freeTokens >= 0);
  };

  const breakdown = computeContextUsage(input());
  assert.equal(breakdown.autoCompactBufferTokens, 20_000);
  assert.equal(breakdown.freeTokens, 80_000);
  assertBudget(breakdown);

  // Reserve larger than the remaining headroom is clamped to what is left.
  const tight = computeContextUsage(input({ usedTokens: 195_000 }));
  assert.equal(tight.autoCompactBufferTokens, 5_000);
  assert.equal(tight.freeTokens, 0);
  assertBudget(tight);

  // Usage past the window (model switched to a smaller window) cannot go negative;
  // the anchored total legitimately exceeds the window there.
  const over = computeContextUsage(input({ usedTokens: 260_000 }));
  assert.equal(over.usedTokens, 260_000);
  assert.equal(over.autoCompactBufferTokens, 0);
  assert.equal(over.freeTokens, 0);
  assertBudget(over);

  // Compaction disabled passes reserve 0.
  const disabled = computeContextUsage(input({ reserveTokens: 0 }));
  assert.equal(disabled.autoCompactBufferTokens, 0);
  assert.equal(disabled.freeTokens, 100_000);
  assertBudget(disabled);

  // Unknown window: nothing to budget against.
  const unknownWindow = computeContextUsage(
    input({ contextWindow: 0, usedTokens: null, anchored: false }),
  );
  assert.equal(unknownWindow.autoCompactBufferTokens, 0);
  assert.equal(unknownWindow.freeTokens, 0);
  assertBudget(unknownWindow);

  // An unanchored numeric estimate budgets like an anchored one.
  const unanchored = computeContextUsage(input({ usedTokens: 195_000, anchored: false }));
  assert.equal(unanchored.autoCompactBufferTokens, 5_000);
  assert.equal(unanchored.freeTokens, 0);
  assertBudget(unanchored);
});

test("panel renders a full 20x10 grid plus the legend", () => {
  const breakdown = computeContextUsage(input());
  const lines = renderContextUsagePanel(
    breakdown,
    { modelName: "deepseek-flash", modelId: "deepseek-flash" },
    theme,
  ).split("\n");
  const plain = lines.map((line) => Bun.stripANSI(line));
  const gridRows = plain.slice(0, GRID_ROWS);

  assert.equal(lines.length >= GRID_ROWS, true);
  for (const row of gridRows) {
    const cells = [...row.slice(0, GRID_WIDTH)].filter((char) =>
      (GRID_GLYPHS as readonly string[]).includes(char),
    );
    assert.equal(
      cells.length,
      GRID_COLS,
      `grid row must hold ${GRID_COLS} cells: ${JSON.stringify(row)}`,
    );
  }
  const allCells = gridRows.flatMap((row) =>
    [...row.slice(0, GRID_WIDTH)].filter((char) =>
      (GRID_GLYPHS as readonly string[]).includes(char),
    ),
  );
  assert.equal(allCells.length, GRID_COLS * GRID_ROWS);

  const body = plain.join("\n");
  assert.match(body, /deepseek-flash \(200k context\)/);
  assert.match(body, /100k\/200k tokens \(50\.0%\)/);
  for (const label of [
    "System prompt:",
    "Project context:",
    "Skills:",
    "Tool guidelines:",
    "Tool schemas:",
    "Messages:",
    "Free space:",
    "Autocompact buffer:",
  ]) {
    assert.ok(body.includes(label), `legend is missing ${label}`);
  }
  assert.match(body, /Estimates; total from the last response\./);
});

test("panel marks an unknown total and reports a missing model", () => {
  const unknown = renderContextUsagePanel(
    computeContextUsage(input({ usedTokens: null, anchored: false })),
    { modelName: "deepseek-flash", modelId: "deepseek-flash" },
    theme,
  );
  const unknownPlain = Bun.stripANSI(unknown);
  assert.match(unknownPlain, /tokens \(\?\)/);
  // An estimated total is marked, so the header never reads as provider-reported.
  assert.match(unknownPlain, /~0\.\d+k\/200k tokens \(\?\)/);
  assert.equal(unknownPlain.includes("Messages:"), false);
  assert.match(unknownPlain, /Estimates until the next response\./);

  const unavailable = renderContextUsagePanel(
    computeContextUsage(input({ contextWindow: 0, usedTokens: null, anchored: false })),
    { modelName: "none", modelId: "none" },
    theme,
  );
  assert.match(Bun.stripANSI(unavailable), /Context usage is unavailable: no model is selected/);
});

test("a category with no tokens still gets a row", () => {
  // A missing row reads as "this session has no skills", not "skills are free".
  const breakdown = computeContextUsage(
    input({ sections: sections().filter((section) => section.name !== "skills") }),
  );
  assert.equal(breakdown.categories.find((category) => category.id === "skills")?.tokens, 0);
  const plain = Bun.stripANSI(
    renderContextUsagePanel(breakdown, { modelName: "m", modelId: "m" }, theme),
  );
  assert.match(plain, /⛁ Skills: 0 tokens \(0\.0%\)/);
});

test("the requested overlay width equals the box the panel draws", () => {
  // The host pads every line to the width it was asked for, so a request wider
  // than the box leaves a blank band beside it that erases the transcript.
  const labels = { modelName: "deepseek-flash", modelId: "deepseek-flash" };
  for (const offered of [96, 88, 86, 78, 68, 60]) {
    const width = contextUsageOverlayWidth(computeContextUsage(input()), labels, theme, offered);
    const rows = renderContextUsageOverlay(computeContextUsage(input()), labels, theme, offered)
      .split("\n")
      .map((line) => Bun.stripANSI(line));
    assert.ok(width <= offered, `width ${width} must fit the offered ${offered}`);
    assert.ok(
      rows.every((row) => visibleWidth(row) === width),
      `every row must be exactly the requested ${width} at offered ${offered}`,
    );
  }
  // 86 columns fit the wide grid once the layout is chosen from what is offered
  // (the mismatch bug drew a 10-column grid inside an 86-column overlay).
  const wide = renderContextUsageOverlay(computeContextUsage(input()), labels, theme, 86)
    .split("\n")
    .map((line) => Bun.stripANSI(line));
  const cells = [...(wide.find((row) => row.includes("System prompt")) ?? "")].filter((char) =>
    (GRID_GLYPHS as readonly string[]).includes(char),
  );
  assert.equal(cells.length, GRID_COLS + 1, "20 grid cells plus the legend's own glyph");
});

test("overlay wraps the panel in a titled, opaque box with a close hint", () => {
  const overlay = renderContextUsageOverlay(
    computeContextUsage(input()),
    { modelName: "deepseek-flash", modelId: "deepseek-flash" },
    theme,
  );
  const lines = overlay.split("\n");
  const plain = lines.map((line) => Bun.stripANSI(line));

  assert.match(plain[0] ?? "", /^┌ Context Usage ─+┐$/);
  assert.match(plain.at(-1) ?? "", /^└─+┘$/);
  assert.match(plain.at(-2) ?? "", /Esc\/q close\s*│$/);
  // Every body row carries a background, so no transcript text shows through.
  assert.ok(lines.slice(1, -1).every((line) => line.includes("\x1b[48;")));
  // Every body row is framed by the box, independent of its background.
  for (const row of plain.slice(1, -1)) {
    assert.ok(
      row.startsWith("│") && row.endsWith("│"),
      `body row must be framed: ${JSON.stringify(row)}`,
    );
  }
  const gridRow = plain.find((line) => line.includes("System prompt:")) ?? "";
  assert.ok(
    gridRow.startsWith("│ "),
    `row must be inset by the box padding: ${JSON.stringify(gridRow)}`,
  );
  assert.ok(
    gridRow.endsWith("│"),
    `row must close with the right border: ${JSON.stringify(gridRow)}`,
  );
  assert.ok(
    plain.every((line) => visibleWidth(line) === visibleWidth(plain[0] ?? "")),
    "every box row must have the same visible width",
  );

  // The host can offer less than the content needs; the box must shrink instead
  // of letting the host replace its border with an overflow marker, and the
  // legend keeps its numbers while the grid gives up columns.
  const narrow = renderContextUsageOverlay(
    computeContextUsage(input()),
    { modelName: "deepseek-flash", modelId: "deepseek-flash" },
    theme,
    60,
  );
  const narrowLines = narrow.split("\n");
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 60));
  const narrowPlain = narrowLines.map((line) => Bun.stripANSI(line));
  assert.match(narrowPlain.at(-2) ?? "", /Esc\/q close\s*│$/);
  const narrowGrid = narrowPlain.find((line) => line.includes("System prompt:")) ?? "";
  // 60 columns cannot hold a grid plus the legend, so the panel keeps the numbers
  // and drops the chart: the row is the legend entry alone, with no grid prefix.
  assert.ok(
    narrowGrid.startsWith("│ ⛁ System prompt:"),
    `narrow panel must drop the grid: ${JSON.stringify(narrowGrid)}`,
  );
  assert.match(narrowGrid, /System prompt: 130 tokens \(0\.1%\)/);
});
