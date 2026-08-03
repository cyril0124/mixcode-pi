import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { RuntimeTab } from "../../agent/runtime.js";
import { isPendingEscapeActive } from "../../core/escape.js";
import { gitBranchForWorkdir } from "../../core/git-branch.js";
import type { MouseHitRegion } from "../../core/mouse.js";
import { retryStatusMessage, tabHasPendingUserInteraction } from "../../core/tab-state.js";
import type { MixCodeState, MixCodeTabInfo } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { padLine, sanitizeTerminalText } from "./primitives.js";

const DEFAULT_WORKING_INDICATOR_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_WORKING_INDICATOR_INTERVAL_MS = 80;

export function renderHeader(width: number, theme: MixCodeTheme = activeRenderTheme): string[] {
  void width;
  void theme;
  return [];
}

export function renderExtensionHeader(tab: MixCodeTabInfo | undefined, width: number): string[] {
  const header = tab?.extensionUi.header;
  return renderExtensionComponentSlot(header?.render ? header.render(width) : header?.lines, width);
}

export function renderTabBar(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
  maxRows?: number,
): string[] {
  return renderWithTheme(theme, () => {
    const segments = tabBarSegments(state);
    const indent = wrappedRowIndent(segments, width);
    const packed = packTabRows(segments, width, indent);
    const { rows, hiddenCount } = limitTabRows(packed, maxRows);
    const lines = rows.map((row, rowIndex) => {
      const prefix = rowIndex === 0 ? "" : " ".repeat(indent);
      return activeRenderTheme.text(
        padLine(prefix + row.map((segment) => segment.text).join(" "), width),
      );
    });
    if (hiddenCount > 0) {
      lines.push(
        activeRenderTheme.dim(padLine(`${" ".repeat(indent)}… +${hiddenCount} tabs`, width)),
      );
    }
    return lines;
  });
}

/** Max unread-done dots shown on the zen separator before collapsing to [+N]. */
export const ZEN_DONE_DOT_CAP = 5;
const ZEN_DONE_DOT = "\u25cf"; // ●

/**
 * Full-width horizontal rule rendered directly under the tab bar (agent view
 * only), replacing the former blank interval row. Its color tracks the active
 * tab's input-editor border so the two read as one frame: vim mode uses
 * `vimBorder`, otherwise the thinking-level border (matching app-editor's
 * normal-mode `borderColor`). Shell mode is intentionally not tracked — it is
 * driven by transient editor text and would make this top rule flicker.
 * In zen mode, other agents' unreadDone count is left-anchored as ● dots
 * (space-separated, cap 5, then [+N]) so completions stay visible without the
 * tab bar. Dots / [+N] use theme.done (same green as tab-bar !); dashes keep
 * the frame color (vimBorder / thinking border).
 */
export function renderTabBarSeparator(
  width: number,
  options: {
    thinkingLevel?: string;
    vimMode?: boolean;
    zenMode?: boolean;
    /** Other agents with unreadDone (current tab excluded by the caller). */
    zenDoneCount?: number;
  } = {},
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => {
    const frame = options.vimMode
      ? activeRenderTheme.vimBorder
      : activeRenderTheme.thinkingBorder(options.thinkingLevel);
    const done = activeRenderTheme.done;
    const plain = () => [padLine(frame("\u2500".repeat(Math.max(0, width))), width)];
    if (width <= 0) return plain();
    if (options.zenMode !== true) return plain();
    const count = Math.max(0, options.zenDoneCount ?? 0);
    if (count === 0) return plain();

    const shown = Math.min(count, ZEN_DONE_DOT_CAP);
    const overflow = count - shown;
    const dots = Array.from({ length: shown }, () => ZEN_DONE_DOT).join(" ");
    // Prefer full "── ● ● [+N] "; drop [+N] then the cluster when width is tight.
    // Measure on bare text; paint frame dashes and done-colored markers separately.
    const bareWithOverflow =
      overflow > 0 ? `\u2500\u2500 ${dots} [+${overflow}] ` : `\u2500\u2500 ${dots} `;
    const bareWithoutOverflow = `\u2500\u2500 ${dots} `;
    let bareLeft = bareWithOverflow;
    let includeOverflow = overflow > 0;
    if (visibleWidth(bareLeft) > width) {
      bareLeft = bareWithoutOverflow;
      includeOverflow = false;
    }
    if (visibleWidth(bareLeft) > width) return plain();
    const fill = Math.max(0, width - visibleWidth(bareLeft));
    const marker =
      done(dots) + (includeOverflow ? ` ${done(`[+${overflow}]`)}` : "");
    const painted = `${frame("\u2500\u2500")} ${marker} ${frame("\u2500".repeat(fill))}`;
    return [padLine(painted, width)];
  });
}

