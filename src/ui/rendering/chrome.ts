import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isPendingEscapeActive } from "../../core/escape.js";
import { gitBranchForWorkdir } from "../../core/git-branch.js";
import { recentAgentTabRank } from "../../core/tabs.js";
import {
  DEFAULT_ICON_MODE,
  type IconMode,
} from "../../core/mixcode-settings.js";
import type { MouseHitRegion } from "../../core/mouse.js";
import {
  retryStatusMessage,
  tabIsWaitingForInput,
  workingActivityMessage,
} from "../../core/tab-state.js";
import type { MixCodeState, MixCodeTabInfo } from "../../core/types.js";
import { buildLabeledTopBorder } from "../editor-top-border.js";
import type { MixCodeTheme } from "../themes.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { resolveGlyphs, type IconGlyphs } from "./icons.js";
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

/** Tab bar may use at most this fraction of the terminal height (rows). */
export const TAB_BAR_VIEWPORT_RATIO = 0.1;

/**
 * When the full "MixCode Home" chip would occupy more than this fraction of the
 * tab-bar width, pin the compact "H" stand-in instead.
 */
export const HOME_PIN_FULL_MAX_RATIO = 0.15;

/**
 * Row budget for the tab bar: min(floor(terminalRows * 10%), contentCap), at least 1.
 * Either input may be omitted; both omitted → unlimited (undefined).
 */
export function tabBarMaxRows(
  terminalRows: number | undefined,
  contentCap: number | undefined,
): number | undefined {
  const percentCap =
    terminalRows === undefined || !Number.isFinite(terminalRows)
      ? undefined
      : Math.max(1, Math.floor(Math.max(0, terminalRows) * TAB_BAR_VIEWPORT_RATIO));
  const capped =
    contentCap === undefined || !Number.isFinite(contentCap)
      ? undefined
      : Math.max(1, Math.floor(contentCap));
  if (percentCap === undefined) return capped;
  if (capped === undefined) return percentCap;
  return Math.max(1, Math.min(percentCap, capped));
}

export function renderTabBar(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
  maxRows?: number,
): string[] {
  return renderWithTheme(theme, () => {
    const layout = visibleTabBarLayout(state, width, maxRows);
    const { rows, hiddenLeftAgents, hiddenRight, indent, homePin, homeSegment } = layout;
    return rows.map((row, rowIndex) => {
      const prefix = rowIndex === 0 ? "" : " ".repeat(indent);
      const tabsText = row.map((segment) => segment.text).join(" ");
      const isFirst = rowIndex === 0;
      const isLast = rowIndex === rows.length - 1;
      // Home is pinned left (full or H) unless it is already inline in `rows`.
      const homeAnchor =
        isFirst && homePin === "full"
          ? homeSegment.text
          : isFirst && homePin === "compact"
            ? activeRenderTheme.homeTab(homeAnchorBare())
            : "";
      // Agent-only left overflow; gap outside the Home chip avoids "H+3".
      const leftHint =
        isFirst && hiddenLeftAgents > 0
          ? ` ${activeRenderTheme.dim(leftOverflowHint(hiddenLeftAgents))}`
          : "";
      const rightHint =
        isLast && hiddenRight > 0 ? activeRenderTheme.dim(rightOverflowHint(hiddenRight)) : "";
      // Unstyled column between the Home/H chip (or +N hint) and the first agent tab.
      const gutter = isFirst && homePin !== "inline" && tabsText ? " " : "";
      return padLine(
        homeAnchor + leftHint + gutter + activeRenderTheme.text(prefix + tabsText) + rightHint,
        width,
      );
    });
  });
}

/** Max background-agent status markers shown before collapsing to [+N]. */
export const ZEN_STATUS_MARKER_CAP = 5;
export type ZenStatusMarker = "working" | "waiting" | "done" | "error";

/**
 * Full-width horizontal rule rendered directly under the tab bar (agent view
 * only), replacing the former blank interval row. Its color tracks the active
 * tab's input-editor border so the two read as one frame: vim mode uses
 * `vimBorder`, otherwise the thinking-level border (matching app-editor's
 * normal-mode `borderColor`). Shell mode is intentionally not tracked — it is
 * driven by transient editor text and would make this top rule flicker.
 * In zen mode, meaningful states from other agents are left-anchored as
 * space-separated solid dots: accent for working, warning for pending input,
 * green for done, and red for errors. The cluster is capped at five markers,
 * then `[+N]`; dashes keep the frame color.
 * When `agentChrome` is set (custom setEditorComponent skins), the rule carries
 * the active agent title / optional override context / VIM|ZEN|sys badges so
 * EditorSlot does not paint a second label strip above the input editor.
 */
