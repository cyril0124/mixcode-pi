import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ContextUsageBreakdown, ContextUsageCategoryId } from "../../core/context-usage.js";
import { formatCompactTokenCount } from "../rendering/chrome.js";
import { renderWithTheme } from "../rendering/context.js";
import { overlayPanel } from "../rendering/primitives.js";
import type { MixCodeTheme } from "../themes.js";

const GRID_ROWS = 10;
/** Wide grid, matching the reference panel; narrow terminals use the compact width. */
const GRID_COLS_WIDE = 20;
const GRID_COLS_NARROW = 10;
/** Grid widths tried in order; the widest that fits the offered width wins. */
const GRID_COLUMN_CHOICES = [GRID_COLS_WIDE, GRID_COLS_NARROW, 0] as const;
/** Widest box the panel ever asks for; the overlay host still clamps it to the terminal. */
export const CONTEXT_PANEL_MAX_WIDTH = 96;
const GRID_GUTTER = "   ";
/** Hint names the only binding that closes the panel; Esc is handled by the app. */
const PANEL_HINT = "Esc/q close";

const CELL_CATEGORY = "⛁";
const CELL_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

/** Model label lines for the panel header; both are shown as the session reports them. */
export interface ContextUsagePanelInfo {
  modelName: string;
  modelId: string;
}

type CellStyler = (text: string) => string;

interface CellSpec {
  glyph: string;
  style: CellStyler;
}

/**
 * Legend colors per category. `messages` gets the brightest treatment because it
 * is the only category the user can shrink by compacting; free space stays dim
 * and the autocompact buffer shares the warning color with tool schemas, which
 * its distinct glyph separates.
 */
function categoryStyle(theme: MixCodeTheme): Record<ContextUsageCategoryId, CellStyler> {
  return {
    systemPrompt: theme.accent,
    projectContext: theme.muted,
    skills: theme.success,
    toolGuidelines: theme.done,
    toolSchemas: theme.warning,
    messages: theme.text,
  };
}

/**
 * Spread categories, buffer, and free space across the grid.
 *
 * Every nonzero category keeps at least one cell so a small-but-real category
 * stays visible; when rounding overflows the grid, cells are taken from the
 * largest categories first. Pure layout: the returned array is always exactly
 * `gridCols * GRID_ROWS` long.
 */
function planCells(
  breakdown: ContextUsageBreakdown,
  theme: MixCodeTheme,
  cellCount: number,
): CellSpec[] {
  const style = categoryStyle(theme);
  const cells: CellSpec[] = [];
  const push = (glyph: string, s: CellStyler, count: number) => {
    for (let i = 0; i < count; i++) cells.push({ glyph, style: s });
  };

  const window = breakdown.contextWindow;
  if (window <= 0) {
    push(CELL_FREE, theme.dim, cellCount);
    return cells;
  }

  const tokensPerCell = window / cellCount;
  const cellsFor = (tokens: number): number =>
    tokens <= 0 ? 0 : Math.max(1, Math.round(tokens / tokensPerCell));

  const counts = breakdown.categories.map((category) => ({
    id: category.id,
    count: cellsFor(category.tokens),
  }));
  let bufferCount = cellsFor(breakdown.autoCompactBufferTokens);
  let usedCount = counts.reduce((sum, entry) => sum + entry.count, 0);

  const maxUsable = cellCount - bufferCount;
  if (usedCount > maxUsable) {
    let overflow = usedCount - maxUsable;
    for (const entry of [...counts].sort((a, b) => b.count - a.count)) {
      while (overflow > 0 && entry.count > 1) {
        entry.count -= 1;
        overflow -= 1;
      }
    }
    usedCount = counts.reduce((sum, entry) => sum + entry.count, 0);
    if (usedCount + bufferCount > cellCount) {
      bufferCount = Math.max(0, cellCount - usedCount);
    }
  }

  for (const entry of counts) {
    push(entry.id === "messages" ? CELL_MESSAGES : CELL_CATEGORY, style[entry.id], entry.count);
  }
  push(CELL_FREE, theme.dim, Math.max(0, cellCount - cells.length - bufferCount));
  push(CELL_BUFFER, theme.warning, bufferCount);
  // Rounding may undershoot; pad so the grid is always a full rectangle.
  push(CELL_FREE, theme.dim, cellCount - cells.length);
  return cells.slice(0, cellCount);
}