/** Count other tabs' unreadDone for the zen separator (excludes active agent). */
export function zenUnreadDoneCount(
  tabs: ReadonlyArray<{ sessionId: string; unreadDone: boolean }>,
  activeSessionId: string | undefined,
): number {
  return tabs.filter((tab) => tab.unreadDone && tab.sessionId !== activeSessionId).length;
}

export function tabBarHitRegions(
  state: MixCodeState,
  width = Number.POSITIVE_INFINITY,
  maxRows?: number,
): MouseHitRegion[] {
  const segments = tabBarSegments(state);
  const indent = wrappedRowIndent(segments, width);
  const regions: MouseHitRegion[] = [];
  const packed = packTabRows(segments, width, indent);
  const { rows } = limitTabRows(packed, maxRows);
  rows.forEach((row, rowIndex) => {
    // Wrapped rows start under the first tab (after "MixCode Home"); the first
    // row starts at the left edge.
    let cursor = rowIndex === 0 ? 1 : indent + 1;
    for (const segment of row) {
      const startX = cursor;
      const endX = cursor + visibleWidth(segment.text) - 1;
      cursor = endX + 2;
      regions.push({ id: segment.id, startX, endX, row: rowIndex });
    }
  });
  return regions;
}

type TabSegment = { id: string; text: string };

function limitTabRows(
  rows: TabSegment[][],
  maxRows: number | undefined,
): { rows: TabSegment[][]; hiddenCount: number } {
  if (maxRows === undefined || !Number.isFinite(maxRows) || rows.length <= maxRows) {
    return { rows, hiddenCount: 0 };
  }
  const limit = Math.max(1, Math.floor(maxRows));
  // Always keep the first row of tabs visible, then report the rest. limit === 1
  // must not short-circuit hiddenCount to 0: at small terminal heights the
  // layout caps the tab bar to one row, and silently dropping every other tab
  // (no "… +N tabs" hint) makes open sessions undiscoverable.
  const visibleCount = Math.max(1, limit - 1);
  const visibleRows = rows.slice(0, visibleCount);
  const hiddenCount = rows.slice(visibleCount).reduce((count, row) => count + row.length, 0);
  return { rows: visibleRows, hiddenCount };
}

/**
 * Left indent for wrapped tab rows so they align under the first tab, i.e. just
 * past the leading "MixCode Home" segment plus its separator space. Clamped to
 * leave at least one column of budget so wrapped rows always render a tab.
 */
function wrappedRowIndent(segments: TabSegment[], width: number): number {
  if (segments.length === 0) return 0;
  const homeWidth = visibleWidth(segments[0]!.text);
  if (!Number.isFinite(width)) return homeWidth + 1;
  return Math.max(0, Math.min(homeWidth + 1, width - 1));
}

/**
 * Greedily pack tab segments into rows that each fit within `width`, keeping
 * every tab whole (never split across rows). Segments are separated by a single
 * space, matching the single-row layout. Row 0 uses the full width; wrapped rows
 * use `width - indent` because they render with a leading indent that aligns
 * them under the first tab. A row always holds at least one segment, so an
 * over-wide tab still renders (clipped by padLine) rather than being dropped.
 * With an infinite width this collapses to one row.
 */
function packTabRows(segments: TabSegment[], width: number, indent: number): TabSegment[][] {
  const rows: TabSegment[][] = [];
  let current: TabSegment[] = [];
  let currentWidth = 0;
  // Budget for the row currently being built: full width for row 0, reduced by
  // the indent for wrapped rows.
  const budgetFor = (rowIndex: number): number => (rowIndex === 0 ? width : width - indent);
  for (const segment of segments) {
    const segWidth = visibleWidth(segment.text);
    // Width this segment adds when appended to a non-empty row includes a
    // leading separator space; the first segment of a row adds only its width.
    const wouldAdd = current.length === 0 ? segWidth : segWidth + 1;
    if (current.length > 0 && currentWidth + wouldAdd > budgetFor(rows.length)) {
      rows.push(current);
      current = [];
      currentWidth = 0;
    }
    currentWidth += current.length === 0 ? segWidth : segWidth + 1;
    current.push(segment);
  }
  if (current.length > 0) rows.push(current);
  return rows.length > 0 ? rows : [[]];
}