export function renderTabBarSeparator(
  width: number,
  options: {
    thinkingLevel?: string;
    vimMode?: boolean;
    zenMode?: boolean;
    /** Meaningful states from other agents, ordered by tab position. */
    zenStatusMarkers?: readonly ZenStatusMarker[];
    iconMode?: IconMode;
    /** Right-anchored agent labels for custom input-editor skins. */
    agentChrome?: {
      title: string;
      contextText?: string;
      customBasePrompt?: boolean;
    };
  } = {},
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => {
    const frame = options.vimMode
      ? activeRenderTheme.vimBorder
      : activeRenderTheme.thinkingBorder(options.thinkingLevel);
    const plain = () => [padLine(frame("\u2500".repeat(Math.max(0, width))), width)];
    if (width <= 0) return plain();

    const markers =
      options.zenMode === true ? (options.zenStatusMarkers ?? []) : ([] as readonly ZenStatusMarker[]);
    const zenLeft =
      markers.length > 0
        ? paintZenStatusMarkerCluster(markers, frame, options.iconMode ?? DEFAULT_ICON_MODE, width)
        : undefined;

    if (options.agentChrome) {
      const isVim = options.vimMode === true;
      const isZen = options.zenMode === true;
      const titleLabel = isVim ? activeRenderTheme.vimBorder : activeRenderTheme.accent;
      const zenLabel = isVim ? activeRenderTheme.vimBorder : activeRenderTheme.accent;
      const left = zenLeft?.painted ?? "";
      const leftWidth = zenLeft?.width ?? 0;
      // Prefer agent chrome when the row is too narrow for dots + title.
      const chromeWidth = leftWidth > 0 && width - leftWidth >= 12 ? width - leftWidth : width;
      const chromePrefix = chromeWidth === width ? "" : left;
      const chrome = buildLabeledTopBorder({
        width: chromeWidth,
        title: options.agentChrome.title,
        vimMode: isVim,
        zenMode: isZen,
        customBasePrompt: options.agentChrome.customBasePrompt === true,
        contextText: options.agentChrome.contextText,
        dash: frame,
        vimLabel: activeRenderTheme.vimBorder,
        zenLabel,
        titleLabel,
        sysLabel: titleLabel,
        contextLabel: activeRenderTheme.dim,
      });
      return [padLine(`${chromePrefix}${chrome}`, width)];
    }

    if (!zenLeft) return plain();
    const fill = Math.max(0, width - zenLeft.width);
    return [padLine(`${zenLeft.painted}${frame("\u2500".repeat(fill))}`, width)];
  });
}

/** Left cluster `── ● ● [+N] ` for zen other-agent dots; undefined if it cannot fit. */
function paintZenStatusMarkerCluster(
  markers: readonly ZenStatusMarker[],
  frame: (text: string) => string,
  iconMode: IconMode,
  maxWidth: number,
): { painted: string; width: number } | undefined {
  const statusDot = resolveGlyphs(iconMode).statusOn;
  const shownMarkers = markers.slice(0, ZEN_STATUS_MARKER_CAP);
  const overflow = markers.length - shownMarkers.length;
  const markerText = shownMarkers.map(() => statusDot).join(" ");
  // Prefer full "── ● ● ● [+N] "; drop [+N] then the cluster when width is tight.
  const bareWithOverflow =
    overflow > 0 ? `\u2500\u2500 ${markerText} [+${overflow}] ` : `\u2500\u2500 ${markerText} `;
  const bareWithoutOverflow = `\u2500\u2500 ${markerText} `;
  let bareLeft = bareWithOverflow;
  let includeOverflow = overflow > 0;
  if (visibleWidth(bareLeft) > maxWidth) {
    bareLeft = bareWithoutOverflow;
    includeOverflow = false;
  }
  if (visibleWidth(bareLeft) > maxWidth) return undefined;
  const paintedMarkers = shownMarkers
    .map((marker) => {
      if (marker === "working") return activeRenderTheme.accent(statusDot);
      if (marker === "waiting") return activeRenderTheme.warning(statusDot);
      if (marker === "error") return activeRenderTheme.error(statusDot);
      return activeRenderTheme.done(statusDot);
    })
    .join(" ");
  const overflowColor = markers.every((marker) => marker === "done")
    ? activeRenderTheme.done
    : activeRenderTheme.dim;
  const marker = paintedMarkers + (includeOverflow ? ` ${overflowColor(`[+${overflow}]`)}` : "");
  const painted = `${frame("\u2500\u2500")} ${marker} `;
  return { painted, width: visibleWidth(bareLeft) };
}