/**
 * Legend/heading token label. Counts below 1000 read as plain numbers: `466
 * tokens` is legible where `0.47k tokens` is not. The status bar keeps its own
 * always-compact formatting, which the shared helper still provides.
 */
function tokenLabel(tokens: number): string {
  return tokens >= 1000 ? formatCompactTokenCount(tokens) : String(Math.round(tokens));
}

function percentText(part: number, whole: number): string {
  if (!(whole > 0)) return "0%";
  const percent = (part / whole) * 100;
  if (percent > 0 && percent < 0.05) return "<0.1%";
  return `${percent.toFixed(1)}%`;
}

/** Header and legend lines that sit to the right of the grid, top-aligned. */
function buildLegendLines(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
): string[] {
  const style = categoryStyle(theme);
  const windowLabel = formatCompactTokenCount(breakdown.contextWindow);
  const usedPercent = breakdown.anchored
    ? percentText(breakdown.usedTokens, breakdown.contextWindow)
    : "?";
  // A tilde marks a total the panel estimated instead of reading from the provider.
  // The total stays compact so it reads as `21.5k/1000k`, like the reference panel.
  const usedLabel = `${breakdown.anchored ? "" : "~"}${formatCompactTokenCount(breakdown.usedTokens)}`;

  const lines = [
    theme.bold(info.modelName) + theme.dim(` (${windowLabel} context)`),
    theme.muted(`${info.modelId}[${windowLabel}]`),
    `${theme.bold(usedLabel)}${theme.dim(`/${windowLabel} tokens`)}${theme.muted(` (${usedPercent})`)}`,
    "",
    theme.muted("Estimated usage by category"),
  ];

  // Every category the session has is listed, zero or not: a row that vanishes
  // reads as "this session has no skills" rather than "skills cost nothing".
  for (const category of breakdown.categories) {
    const glyph = category.id === "messages" ? CELL_MESSAGES : CELL_CATEGORY;
    lines.push(
      `${style[category.id](glyph)} ${category.label}: ${theme.bold(
        tokenLabel(category.tokens),
      )} ${theme.dim(`tokens (${percentText(category.tokens, breakdown.contextWindow)})`)}`,
    );
  }

  lines.push(
    `${theme.dim(CELL_FREE)} Free space: ${theme.bold(
      tokenLabel(breakdown.freeTokens),
    )} ${theme.dim(`(${percentText(breakdown.freeTokens, breakdown.contextWindow)})`)}`,
  );
  lines.push(
    `${theme.warning(CELL_BUFFER)} Autocompact buffer: ${theme.bold(
      tokenLabel(breakdown.autoCompactBufferTokens),
    )} ${theme.dim(`(${percentText(breakdown.autoCompactBufferTokens, breakdown.contextWindow)})`)}`,
  );

  lines.push("");
  lines.push(
    theme.dim(
      breakdown.anchored
        ? "Estimates; total from the last response."
        : "Estimates until the next response.",
    ),
  );
  return lines;
}

/**
 * Render the `/context` panel: the usage grid on the left, its legend on the right.
 *
 * Contract: pure formatting. Returns one string per terminal row; rows past the
 * grid height carry only legend text, indented to the legend column. Colors are
 * applied through `theme`, so the caller supplies the live UI theme.
 */