export function renderStatus(
  tab: MixCodeTabInfo | undefined,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderStatusInner(tab, width));
}

function renderStatusInner(tab: MixCodeTabInfo | undefined, width: number): string[] {
  if (!tab) return [padLine(activeRenderTheme.dim("MixCode Home | no active agent"), width)];
  return [];
}

function renderCompactContextUsage(tab: MixCodeTabInfo): string {
  const tokens = tab.currentContextTokens;
  const limit = tab.contextLimit;
  const overrideMark = tab.contextLimitOverridden ? "*" : "";
  if (tokens === undefined) return `?/${formatCompactTokenCount(limit)}${overrideMark}`;
  const percent =
    limit > 0 ? Math.min(999, Math.max(0, Math.round((tokens / limit) * 100))) : undefined;
  const text =
    percent === undefined
      ? `${formatCompactTokenCount(tokens)}/${formatCompactTokenCount(limit)}${overrideMark}`
      : `${formatCompactTokenCount(tokens)}/${formatCompactTokenCount(limit)}${overrideMark} (${percent}%)`;
  if (percent === undefined) return text;
  if (percent >= 80) return activeRenderTheme.danger(text);
  if (percent >= 50) return activeRenderTheme.accent(text);
  return activeRenderTheme.success(text);
}

function formatCompactTokenCount(tokens: number): string {
  const value = tokens / 1_000;
  if (Number.isInteger(value)) return `${value.toFixed(0)}k`;
  return `${tokens < 10_000 ? value.toFixed(2) : value.toFixed(1)}k`;
}

export function renderSidebar(
  tab: MixCodeTabInfo,
  width: number,
  runtimeTab?: RuntimeTab,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderSidebarInner(tab, width, runtimeTab));
}

export function renderSidebarInner(
  tab: MixCodeTabInfo,
  width: number,
  runtimeTab?: RuntimeTab,
): string[] {
  void tab;
  void width;
  void runtimeTab;
  return [];
}

export function renderInputMeta(
  tab: MixCodeTabInfo,
  width: number,
  row = 0,
  theme: MixCodeTheme = activeRenderTheme,
  updateHitRegions = true,
): string[] {
  return renderWithTheme(theme, () => renderInputMetaInner(tab, width, row, updateHitRegions));
}

function renderInputMetaInner(
  tab: MixCodeTabInfo,
  width: number,
  row = 0,
  updateHitRegions = true,
): string[] {
  const lineWidth = Math.max(0, width - 1);
  // Same window as VIM_ENTER_ARM_WINDOW_MS in app-input (Ctrl+U → u/Ctrl+U).
  const vimEnterArmed =
    typeof tab.vimEnterArmedAt === "number" && Date.now() - tab.vimEnterArmedAt <= 1_000;
  const escapeHint = isPendingEscapeActive(tab, "abort-agent")
    ? " | Esc again: stop"
    : tab.lastEscapeTime && Date.now() - tab.lastEscapeTime < 500
      ? " | Esc again: tree"
      : vimEnterArmed
        ? " | u/Ctrl+U: vim"
        : "";
  const model = tab.model.displayName || "-";
  const thinking = tab.thinkingLevel[0]!.toUpperCase() + tab.thinkingLevel.slice(1);
  const contextBadge = ` ${renderCompactContextUsage(tab)} `;
  const right = chooseInputMetaRight(contextBadge, lineWidth, [
    () => {
      const gitBadge = `  ${gitBranchForWorkdir(tab.workdir) || "-"} `;
      const git = activeRenderTheme.accent(activeRenderTheme.bold(gitBadge));
      return `${contextBadge} ${git}`;
    },
    () => contextBadge,
  ]);
  const leftBudget = Math.max(0, lineWidth - visibleWidth(right) - 1);
  const left = renderInputMetaLeft(tab.workdir, model, thinking, escapeHint, leftBudget);
  const gap = Math.max(1, lineWidth - visibleWidth(left.text) - visibleWidth(right));
  const metaRow =
    visibleWidth(left.text) + visibleWidth(right) + 1 <= lineWidth
      ? `${left.text}${" ".repeat(gap)}${right}`
      : `${left.text} ${right}`;
  if (updateHitRegions) {
    tab.inputMetaHitRegions = left.regions.map((region) => ({ ...region, row }));
  }
  const lines = [padLine(metaRow, lineWidth)];
  // In vim mode the input area is read-only; hide the extension status line
  // (e.g. pi-subagents) so its row is reclaimed by the chat surface. The
  // first meta row (model/thinking/workdir/context/git) is kept.
  const extLine = tab.vimMode ? undefined : buildExtensionStatusLine(tab, Math.max(0, width - 1));
  if (extLine) lines.push(extLine);
  return lines;
}