/** Meaningful states from other tabs, reusing the normal tab-bar glyph priority. */
export function zenStatusMarkers(
  tabs: ReadonlyArray<MixCodeTabInfo>,
  activeSessionId: string | undefined,
): ZenStatusMarker[] {
  const markers: ZenStatusMarker[] = [];
  for (const tab of tabs) {
    if (tab.sessionId === activeSessionId) continue;
    const glyph = tabStatusGlyph(tab);
    if (glyph === "!") markers.push("done");
    else if (glyph === "*") markers.push("working");
    else if (glyph === "?") markers.push("waiting");
    else if (glyph === "x") markers.push("error");
  }
  return markers;
}

export function tabBarHitRegions(
  state: MixCodeState,
  width = Number.POSITIVE_INFINITY,
  maxRows?: number,
): MouseHitRegion[] {
  const { rows, hiddenLeftAgents, indent, homePin, homeSegment } = visibleTabBarLayout(
    state,
    width,
    maxRows,
  );
  const regions: MouseHitRegion[] = [];
  rows.forEach((row, rowIndex) => {
    let cursor = rowIndex === 0 ? 1 : indent + 1;
    if (rowIndex === 0 && homePin !== "inline") {
      const homeText = homePin === "full" ? homeSegment.text : homeAnchorBare();
      const homeW = visibleWidth(homeText);
      regions.push({ id: "config", startX: cursor, endX: cursor + homeW - 1, row: 0 });
      cursor += homeW;
      // Match render: one column gap, then `+N … ` for hidden agents only.
      if (hiddenLeftAgents > 0) cursor += 1 + visibleWidth(leftOverflowHint(hiddenLeftAgents));
      // Same unstyled gutter as renderTabBar before the first agent chip.
      if (row.length > 0) cursor += 1;
    }
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

type HomePin = "inline" | "full" | "compact";

type TabBarLayout = {
  rows: TabSegment[][];
  /** Hidden agents before the agent window (Home is pinned separately). */
  hiddenLeftAgents: number;
  hiddenRight: number;
  homePin: HomePin;
  homeSegment: TabSegment;
  indent: number;
};

/** Compact Home stand-in when the full chip does not fit beside the agent window. */
function homeAnchorBare(): string {
  return " H ";
}

function leftOverflowHint(count: number): string {
  return `+${count} … `;
}

function rightOverflowHint(count: number): string {
  return ` … +${count}`;
}

function homePinWidth(homePin: Exclude<HomePin, "inline">, homeSegment: TabSegment): number {
  return homePin === "full"
    ? visibleWidth(homeSegment.text)
    : visibleWidth(homeAnchorBare());
}

/** Leading Home pin + optional agent left-overflow hint + gutter before agents. */
function leftChromeWidth(
  homePin: Exclude<HomePin, "inline">,
  homeSegment: TabSegment,
  hiddenLeftAgents: number,
  hasAgents = true,
): number {
  return (
    homePinWidth(homePin, homeSegment) +
    (hiddenLeftAgents > 0 ? 1 + visibleWidth(leftOverflowHint(hiddenLeftAgents)) : 0) +
    (hasAgents ? 1 : 0)
  );
}

function visibleTabCount(rows: TabSegment[][]): number {
  return rows.reduce((count, row) => count + row.length, 0);
}

/** Agent-window only: more tabs, then less left overflow, then less right. */
function isBetterAgentWindow(candidate: TabBarLayout, current: TabBarLayout): boolean {
  const cCount = visibleTabCount(candidate.rows);
  const bCount = visibleTabCount(current.rows);
  if (cCount !== bCount) return cCount > bCount;
  if (candidate.hiddenLeftAgents !== current.hiddenLeftAgents) {
    return candidate.hiddenLeftAgents < current.hiddenLeftAgents;
  }
  if (candidate.hiddenRight !== current.hiddenRight) {
    return candidate.hiddenRight < current.hiddenRight;
  }
  return false;
}

/**
 * Grow a contiguous agent window around the active agent (or from the start when
 * Home is active). Uses a fixed Home pin only for width budgeting.
 */
function growAgentWindow(
  agents: TabSegment[],
  width: number,
  maxRows: number,
  activeId: string,
  activeAgentIdx: number,
  homeActive: boolean,
  homePin: Exclude<HomePin, "inline">,
  homeSegment: TabSegment,
): TabBarLayout {
  let lo = homeActive ? 0 : activeAgentIdx;
  let hi = homeActive ? 0 : activeAgentIdx + 1;
  let current =
    fitAgentWindow(agents, lo, hi, width, maxRows, activeId, homePin, homeSegment) ??
    (homeActive
      ? {
          rows: [[]],
          hiddenLeftAgents: 0,
          hiddenRight: agents.length,
          homePin,
          homeSegment,
          indent: homePinWidth(homePin, homeSegment),
        }
      : forceAgentLayout(agents, activeAgentIdx, width, homePin, homeSegment));

  let improved = true;
  while (improved) {
    improved = false;
    if (lo > 0) {
      const next = fitAgentWindow(agents, lo - 1, hi, width, maxRows, activeId, homePin, homeSegment);
      if (next && isBetterAgentWindow(next, current)) {
        lo -= 1;
        current = next;
        improved = true;
      }
    }
    if (hi < agents.length) {
      const next = fitAgentWindow(agents, lo, hi + 1, width, maxRows, activeId, homePin, homeSegment);
      if (next && isBetterAgentWindow(next, current)) {
        hi += 1;
        current = next;
        improved = true;
      }
    }
    if (!homeActive && lo > 0 && hi > activeAgentIdx + 1) {
      const next = fitAgentWindow(
        agents,
        lo - 1,
        hi - 1,
        width,
        maxRows,
        activeId,
        homePin,
        homeSegment,
      );
      if (next && isBetterAgentWindow(next, current)) {
        lo -= 1;
        hi -= 1;
        current = next;
        improved = true;
      }
    }
  }
  return current;
}

/** Full Home pin only when its chip width is ≤ {@link HOME_PIN_FULL_MAX_RATIO} of the bar. */
function choosePinnedHomeForm(
  homeSegment: TabSegment,
  width: number,
  homeActive: boolean,
): Exclude<HomePin, "inline"> {
  // On Home itself, always show the full label for orientation.
  if (homeActive) return "full";
  const ratio = visibleWidth(homeSegment.text) / Math.max(1, width);
  return ratio > HOME_PIN_FULL_MAX_RATIO ? "compact" : "full";
}

function visibleTabBarLayout(
  state: MixCodeState,
  width: number,
  maxRows?: number,
): TabBarLayout {
  const segments = tabBarSegments(state);
  const homeSegment = segments[0] ?? { id: "config", text: activeRenderTheme.homeTab(" MixCode Home ") };
  const agents = segments.slice(1);
  const homeIndent = wrappedRowIndent(segments, width);

  // Unlimited budget: keep every packed row (Home inline, no overflow hint).
  if (maxRows === undefined || !Number.isFinite(maxRows)) {
    return {
      rows: packTabRows(segments, width, homeIndent),
      hiddenLeftAgents: 0,
      hiddenRight: 0,
      homePin: "inline",
      homeSegment,
      indent: homeIndent,
    };
  }
  const limit = Math.max(1, Math.floor(maxRows));
  // Everything fits without clipping — Home stays inline with agents.
  if (packTabRows(segments, width, homeIndent).length <= limit) {
    return {
      rows: packTabRows(segments, width, homeIndent),
      hiddenLeftAgents: 0,
      hiddenRight: 0,
      homePin: "inline",
      homeSegment,
      indent: homeIndent,
    };
  }

  const activeId = state.activeTabId;
  if (agents.length === 0) {
    return {
      rows: [[{ ...homeSegment }]],
      hiddenLeftAgents: 0,
      hiddenRight: 0,
      homePin: "inline",
      homeSegment,
      indent: 0,
    };
  }

  const homeActive = activeId === "config";
  let activeAgentIdx = agents.findIndex((segment) => segment.id === activeId);
  if (!homeActive && activeAgentIdx < 0) activeAgentIdx = 0;

  // Pick H vs full Home by width share, then grow the agent window under that pin.
  const homePin = choosePinnedHomeForm(homeSegment, width, homeActive);
  return growAgentWindow(
    agents,
    width,
    limit,
    activeId,
    activeAgentIdx,
    homeActive,
    homePin,
    homeSegment,
  );
}

/**
 * Fit agent window [lo, hi) beside a pinned Home chip. Home is not part of the
 * contiguous agent window — so full "MixCode Home" can appear whenever width
 * allows, without pulling every intermediate agent into view.
 */
function fitAgentWindow(
  agents: TabSegment[],
  lo: number,
  hi: number,
  width: number,
  maxRows: number,
  activeId: string,
  homePin: Exclude<HomePin, "inline">,
  homeSegment: TabSegment,
): TabBarLayout | null {
  if (lo < 0 || hi > agents.length || lo > hi) return null;
  const hiddenLeftAgents = lo;
  const hiddenRight = agents.length - hi;
  const windowSegs = agents.slice(lo, hi);
  // Active agent must stay inside the window (Home-active allows empty window).
  if (activeId !== "config") {
    if (!windowSegs.some((segment) => segment.id === activeId)) return null;
  }

  const leftChrome = leftChromeWidth(
    homePin,
    homeSegment,
    hiddenLeftAgents,
    windowSegs.length > 0,
  );
  const rightChrome =
    hiddenRight > 0 ? visibleWidth(rightOverflowHint(hiddenRight)) : 0;
  // Agent column is everything after the Home pin. Reserve `… +N` only on the
  // last row — subtracting it from every row left a hole on row 0 (screenshot).
  const agentColWidth = Math.max(1, width - leftChrome);
  const rows = packTabRows(windowSegs, agentColWidth, 0).map((row) => row.slice());
  reflowLastRowForRightHint(rows, agentColWidth, rightChrome);
  // Wrapped agent rows indent under the first agent column (after H / full Home + +N).
  const indent = leftChrome;
  if (windowSegs.length === 0) {
    // Home-only row: still valid when active is Home.
    if (activeId !== "config") return null;
    if (leftChrome + rightChrome > width) return null;
    return {
      rows: [[]],
      hiddenLeftAgents,
      hiddenRight,
      homePin,
      homeSegment,
      indent,
    };
  }
  if (rows.length > maxRows) return null;

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    // Row 0 sits beside the Home pin; later rows use the same left indent.
    const leftW = rowIndex === 0 ? leftChrome : indent;
    const rightW = rowIndex === rows.length - 1 ? rightChrome : 0;
    const tabsW =
      row.length === 0 ? 0 : visibleWidth(row.map((segment) => segment.text).join(" "));
    if (leftW + tabsW + rightW <= width) continue;
    if (windowSegs.length === 1 && row.length === 1) {
      const available = Math.max(1, width - leftW - rightW);
      row[0] = { ...row[0]!, text: truncateToWidth(row[0]!.text, available, "…") };
      continue;
    }
    return null;
  }

  return {
    rows,
    hiddenLeftAgents,
    hiddenRight,
    homePin,
    homeSegment,
    indent,
  };
}

/** Move trailing tabs onto a new last row until `… +N` fits beside the previous row. */
function reflowLastRowForRightHint(
  rows: TabSegment[][],
  agentColWidth: number,
  rightChrome: number,
): void {
  if (rightChrome <= 0 || rows.length === 0) return;
  const rowWidth = (row: TabSegment[]) =>
    row.length === 0 ? 0 : visibleWidth(row.map((segment) => segment.text).join(" "));
  for (;;) {
    const last = rows[rows.length - 1]!;
    if (rowWidth(last) + rightChrome <= agentColWidth) return;
    if (last.length <= 1) return;
    rows.push([last.pop()!]);
  }
}

function forceAgentLayout(
  agents: TabSegment[],
  activeAgentIdx: number,
  width: number,
  homePin: Exclude<HomePin, "inline">,
  homeSegment: TabSegment,
): TabBarLayout {
  if (agents.length === 0) {
    return {
      rows: [[]],
      hiddenLeftAgents: 0,
      hiddenRight: 0,
      homePin,
      homeSegment,
      indent: 0,
    };
  }
  const idx = Math.min(Math.max(0, activeAgentIdx), agents.length - 1);
  const active = agents[idx]!;
  const hiddenLeftAgents = idx;
  const hiddenRight = agents.length - idx - 1;
  const leftChrome = leftChromeWidth(homePin, homeSegment, hiddenLeftAgents);
  const rightChrome =
    hiddenRight > 0 ? visibleWidth(rightOverflowHint(hiddenRight)) : 0;
  const available = Math.max(1, width - leftChrome - rightChrome);
  const text =
    visibleWidth(active.text) <= available
      ? active.text
      : truncateToWidth(active.text, available, "…");
  return {
    rows: [[{ ...active, text }]],
    hiddenLeftAgents,
    hiddenRight,
    homePin,
    homeSegment,
    indent: leftChrome,
  };
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

/** Bar width for the bottom-meta context meter. */
const CONTEXT_BAR_WIDTH = 8;

/**
 * Exact compact usage for the editor top border, e.g. `12.3k/200k` or `?/200k*`.
 * No percent — that lives in the bottom-meta bar.
 */
export function exactContextUsageText(tab: MixCodeTabInfo): string {
  const tokens = tab.currentContextTokens;
  const limit = tab.contextLimit;
  const overrideMark = tab.contextLimitOverridden ? "*" : "";
  if (tokens === undefined) return `?/${formatCompactTokenCount(limit)}${overrideMark}`;
  return `${formatCompactTokenCount(tokens)}/${formatCompactTokenCount(limit)}${overrideMark}`;
}

/**
 * Bottom-meta context meter: `icon [bar] 50.0%`.
 * Absolute token counts stay on the editor top border.
 */
export function contextBarAndPercentText(
  tab: MixCodeTabInfo,
  iconMode: IconMode = DEFAULT_ICON_MODE,
): string {
  const glyphs = resolveGlyphs(iconMode);
  const percent = contextUsagePercent(tab);
  if (percent === undefined) {
    // Empty meter until the first token count arrives; keep width stable.
    return activeRenderTheme.dim(
      `${glyphs.context} [${glyphs.barEmpty.repeat(CONTEXT_BAR_WIDTH)}] ?%`,
    );
  }
  const filled = Math.max(
    0,
    Math.min(CONTEXT_BAR_WIDTH, Math.round((percent / 100) * CONTEXT_BAR_WIDTH)),
  );
  const cells = `${glyphs.barFilled.repeat(filled)}${glyphs.barEmpty.repeat(CONTEXT_BAR_WIDTH - filled)}`;
  const bar = `${glyphs.context} [${cells}] ${percent.toFixed(1)}%`;
  if (percent >= 80) return activeRenderTheme.error(bar);
  if (percent >= 50) return activeRenderTheme.accent(bar);
  return activeRenderTheme.success(bar);
}

function contextUsagePercent(tab: MixCodeTabInfo): number | undefined {
  const tokens = tab.currentContextTokens;
  const limit = tab.contextLimit;
  if (tokens === undefined || limit <= 0) return undefined;
  return Math.min(999, Math.max(0, (tokens / limit) * 100));
}

function formatCompactTokenCount(tokens: number): string {
  const value = tokens / 1_000;
  if (Number.isInteger(value)) return `${value.toFixed(0)}k`;
  return `${tokens < 10_000 ? value.toFixed(2) : value.toFixed(1)}k`;
}

export function renderInputMeta(
  tab: MixCodeTabInfo,
  width: number,
  row = 0,
  theme: MixCodeTheme = activeRenderTheme,
  updateHitRegions = true,
  iconMode: IconMode = DEFAULT_ICON_MODE,
): string[] {
  return renderWithTheme(theme, () =>
    renderInputMetaInner(tab, width, row, updateHitRegions, iconMode),
  );
}

function renderInputMetaInner(
  tab: MixCodeTabInfo,
  width: number,
  row = 0,
  updateHitRegions = true,
  iconMode: IconMode = DEFAULT_ICON_MODE,
): string[] {
  const lineWidth = Math.max(0, width - 1);
  const glyphs = resolveGlyphs(iconMode);
  // Esc / vim-enter arm feedback is toast-only (see app-key-handlers / app-input).
  // Extension footers already paint cwd/model/context/git/status — collapse meta
  // so the two layers do not stack duplicate fields.
  if (tab.extensionUi.footer) {
    if (updateHitRegions) tab.inputMetaHitRegions = [];
    return [];
  }
  const model = tab.model.displayName || "-";
  const thinking = tab.thinkingLevel[0]!.toUpperCase() + tab.thinkingLevel.slice(1);
  // Absolute xxk/xxk lives on the editor top border; bottom meta only shows bar+%.
  // Unknown usage still paints `?%` — never omit the meter just because count is pending.
  const contextBadge = ` ${contextBarAndPercentText(tab, iconMode)} `;
  const branch = gitBranchForWorkdir(tab.workdir);
  const git = branch
    ? activeRenderTheme.accent(activeRenderTheme.bold(` ${glyphs.git} ${branch} `))
    : "";
  // Compress left first (provider → short model → icons/gaps → truncate).
  // Only then drop right: branch first, token bar last.
  const rightOptions = [git ? `${contextBadge} ${git}` : contextBadge, contextBadge, ""];
  let left = renderInputMetaLeft(tab.workdir, model, thinking, "", lineWidth, glyphs);
  let right = "";
  for (const candidate of rightOptions) {
    const rightW = visibleWidth(candidate);
    const leftBudget = candidate ? Math.max(0, lineWidth - rightW - 1) : lineWidth;
    const attempt = renderInputMetaLeft(tab.workdir, model, thinking, "", leftBudget, glyphs);
    if (!attempt.text) continue;
    if (candidate && visibleWidth(attempt.text) + 1 + rightW > lineWidth) continue;
    // If workdir was squeezed off, drop more of the right instead of hiding it.
    if (candidate && !leftKeepsWorkdir(attempt)) continue;
    left = attempt;
    right = candidate;
    break;
  }
  const gap = Math.max(1, lineWidth - visibleWidth(left.text) - visibleWidth(right));
  const metaRow =
    right && visibleWidth(left.text) + visibleWidth(right) + 1 <= lineWidth
      ? `${left.text}${" ".repeat(gap)}${right}`
      : right
        ? `${left.text} ${right}`
        : left.text;
  if (updateHitRegions) {
    tab.inputMetaHitRegions = left.regions.map((region) => ({ ...region, row }));
  }
  const lines = [padLine(metaRow, lineWidth)];
  // In vim mode the input area is read-only; hide the extension status line
  // (e.g. pi-subagents) so its row is reclaimed by the chat surface.
  const extLine = tab.vimMode ? undefined : buildExtensionStatusLine(tab, Math.max(0, width - 1));
  if (extLine) lines.push(extLine);
  return lines;
}

// Progressive model-name degradation for narrow rows: render the richest
// layout that fits (full provider/module model + icons + wide gaps, then
// provider dropped, then icons dropped with single-space gaps); the tightest
// mode falls back to truncation when nothing fits.
type InputMetaMode = { model: string; thinking: string; gap: string };

function leftKeepsWorkdir(left: { workdirIntact?: boolean }): boolean {
  return left.workdirIntact === true;
}

function renderInputMetaLeft(
  workdirPath: string,
  model: string,
  thinking: string,
  escapeHint: string,
  width: number,
  glyphs: IconGlyphs,
): {
  text: string;
  regions: Array<{ action: "models" | "thinking" | "workdir"; startX: number; endX: number }>;
  workdirIntact: boolean;
} {
  if (width <= 0) return { text: "", regions: [], workdirIntact: false };
  const moduleName = shortModelName(model);
  const modes: InputMetaMode[] = [
    {
      model: ` ${glyphs.model} ${model} `,
      thinking: ` ${glyphs.thinking} ${thinking} `,
      gap: "  ",
    },
    {
      model: ` ${glyphs.model} ${moduleName} `,
      thinking: ` ${glyphs.thinking} ${thinking} `,
      gap: "  ",
    },
    { model: moduleName, thinking, gap: " " },
  ];
  // Greedy degradation: strict modes require model, thinking, and workdir all
  // visible at natural width; the tightest mode may truncate/drop pieces.
  for (let index = 0; index < modes.length - 1; index++) {
    const candidate = layoutInputMetaLeft(modes[index]!, workdirPath, escapeHint, width, true);
    if (candidate.fits) return candidate;
  }
  return layoutInputMetaLeft(modes[modes.length - 1]!, workdirPath, escapeHint, width, false);
}

function layoutInputMetaLeft(
  mode: InputMetaMode,
  workdirPath: string,
  escapeHint: string,
  width: number,
  strict: boolean,
): {
  text: string;
  regions: Array<{ action: "models" | "thinking" | "workdir"; startX: number; endX: number }>;
  fits: boolean;
  workdirIntact: boolean;
} {
  const pieces: Array<{ action?: "models" | "thinking" | "workdir"; text: string }> = [];
  let remaining = Math.max(0, width - 2);
  let workdirIntact = false;
  const escapeText = escapeHint ? activeRenderTheme.dim(escapeHint) : "";
  const escapeWidth = visibleWidth(escapeText);
  const thinkingWidth = visibleWidth(mode.thinking);
  const modelFullWidth = visibleWidth(mode.model);
  const gapWidth = visibleWidth(mode.gap);
  const fixedWidth = thinkingWidth + escapeWidth + (escapeText ? 1 : 0);
  if (strict && remaining - fixedWidth - 2 * gapWidth < modelFullWidth) {
    return { text: "", regions: [], fits: false, workdirIntact: false };
  }
  const modelWidth = strict
    ? modelFullWidth
    : Math.max(5, Math.min(modelFullWidth, remaining - fixedWidth));
  const modelText = strict ? mode.model : truncateToWidth(mode.model, modelWidth, "...");
  pieces.push({
    action: "models",
    text: activeRenderTheme.accent(activeRenderTheme.bold(modelText)),
  });
  remaining -= visibleWidth(modelText);
  if (remaining >= thinkingWidth + escapeWidth + (escapeText ? 1 : 0)) {
    pieces.push({ text: mode.gap });
    pieces.push({
      action: "thinking",
      text: activeRenderTheme.accent(activeRenderTheme.bold(mode.thinking)),
    });
    remaining -= gapWidth + thinkingWidth;
  } else if (strict) {
    return { text: "", regions: [], fits: false, workdirIntact: false };
  }
  const escapeGap = escapeText ? 1 + escapeWidth : 0;
  const workdirBudget = Math.max(0, remaining - escapeGap - gapWidth);
  const workdirNatural = shortWorkdir(workdirPath);
  // Strict modes keep the full short path; only the non-strict fallback may
  // compact segments or ellipsize. Otherwise provider stays while workdir gets "...".
  if (strict) {
    if (visibleWidth(workdirNatural) > workdirBudget) {
      return { text: "", regions: [], fits: false, workdirIntact: false };
    }
    pieces.push({ text: mode.gap });
    pieces.push({ action: "workdir", text: activeRenderTheme.accent(workdirNatural) });
    remaining -= gapWidth + visibleWidth(workdirNatural);
    workdirIntact = true;
  } else if (workdirBudget >= 4) {
    pieces.push({ text: mode.gap });
    const workdir = compactWorkdir(workdirNatural, workdirBudget);
    pieces.push({ action: "workdir", text: activeRenderTheme.accent(workdir) });
    remaining -= gapWidth + visibleWidth(workdir);
    // Segment-compressed paths are ok; `...` truncation counts as obscured.
    workdirIntact = !workdir.includes("...");
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
  return { text, regions, fits: true, workdirIntact };
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
    return [padLine(activeRenderTheme.dim(text), width)];
  }
  const elapsed = formatElapsed(tab.workingStartedAt, now);
  const detail = isPendingEscapeActive(tab, "abort-agent", now.getTime())
    ? "esc again to interrupt"
    : "esc to interrupt";
  const message = workingActivityMessage(tab);
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
  const border = activeRenderTheme.borderMuted("\u2502");
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
    visible[visible.length - 1] = padLine(
      `${border} ${activeRenderTheme.dim("\u2193 more")}`,
      panelWidth,
    );
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
function buildExtensionStatusLine(tab: MixCodeTabInfo, width: number): string | undefined {
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
        text: renderTabSegmentText(
          tab,
          text,
          state.activeTabId === tab.sessionId,
          recentAgentTabRank(state, tab.sessionId),
          state.activeTabId === "config",
        ),
      };
    }),
  ];
}