export function renderContextUsagePanel(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
  gridCols: number = GRID_COLS_WIDE,
): string {
  if (breakdown.contextWindow <= 0) {
    return theme.muted("Context usage is unavailable: no model is selected for this session.");
  }

  const legend = buildLegendLines(breakdown, info, theme);
  if (gridCols <= 0) {
    // Too narrow for a grid beside the legend: keep the numbers, drop the chart.
    return legend.map((line) => line.trimEnd()).join("\n");
  }

  const cells = planCells(breakdown, theme, gridCols * GRID_ROWS);
  const rows = Math.max(GRID_ROWS, legend.length);
  const gridRows = Array.from({ length: GRID_ROWS }, (_, row) =>
    cells
      .slice(row * gridCols, (row + 1) * gridCols)
      .map((cell) => cell.style(cell.glyph))
      .join(" "),
  );
  // Blank grid-column padding keeps legend rows past the grid aligned with it.
  const blank = " ".repeat(gridCols * 2 - 1);

  return Array.from({ length: rows }, (_, row) => {
    const gridSegment = gridRows[row] ?? blank;
    const legendSegment = legend[row] ?? "";
    return legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
  }).join("\n");
}

/** Box width this layout needs, or `Infinity` when it cannot fit the title. */
function boxWidthFor(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
  gridCols: number,
): number {
  if (breakdown.contextWindow <= 0) return Number.POSITIVE_INFINITY;
  const lines = panelBodyLines(breakdown, info, theme, gridCols);
  // Two border columns plus the leading pad each line already carries.
  return Math.max(...lines.map((line) => visibleWidth(line))) + 3;
}

/**
 * Pick the widest grid that fits `available` and report the box width to draw.
 *
 * Fitting is decided on the width actually offered, never on a width requested
 * elsewhere: a mismatch would size the overlay differently from the box and leave
 * a band of blank cells beside it.
 */
function layoutFor(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
  available: number,
): { gridCols: number; width: number } {
  for (const gridCols of GRID_COLUMN_CHOICES) {
    const width = boxWidthFor(breakdown, info, theme, gridCols);
    if (width <= available) return { gridCols, width };
  }
  // Nothing fits: keep the numbers, clamp to what there is.
  return { gridCols: 0, width: available };
}

/** Body rows of the box: a pad column, the grid/legend rows, then the close hint. */
function panelBodyLines(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
  gridCols: number,
): string[] {
  const body = renderContextUsagePanel(breakdown, info, theme, gridCols).split("\n");
  return [...body.map((line) => ` ${line}`), "", ` ${theme.dim(PANEL_HINT)}`];
}

/**
 * Exact width of the box this panel draws, clamped to `maxWidth`.
 *
 * The overlay host pads every line it renders to the width it was given, so the
 * overlay must be requested at exactly this width: a wider request leaves a band
 * of blank cells to the right of the box that erases the transcript behind it.
 */
export function contextUsageOverlayWidth(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
  maxWidth?: number,
): number {
  const available = maxWidth ?? CONTEXT_PANEL_MAX_WIDTH;
  if (breakdown.contextWindow <= 0) return Math.min(CONTEXT_PANEL_MAX_WIDTH, available);
  const { width } = layoutFor(breakdown, info, theme, available);
  return width;
}

/**
 * Render the panel as a bordered, opaque overlay box.
 *
 * The box carries the title and the close hint, and every row carries the
 * theme's background so the grid never sits on top of transcript text. Rows are
 * truncated to the width the host offers, so the host never replaces the right
 * border with its own overflow marker; `contextUsageOverlayWidth` supplies that
 * width.
 */
export function renderContextUsageOverlay(
  breakdown: ContextUsageBreakdown,
  info: ContextUsagePanelInfo,
  theme: MixCodeTheme,
  maxWidth?: number,
): string {
  const available = maxWidth ?? CONTEXT_PANEL_MAX_WIDTH;
  const { gridCols, width: boxWidth } = layoutFor(breakdown, info, theme, available);
  return renderWithTheme(theme, () =>
    overlayPanel("Context Usage", panelBodyLines(breakdown, info, theme, gridCols), boxWidth)
      .map((line) => truncateToWidth(line, boxWidth))
      .join("\n"),
  );
}