function renderInputMetaLeft(
  workdirPath: string,
  model: string,
  thinking: string,
  escapeHint: string,
  width: number,
): {
  text: string;
  regions: Array<{ action: "models" | "thinking" | "workdir"; startX: number; endX: number }>;
} {
  if (width <= 0) return { text: "", regions: [] };
  const pieces: Array<{ action?: "models" | "thinking" | "workdir"; text: string }> = [];
  let remaining = Math.max(0, width - 2);
  const escapeText = escapeHint ? activeRenderTheme.dim(escapeHint) : "";
  const escapeWidth = visibleWidth(escapeText);
  const thinkingText = ` ✦ ${thinking} `;
  const thinkingWidth = visibleWidth(thinkingText);
  const modelFullWidth = visibleWidth(` 󰚩 ${model} `);
  const fixedWidth = thinkingWidth + escapeWidth + (escapeText ? 1 : 0);
  const modelWidth = Math.max(5, Math.min(modelFullWidth, remaining - fixedWidth));
  const modelText = truncateToWidth(` 󰚩 ${model} `, modelWidth, "...");
  pieces.push({
    action: "models",
    text: activeRenderTheme.accent(activeRenderTheme.bold(modelText)),
  });
  remaining -= visibleWidth(modelText);
  if (remaining >= thinkingWidth + escapeWidth + (escapeText ? 1 : 0)) {
    pieces.push({ text: "  " });
    pieces.push({
      action: "thinking",
      text: activeRenderTheme.accent(activeRenderTheme.bold(thinkingText)),
    });
    remaining -= 2 + thinkingWidth;
  }
  const escapeGap = escapeText ? 1 + escapeWidth : 0;
  const workdirBudget = Math.max(0, remaining - escapeGap - 2);
  if (workdirBudget >= 4) {
    pieces.push({ text: "  " });
    const workdir = compactWorkdir(shortWorkdir(workdirPath), workdirBudget);
    pieces.push({ action: "workdir", text: activeRenderTheme.accent(workdir) });
    remaining -= 2 + visibleWidth(workdir);
  }
  if (escapeText && remaining >= escapeGap) {
    pieces.push({ text: " " });
    pieces.push({ text: escapeText });
  }
  const regions: Array<{
    action: "models" | "thinking" | "workdir";
    startX: number;
    endX: number;
  }> = [];
  let cursor = 1;
  let text = "";
  for (const piece of pieces) {
    const pieceWidth = visibleWidth(piece.text);
    if (piece.action && pieceWidth > 0) {
      regions.push({ action: piece.action, startX: cursor, endX: cursor + pieceWidth - 1 });
    }
    text += piece.text;
    cursor += pieceWidth;
  }
  return { text, regions };
}

function chooseInputMetaRight(
  required: string,
  lineWidth: number,
  candidates: Array<() => string>,
): string {
  const minLeftWidth = 8;
  for (const candidate of candidates) {
    const text = candidate();
    if (visibleWidth(text) + minLeftWidth + 1 <= lineWidth) return text;
  }
  return visibleWidth(required) <= lineWidth ? required : truncateToWidth(required, lineWidth, "...");
}

export function renderWorkingIndicator(
  tab: MixCodeTabInfo,
  width: number,
  now = new Date(),
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderWorkingIndicatorInner(tab, width, now));
}