function renderTabSegmentText(
  tab: MixCodeTabInfo,
  text: string,
  active: boolean,
  recentRank: number,
  onHome: boolean,
): string {
  const statusColor = tabIsWaitingForInput(tab)
    ? activeRenderTheme.toolTitle
    : tab.status === "running" || tab.status === "thinking"
      ? activeRenderTheme.accent
      : tab.status !== "error" && tab.unreadDone
        ? activeRenderTheme.done
        : undefined;
  const colored = statusColor ? statusColor(text) : text;
  if (active) return activeRenderTheme.activeTab(colored);
  if (onHome) {
    if (recentRank === 0) return activeRenderTheme.recentTab(colored);
    if (recentRank === 1) return activeRenderTheme.olderRecentTab(colored);
    return activeRenderTheme.tab(colored);
  }
  if (recentRank === 1) return activeRenderTheme.recentTab(colored);
  if (recentRank === 2) return activeRenderTheme.olderRecentTab(colored);
  return activeRenderTheme.tab(colored);
}

export function tabStatusGlyph(tab: MixCodeTabInfo): string {
  if (tab.status === "Not Ready") return "◌";
  if (tab.status === "error") return "x";
  if (tabIsWaitingForInput(tab)) return "?";
  if (tab.status === "running" || tab.status === "thinking") return "*";
  if (tab.status === "done" || tab.unreadDone) return "!";
  return "-";
}

function shortWorkdir(workdir: string): string {
  const home = process.env.HOME;
  if (home && workdir.startsWith(home)) return `~${workdir.slice(home.length)}`;
  return workdir;
}

// "provider/module-name" → "module-name", keeping everything after the last
// slash (openrouter/anthropic/claude-3.7-sonnet → claude-3.7-sonnet).
export function shortModelName(displayName: string): string {
  const slash = displayName.lastIndexOf("/");
  return slash >= 0 ? displayName.slice(slash + 1) : displayName;
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