function renderWorkingIndicatorInner(
  tab: MixCodeTabInfo,
  width: number,
  now = new Date(),
): string[] {
  if (!tab.extensionUi.workingVisible) return [];
  if (tab.status !== "running" && tab.status !== "thinking") {
    if (tab.lastWorkedDurationSeconds === undefined) return [];
    const worked = ` Worked for ${formatDuration(tab.lastWorkedDurationSeconds)}`;
    const clock = formatClockTime(tab.lastWorkedAt);
    const text = clock ? `${worked} · at ${clock}` : worked;
    return [
      padLine(
        activeRenderTheme.dim(text),
        width,
      ),
    ];
  }
  const elapsed = formatElapsed(tab.workingStartedAt, now);
  const detail = isPendingEscapeActive(tab, "abort-agent", now.getTime())
    ? "esc again to interrupt"
    : "esc to interrupt";
  const message = tab.extensionUi.workingMessage?.trim() || "Working";
  const indicator = workingIndicatorFrame(tab, now);
  if (indicator === "") return [];
  const prefix = indicator ? `${indicator} ` : "";
  // During auto-retry, mirror Pi's countdown status line instead of the
  // generic working text; keep the same spinner + dim treatment.
  const retry = retryStatusMessage(tab, now);
  const body = retry ?? `${message} (${elapsed} • ${detail})`;
  return [padLine(`${prefix}${activeRenderTheme.dim(body)}`, width)];
}

function workingIndicatorFrame(tab: MixCodeTabInfo, now: Date): string | undefined {
  const frames = tab.extensionUi.workingIndicatorFrames;
  if (frames === undefined) {
    const startedAt = tab.workingStartedAt ? Date.parse(tab.workingStartedAt) : now.getTime();
    const elapsed = Math.max(
      0,
      now.getTime() - (Number.isFinite(startedAt) ? startedAt : now.getTime()),
    );
    return DEFAULT_WORKING_INDICATOR_FRAMES[
      Math.floor(elapsed / DEFAULT_WORKING_INDICATOR_INTERVAL_MS) %
        DEFAULT_WORKING_INDICATOR_FRAMES.length
    ];
  }
  if (frames.length === 0) return "";
  const interval = Math.max(
    1,
    tab.extensionUi.workingIndicatorIntervalMs ?? DEFAULT_WORKING_INDICATOR_INTERVAL_MS,
  );
  return frames[Math.floor(now.getTime() / interval) % frames.length] ?? "";
}

export function renderExtensionWidgets(
  tab: MixCodeTabInfo,
  width: number,
  placement: "aboveEditor" | "belowEditor",
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderExtensionWidgetsInner(tab, width, placement));
}

function renderExtensionWidgetsInner(
  tab: MixCodeTabInfo,
  width: number,
  placement: "aboveEditor" | "belowEditor",
): string[] {
  const widgets = tab.extensionUi.widgets.filter((widget) => widget.placement === placement);
  if (!widgets.length) return [];
  const lines: string[] = [];
  widgets.forEach((widget) => {
    const bodyWidth = Math.max(1, width - 2);
    const widgetLines =
      widget.render?.(bodyWidth) ?? wrapExtensionWidgetLines(widget.lines, bodyWidth);
    lines.push(...widgetLines.map((line) => renderSingleLineExtensionSlot(line, width)));
  });
  return lines;
}

function wrapExtensionWidgetLines(lines: string[], width: number): string[] {
  return lines.flatMap((line) => wrapTextWithAnsi(sanitizeWidgetLine(line), width));
}

// Fraction of terminal width given to the side panel when it is open.
const EXTENSION_PANEL_WIDTH_RATIO = 0.33;
const EXTENSION_PANEL_MIN_WIDTH = 30;

/**
 * Compute the side panel column width for a given terminal width. Clamped to a
 * usable minimum; callers gate opening on a wide-enough terminal so the chat
 * column is never crushed.
 */
export function extensionPanelWidth(terminalWidth: number): number {
  const target = Math.floor(terminalWidth * EXTENSION_PANEL_WIDTH_RATIO);
  return Math.max(EXTENSION_PANEL_MIN_WIDTH, target);
}

/**
 * Render the widget side panel: aboveEditor widgets stacked over belowEditor
 * widgets, separated by a blank row, framed with a left vertical border so it
 * reads as a distinct column. Content taller than the panel scrolls at
 * `tab.panelScrollOffset` (clamped here) with "↑ more"/"↓ more" markers on the
 * hidden edges. The final row is a dim hint on how to close the panel. The
 * returned rows are the raw rendered lines used for both display and mouse
 * text selection.
 */
export function renderExtensionPanel(
  tab: MixCodeTabInfo,
  panelWidth: number,
  panelHeight: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderExtensionPanelInner(tab, panelWidth, panelHeight));
}

// Dim footer hint telling the user how to dismiss the panel (Right toggles it).
const EXTENSION_PANEL_CLOSE_HINT = "\u2192 to close";
// Generous per-widget line budget for the scrolling panel: high enough that no
// real widget is truncated, so the panel's own scroll window is the only limit.
const EXTENSION_PANEL_WIDGET_LINE_BUDGET = 1000;

function renderExtensionPanelInner(
  tab: MixCodeTabInfo,
  panelWidth: number,
  panelHeight: number,
): string[] {
  const height = Math.max(0, Math.floor(panelHeight));
  if (height === 0 || panelWidth < 4) return [];
  // Border + one padding space on the left; body fills the rest.
  const bodyWidth = Math.max(1, panelWidth - 2);
  const border = activeRenderTheme.borderDim("\u2502");
  const blank = padLine(border, panelWidth);
  const ordered = [
    ...tab.extensionUi.widgets.filter((widget) => widget.placement === "aboveEditor"),
    ...tab.extensionUi.widgets.filter((widget) => widget.placement === "belowEditor"),
  ];
  // Reserve the bottom row for a dim close hint when there is room for at least
  // one content row above it; on a 1-row panel the content wins.
  const hasHint = height >= 2;
  const contentHeight = hasHint ? height - 1 : height;
  const content: string[] = [];
  ordered.forEach((widget, index) => {
    if (index > 0) content.push(blank);
    // The panel scrolls, so pass a generous line budget that no real widget
    // reaches; the scroll window below bounds what is actually shown.
    const widgetLines =
      widget.render?.(bodyWidth, EXTENSION_PANEL_WIDGET_LINE_BUDGET) ??
      wrapExtensionWidgetLines(widget.lines, bodyWidth);
    for (const line of widgetLines) {
      // Wrap (don't truncate) so wide widget lines keep all their content; the
      // panel scrolls, so extra wrapped rows are reachable. Empty lines wrap to
      // [] — emit a bordered blank so vertical spacing is preserved.
      const wrapped = wrapTextWithAnsi(sanitizeWidgetLine(line), bodyWidth);
      if (wrapped.length === 0) {
        content.push(blank);
        continue;
      }
      for (const part of wrapped) {
        content.push(padLine(`${border} ${part}`, panelWidth));
      }
    }
  });
  // Window the content to contentHeight rows at the (clamped) scroll offset.
  // Clamp here and write back so a roster shrink or resize can never strand the
  // offset past the end. "↑ more"/"↓ more" mark hidden rows above/below.
  const maxOffset = Math.max(0, content.length - contentHeight);
  const offset = Math.min(Math.max(0, Math.floor(tab.panelScrollOffset)), maxOffset);
  tab.panelScrollOffset = offset;
  let visible = content.slice(offset, offset + contentHeight);
  if (offset > 0 && visible.length > 0) {
    visible[0] = padLine(`${border} ${activeRenderTheme.dim("\u2191 more")}`, panelWidth);
  }
  if (offset < maxOffset && visible.length > 0) {
    visible[visible.length - 1] = padLine(`${border} ${activeRenderTheme.dim("\u2193 more")}`, panelWidth);
  }
  // Pad to full content height with border-only rows so the column stays rectangular.
  while (visible.length < contentHeight) visible.push(blank);
  if (hasHint) {
    const hint = truncateToWidth(EXTENSION_PANEL_CLOSE_HINT, bodyWidth, "...");
    visible.push(padLine(`${border} ${activeRenderTheme.dim(hint)}`, panelWidth));
  }
  return visible;
}

export function renderFooter(width: number): string[] {
  void width;
  return [];
}

export function renderExtensionFooter(tab: MixCodeTabInfo | undefined, width: number): string[] {
  const footer = tab?.extensionUi.footer;
  return renderExtensionComponentSlot(footer?.render ? footer.render(width) : footer?.lines, width);
}

// Build a pi-style extension status line: value-only, space-joined.
// Returns undefined when there are no statuses so the caller can collapse to
// single-line layout.
function buildExtensionStatusLine(
  tab: MixCodeTabInfo,
  width: number,
): string | undefined {
  const statuses = tab.extensionUi.statuses;
  if (!statuses.length) return undefined;
  const sorted = [...statuses].sort((a, b) => a.key.localeCompare(b.key));
  const text = sorted
    .map((status) => cleanStatusText(status.text))
    .filter((t) => t.trim())
    .join(` ${activeRenderTheme.dim("│")} `);
  if (!text) return undefined;
  return padLine(` ${text}`, width);
}

function renderExtensionComponentSlot(lines: string[] | undefined, width: number): string[] {
  if (!lines?.length) return [];
  return lines.map((line) => padLine(sanitizeWidgetLine(line), width));
}

function renderSingleLineExtensionSlot(line: string, width: number): string {
  const bodyWidth = Math.max(1, width - 2);
  const text = truncateToWidth(sanitizeWidgetLine(line), bodyWidth, "...");
  return padLine(` ${activeRenderTheme.dim(text)}`, width);
}

function cleanStatusText(text: string): string {
  // sanitizeTerminalText is ANSI-aware: it preserves SGR color sequences
  // (ESC + CSI ... m) and drops every other control char. A blanket strip of
  // 0x0e-0x1f here would delete the ESC (0x1b) byte and leak bare "[..m" tokens
  // into the status line, so collapse whitespace only after sanitizing.
  return sanitizeTerminalText(text)
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeWidgetLine(text: string): string {
  return sanitizeTerminalText(text)
    .replace(/[\r\n\t]+/g, " ")
    .trimEnd();
}

function tabBarSegments(state: MixCodeState): Array<{ id: string; text: string }> {
  const configText = " MixCode Home ";
  const isHomeActive = state.activeTabId === "config";
  const config = isHomeActive
    ? activeRenderTheme.homeTabActive(configText)
    : activeRenderTheme.homeTab(configText);
  return [
    { id: "config", text: config },
    ...state.tabs.map((tab) => {
      const status = tabStatusGlyph(tab);
      const text = ` ${status} ${tab.title} `;
      return {
        id: tab.sessionId,
        text: renderTabSegmentText(tab, text, state.activeTabId === tab.sessionId),
      };
    }),
  ];
}

function renderTabSegmentText(tab: MixCodeTabInfo, text: string, active: boolean): string {
  const statusColor = tabHasPendingUserInteraction(tab)
    ? activeRenderTheme.tool
    : tab.status === "running" || tab.status === "thinking"
      ? activeRenderTheme.accent
      : tab.status !== "error" && tab.unreadDone
        ? activeRenderTheme.done
        : undefined;
  const colored = statusColor ? statusColor(text) : text;
  return active ? activeRenderTheme.activeTab(colored) : activeRenderTheme.tab(colored);
}

export function tabStatusGlyph(tab: MixCodeTabInfo): string {
  if (tab.status === "Not Ready") return "◌";
  if (tab.status === "error") return "x";
  if (tabHasPendingUserInteraction(tab)) return "?";
  if (tab.status === "running" || tab.status === "thinking") return "*";
  if (tab.status === "done" || tab.unreadDone) return "!";
  return "-";
}

function shortWorkdir(workdir: string): string {
  const home = process.env.HOME;
  if (home && workdir.startsWith(home)) return `~${workdir.slice(home.length)}`;
  return workdir;
}

// Progressive left-to-right component compression: shrink directory components
// to their first character (dotfiles keep ".x") until the path fits maxWidth;
// the basename is never compressed. Falls back to "..." truncation when even
// the fully compressed path is too wide.
export function compactWorkdir(workdir: string, maxWidth: number): string {
  if (visibleWidth(workdir) <= maxWidth) return workdir;
  const segments = workdir.split("/");
  for (let index = 1; index < segments.length - 1; index++) {
    const segment = segments[index]!;
    if (segment.length > 1) {
      segments[index] = segment.startsWith(".") ? segment.slice(0, 2) : segment.slice(0, 1);
      if (visibleWidth(segments.join("/")) <= maxWidth) return segments.join("/");
    }
  }
  return truncateToWidth(segments.join("/"), maxWidth, "...");
}

function formatElapsed(startedAt: string | undefined, now: Date): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedSeconds = Number.isFinite(start)
    ? Math.max(0, Math.floor((now.getTime() - start) / 1000))
    : 0;
  return formatDuration(elapsedSeconds);
}

function formatDuration(elapsedSeconds: number): string {
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Format an ISO stamp as local `YYYY-MM-DD HH:MM:SS`; empty string if absent/invalid. */
function formatClockTime(iso: string | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
