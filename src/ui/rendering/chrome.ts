import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { isPendingEscapeActive } from "../../core/escape.js";
import { gitBranchForWorkdir } from "../../core/git-branch.js";
import { collapseHome } from "../../core/paths.js";
import { recentAgentTabRank } from "../../core/tabs.js";
import { DEFAULT_ICON_MODE, type IconMode } from "../../core/mixcode-settings.js";
import type { MouseHitRegion } from "../../core/mouse.js";
import {
  retryStatusMessage,
  tabIsWaitingForInput,
  workingActivityMessage,
} from "../../core/tab-state.js";
import {
  HOME_TAB_ID,
  type ExtensionWidgetLine,
  type MixCodeState,
  type MixCodeTabInfo,
} from "../../core/types.js";
import { pointerHoverFor } from "../pointer-hover.js";
import { buildLabeledTopBorder } from "../components/editor-top-border.js";
import type { MixCodeTheme } from "../themes.js";
import { tabColorPaint } from "../themes.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { resolveGlyphs, resolveIconMode, type IconGlyphs } from "./icons.js";
import { padLine, sanitizeTerminalText } from "./primitives.js";

const DEFAULT_WORKING_INDICATOR_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DEFAULT_WORKING_INDICATOR_INTERVAL_MS = 80;

export function renderExtensionHeader(tab: MixCodeTabInfo | undefined, width: number): string[] {
  const header = tab?.extensionUi.header;
  return renderExtensionComponentSlot(header?.render ? header.render(width) : header?.lines, width);
}

/** Tab bar may use at most this fraction of the terminal height (rows). */
const TAB_BAR_VIEWPORT_RATIO = 0.1;

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
    const hover = pointerHoverFor(state, "tabs");
    hover.layout(
      tabBarLayoutHitRegions(layout).map((region) => ({
        id: region.id,
        x: region.startX,
        y: (region.row ?? 0) + 1,
        width: region.endX - region.startX + 1,
      })),
    );
    const lines = rows.map((row, rowIndex) => {
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
    return hover.paint(lines, width, activeRenderTheme);
  });
}

/** Max background-agent status markers shown before collapsing to [+N]. */
const ZEN_STATUS_MARKER_CAP = 5;
export type ZenStatusMarker = "working" | "waiting" | "done" | "error";

/**
 * Full-width horizontal rule directly under the agent tab bar. Vim mode uses
 * `vimBorder`; other modes use the active tab's thinking-level color, matching
 * the default input frame. Its color is independent of the draft text.
 * In zen mode, meaningful states from other agents are left-anchored as
 * space-separated solid dots: accent for working, warning for pending input,
 * green for done, and red for errors. The cluster is capped at five markers,
 * then `[+N]`; dashes keep the frame color.
 * When `agentChrome` is set (custom setEditorComponent skins), the rule carries
 * the agent title, optional context usage, and [VIM], [ZEN], and [sys] badges.
 * Custom editors render their own input body.
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
    now?: number;
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
      options.zenMode === true
        ? (options.zenStatusMarkers ?? [])
        : ([] as readonly ZenStatusMarker[]);
    const zenLeft =
      markers.length > 0
        ? paintZenStatusMarkerCluster(
            markers,
            frame,
            options.iconMode ?? DEFAULT_ICON_MODE,
            width,
            options.now,
          )
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
  now = Date.now(),
): { painted: string; width: number } | undefined {
  const statusDot = resolveGlyphs(iconMode).statusOn;
  const isAscii = resolveIconMode(iconMode) === "ascii";
  const workingGlyph = isAscii
    ? statusDot
    : DEFAULT_WORKING_INDICATOR_FRAMES[
        Math.floor(now / DEFAULT_WORKING_INDICATOR_INTERVAL_MS) %
          DEFAULT_WORKING_INDICATOR_FRAMES.length
      ]!;
  const shownMarkers = markers.slice(0, ZEN_STATUS_MARKER_CAP);
  const overflow = markers.length - shownMarkers.length;
  const markerText = shownMarkers
    .map((marker) => (marker === "working" ? workingGlyph : statusDot))
    .join(" ");
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
      if (marker === "working") return activeRenderTheme.accent(workingGlyph);
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
    if (glyph === "✓") markers.push("done");
    else if (glyph === "●") markers.push("working");
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
  return tabBarLayoutHitRegions(visibleTabBarLayout(state, width, maxRows));
}

function tabBarLayoutHitRegions(layout: TabBarLayout): MouseHitRegion[] {
  const { rows, hiddenLeftAgents, indent, homePin, homeSegment } = layout;
  const regions: MouseHitRegion[] = [];
  rows.forEach((row, rowIndex) => {
    let cursor = rowIndex === 0 ? 1 : indent + 1;
    if (rowIndex === 0 && homePin !== "inline") {
      const homeText = homePin === "full" ? homeSegment.text : homeAnchorBare();
      const homeW = visibleWidth(homeText);
      regions.push({ id: HOME_TAB_ID, startX: cursor, endX: cursor + homeW - 1, row: 0 });
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
  return homePin === "full" ? visibleWidth(homeSegment.text) : visibleWidth(homeAnchorBare());
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

/**
 * Growth walk only: more tabs, then less left overflow, then less right. The walk
 * uses this while it extends the window one tab at a time; the final placement
 * comes from {@link chooseWindowPlacement}.
 */
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
 * Placement ordering for the final window: more tabs, then the most even
 * overflow, then the earlier window. Even overflow keeps the window centered on
 * the active agent, so tabs created after it stay visible instead of vanishing
 * behind the trailing `… +N`. The `hiddenLeftAgents` comparison only breaks ties
 * between equally even windows, which keeps the choice stable.
 */
function isBetterPlacedWindow(candidate: TabBarLayout, current: TabBarLayout): boolean {
  const cCount = visibleTabCount(candidate.rows);
  const bCount = visibleTabCount(current.rows);
  if (cCount !== bCount) return cCount > bCount;
  const cImbalance = Math.abs(candidate.hiddenLeftAgents - candidate.hiddenRight);
  const bImbalance = Math.abs(current.hiddenLeftAgents - current.hiddenRight);
  if (cImbalance !== bImbalance) return cImbalance < bImbalance;
  return candidate.hiddenLeftAgents < current.hiddenLeftAgents;
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
      const next = fitAgentWindow(
        agents,
        lo - 1,
        hi,
        width,
        maxRows,
        activeId,
        homePin,
        homeSegment,
      );
      if (next && isBetterAgentWindow(next, current)) {
        lo -= 1;
        current = next;
        improved = true;
      }
    }
    if (hi < agents.length) {
      const next = fitAgentWindow(
        agents,
        lo,
        hi + 1,
        width,
        maxRows,
        activeId,
        homePin,
        homeSegment,
      );
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
  return chooseWindowPlacement(
    agents,
    current,
    width,
    maxRows,
    activeId,
    activeAgentIdx,
    homeActive,
    homePin,
    homeSegment,
  );
}

/**
 * Final placement pass for the agent window. The grow loop decides how many tabs
 * stay visible (its window is left-anchored, which pins the active tab to the
 * window's right edge); this pass keeps that count and picks where the window
 * sits. It scans every start that keeps the active agent inside a window of the
 * same count and keeps the most even one, so the overflow balance is a property
 * of the layout rather than of the walk. Skipped when Home is active (its window
 * is pinned to the first agent) and when no agent is hidden.
 */
function chooseWindowPlacement(
  agents: TabSegment[],
  current: TabBarLayout,
  width: number,
  maxRows: number,
  activeId: string,
  activeAgentIdx: number,
  homeActive: boolean,
  homePin: Exclude<HomePin, "inline">,
  homeSegment: TabSegment,
): TabBarLayout {
  const count = visibleTabCount(current.rows);
  if (homeActive || count === 0 || count >= agents.length) return current;
  let best = current;
  for (let lo = 0; lo + count <= agents.length; lo++) {
    // Only windows that still show the active agent are candidates.
    if (activeAgentIdx < lo || activeAgentIdx >= lo + count) continue;
    const candidate = fitAgentWindow(
      agents,
      lo,
      lo + count,
      width,
      maxRows,
      activeId,
      homePin,
      homeSegment,
    );
    if (candidate && isBetterPlacedWindow(candidate, best)) best = candidate;
  }
  return best;
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

function visibleTabBarLayout(state: MixCodeState, width: number, maxRows?: number): TabBarLayout {
  const segments = tabBarSegments(state);
  const homeSegment = segments[0] ?? {
    id: HOME_TAB_ID,
    text: activeRenderTheme.homeTab(" MixCode Home "),
  };
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

  const homeActive = activeId === HOME_TAB_ID;
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
  if (activeId !== HOME_TAB_ID) {
    if (!windowSegs.some((segment) => segment.id === activeId)) return null;
  }

  const leftChrome = leftChromeWidth(homePin, homeSegment, hiddenLeftAgents, windowSegs.length > 0);
  const rightChrome = hiddenRight > 0 ? visibleWidth(rightOverflowHint(hiddenRight)) : 0;
  // Agent column is everything after the Home pin. Reserve `… +N` only on the
  // last row — subtracting it from every row left a hole on row 0 (screenshot).
  const agentColWidth = Math.max(1, width - leftChrome);
  const rows = packTabRows(windowSegs, agentColWidth, 0).map((row) => row.slice());
  reflowLastRowForRightHint(rows, agentColWidth, rightChrome);
  // Wrapped agent rows indent under the first agent column (after H / full Home + +N).
  const indent = leftChrome;
  if (windowSegs.length === 0) {
    // Home-only row: still valid when active is Home.
    if (activeId !== HOME_TAB_ID) return null;
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
    const tabsW = row.length === 0 ? 0 : visibleWidth(row.map((segment) => segment.text).join(" "));
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
  const rightChrome = hiddenRight > 0 ? visibleWidth(rightOverflowHint(hiddenRight)) : 0;
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

export function formatCompactTokenCount(tokens: number): string {
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
    if (updateHitRegions) {
      tab.inputMetaHitRegions = [];
      pointerHoverFor(tab, "meta").reset();
    }
    return [];
  }
  const model = process.env.MIXCODE_DISPLAY_MODEL?.trim() || tab.model.displayName || "-";
  const rawThinking = tab.thinkingLevel[0]!.toUpperCase() + tab.thinkingLevel.slice(1);
  const thinking = process.env.MIXCODE_DISPLAY_THINKING?.trim() || rawThinking;
  const workdir = process.env.MIXCODE_DISPLAY_WORKDIR?.trim() || tab.workdir;
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
  let left = renderInputMetaLeft(workdir, model, thinking, lineWidth, glyphs);
  let right = "";
  for (const candidate of rightOptions) {
    const rightW = visibleWidth(candidate);
    const leftBudget = candidate ? Math.max(0, lineWidth - rightW - 1) : lineWidth;
    const attempt = renderInputMetaLeft(workdir, model, thinking, leftBudget, glyphs);
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
  if (!updateHitRegions) return lines;
  const hover = pointerHoverFor(tab, "meta");
  hover.layout(
    tab.inputMetaHitRegions!.map((region) => ({
      id: region.action,
      x: region.startX,
      y: region.row,
      width: region.endX - region.startX + 1,
    })),
  );
  return hover.paint(lines, lineWidth, activeRenderTheme, row - 1);
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
    const candidate = layoutInputMetaLeft(modes[index]!, workdirPath, width, true);
    if (candidate.fits) return candidate;
  }
  return layoutInputMetaLeft(modes[modes.length - 1]!, workdirPath, width, false);
}

function layoutInputMetaLeft(
  mode: InputMetaMode,
  workdirPath: string,
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
  const thinkingWidth = visibleWidth(mode.thinking);
  const modelFullWidth = visibleWidth(mode.model);
  const gapWidth = visibleWidth(mode.gap);
  const fixedWidth = thinkingWidth;
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
  if (remaining >= thinkingWidth) {
    pieces.push({ text: mode.gap });
    pieces.push({
      action: "thinking",
      text: activeRenderTheme.accent(activeRenderTheme.bold(mode.thinking)),
    });
    remaining -= gapWidth + thinkingWidth;
  } else if (strict) {
    return { text: "", regions: [], fits: false, workdirIntact: false };
  }
  const workdirBudget = Math.max(0, remaining - gapWidth);
  const workdirNatural = collapseHome(workdirPath);
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

/**
 * Paint for the working-line message. A user-invoked /compact stays neutral,
 * threshold auto-compaction is a notice, and overflow is an intervention that
 * explains why the turn stalled; every other activity keeps the dim treatment.
 */
export function workingActivityPaint(
  tab: MixCodeTabInfo,
  theme: MixCodeTheme = activeRenderTheme,
): (text: string) => string {
  switch (tab.activeCompactionReason) {
    case "manual":
      return theme.accent;
    case "threshold":
      return theme.warning;
    case "overflow":
      return theme.error;
    default:
      return theme.dim;
  }
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
  const detail = isPendingEscapeActive(tab, now.getTime())
    ? "esc again to interrupt"
    : "esc to interrupt";
  const message = workingActivityMessage(tab);
  const indicator = workingIndicatorFrame(tab, now);
  if (indicator === "") return [];
  const prefix = indicator ? `${indicator} ` : "";
  // During auto-retry, mirror Pi's countdown status line instead of the generic
  // working text. A retry is not a compaction, so workingActivityPaint leaves it dim.
  const retry = retryStatusMessage(tab, now);
  const body = retry ?? `${message} (${elapsed} • ${detail})`;
  const paint = workingActivityPaint(tab);
  return [padLine(`${prefix}${paint(body)}`, width)];
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

// Share of the chat viewport the inline widget block may occupy, for one widget
// or several. Bumping it trades chat rows for widget bodies.
const INLINE_TAIL_SHARE = 0.7;
const INLINE_TAIL_MIN_BUDGET = 6;
const INLINE_TAIL_MAX_BUDGET = 24;
// Extra rows the block must free before a collapsed widget expands again, so an
// overflowing tail cannot collapse and re-expand on alternating frames.
const INLINE_TAIL_HOLD_DEADBAND_ROWS = 2;
// Consecutive frames the fully expanded block must fit before held decisions are
// dropped, so a one-row dip cannot re-expand a tail that immediately overflows.
const INLINE_TAIL_EXPAND_STREAK = 2;

interface InlineWidgetEntry {
  widget: ExtensionWidgetLine;
  /** Registration order across both placements; breaks equal-recency ties. */
  order: number;
  /** Body rows rendered once for this frame at the placement's body width. */
  lines: string[];
}

interface InlineWidgetPlan {
  /** Body rows per widget key; 0 renders the widget as its header alone. */
  bodyRows: Map<string, number>;
  /** Keys the automatic budget collapsed this frame. */
  autoCollapsed: Set<string>;
}

/**
 * Render inline widgets at the chat tail.
 *
 * With a known viewport the whole block is capped by a viewport-derived row
 * budget: bodies shrink, then the remaining rows go to the highest-priority
 * widgets while the rest collapse to their headers, and finally the block
 * degrades to a single summary row. Without a viewport (full-render and
 * measurement callers own their own clipping) only manual collapse state
 * applies.
 */
export function renderInlineExtensionWidgets(
  tab: MixCodeTabInfo,
  width: number,
  options: { viewportRows?: number } = {},
): string[] {
  const bodyWidth = Math.max(1, width - 2);
  const entries = collectInlineWidgetEntries(tab, bodyWidth);
  if (entries.length === 0) return [];
  const budget =
    options.viewportRows === undefined ? undefined : inlineTailBudget(options.viewportRows);
  const plan = planInlineWidgetBlock(tab, entries, budget, width);
  if (plan.bodyRows.size === 0) return [inlineWidgetSummaryLine(entries.length, bodyWidth, width)];

  const lines: string[] = [];
  entries.forEach((entry, index) => {
    const body = plan.bodyRows.get(entry.widget.key) ?? 0;
    const collapsed = body === 0;
    const previousCollapsed =
      index > 0 && (plan.bodyRows.get(entries[index - 1]!.widget.key) ?? 0) === 0;
    // Collapsed widgets stack their headers densely; an expanded neighbour keeps
    // its separating blank row.
    if (index > 0 && !(collapsed && previousCollapsed)) {
      lines.push(renderSingleLineExtensionSlot("", width));
    }
    lines.push(
      renderSingleLineExtensionSlot(
        inlineWidgetSectionHeader(
          entry.widget.key,
          bodyWidth,
          collapsed,
          plan.autoCollapsed.has(entry.widget.key),
        ),
        width,
      ),
    );
    if (collapsed) return;
    lines.push(
      ...entry.lines.slice(0, body).map((line) => renderSingleLineExtensionSlot(line, width)),
    );
  });
  return lines;
}

/** Above-editor widgets render above below-editor ones, each in registration order. */
function collectInlineWidgetEntries(tab: MixCodeTabInfo, bodyWidth: number): InlineWidgetEntry[] {
  const entries: InlineWidgetEntry[] = [];
  // Snapshot first: a widget whose render registers another widget must not grow
  // the list being iterated.
  const widgets = [...tab.extensionUi.widgets];
  for (const placement of ["aboveEditor", "belowEditor"] as const) {
    for (const widget of widgets) {
      if (widget.placement !== placement) continue;
      const lines = widget.render?.(bodyWidth) ?? wrapExtensionWidgetLines(widget.lines, bodyWidth);
      // A widget with nothing to show contributes neither header nor separator.
      if (lines.length === 0) continue;
      entries.push({ widget, order: entries.length, lines });
    }
  }
  return entries;
}

/** Rows the block occupies: headers, separators, and bodies. */
function inlineWidgetRows(
  entries: readonly InlineWidgetEntry[],
  bodyRows: ReadonlyMap<string, number>,
): number {
  let rows = 0;
  entries.forEach((entry, index) => {
    const body = bodyRows.get(entry.widget.key) ?? 0;
    const previousCollapsed =
      index > 0 && (bodyRows.get(entries[index - 1]!.widget.key) ?? 0) === 0;
    if (index > 0 && !(body === 0 && previousCollapsed)) rows += 1;
    rows += 1;
    rows += body;
  });
  return rows;
}

/** Soft row target for the inline block: a clamped share of the chat viewport. */
function inlineTailBudget(viewportRows: number): number {
  const viewport = Math.max(0, viewportRows);
  // On a viewport too small for the usual floor the chat keeps half the rows.
  const floor = Math.min(INLINE_TAIL_MIN_BUDGET, Math.max(1, Math.floor(viewport / 2)));
  const target = Math.floor(viewport * INLINE_TAIL_SHARE);
  return Math.max(floor, Math.min(INLINE_TAIL_MAX_BUDGET, target));
}

/**
 * Rows per widget for this frame.
 *
 * With a budget: keep every body complete if the block fits; otherwise hand
 * complete bodies out in priority order, manually expanded widgets first, then
 * the most recently updated, then registration order. The first widget whose
 * full body no longer fits is the cut: it and every lower-priority widget
 * collapse to its header. A shown body is never partial. An empty plan means
 * even a header-only stack does not fit, and the caller renders one summary row
 * instead.
 *
 * Without a budget (full-render and measurement callers own their clipping) only
 * manual collapse state applies.
 */
function planInlineWidgetBlock(
  tab: MixCodeTabInfo,
  entries: readonly InlineWidgetEntry[],
  budget: number | undefined,
  width: number,
): InlineWidgetPlan {
  const manuallyCollapsed = new Set<string>();
  const pinned = new Set<string>();
  for (const entry of entries) {
    const manual = tab.inlineWidgetCollapsed.get(entry.widget.key);
    if (manual === true) manuallyCollapsed.add(entry.widget.key);
    else if (manual === false) pinned.add(entry.widget.key);
  }

  const autoCollapsed = tab.inlineWidgetAutoCollapsed;
  // Drop decisions for widgets that are gone or that a user command now owns.
  for (const key of [...autoCollapsed]) {
    if (!entries.some((entry) => entry.widget.key === key) || tab.inlineWidgetCollapsed.has(key)) {
      autoCollapsed.delete(key);
    }
  }

  const naturalBody = (entry: InlineWidgetEntry): number => entry.lines.length;
  const naturalBodies = new Map(entries.map((entry) => [entry.widget.key, naturalBody(entry)]));
  // A manually expanded widget keeps its body: the user asked for it, so the row
  // budget makes the other widgets give way instead.
  const pinnedBodies = new Map<string, number>();
  for (const entry of entries) {
    if (pinned.has(entry.widget.key)) pinnedBodies.set(entry.widget.key, naturalBody(entry));
  }
  // Body rows per widget; a key in `hiddenKeys` renders as its header alone.
  const withBodies = (
    bodies: ReadonlyMap<string, number>,
    hiddenKeys: ReadonlySet<string>,
  ): Map<string, number> => {
    const rows = new Map<string, number>();
    for (const entry of entries) {
      const key = entry.widget.key;
      rows.set(key, hiddenKeys.has(key) ? 0 : (bodies.get(key) ?? 0));
    }
    return rows;
  };
  const fullyExpanded = withBodies(naturalBodies, manuallyCollapsed);

  // No viewport (dump and measurement callers own their clipping): manual state
  // only, and the automatic decisions stay untouched.
  if (budget === undefined) {
    return { bodyRows: fullyExpanded, autoCollapsed };
  }

  // Hold the previous decisions while the same widgets (keys, recency, budget,
  // width) are on screen and the block only moved a little: that absorbs height
  // jitter. A resize, a widget update, or a larger content change recomputes
  // instead. Wrapping depends on the column count, so a render at another width
  // (for example a `dump-screen --width` pass over the live tab) must not seed
  // decisions the on-screen layout then holds.
  const signature = `${budget}|${width}|${entries
    .map((entry) => `${entry.widget.key}#${entry.widget.updatedAt ?? 0}`)
    .join("|")}`;
  const naturalRows = inlineWidgetRows(entries, fullyExpanded);
  const deadband = Math.max(INLINE_TAIL_HOLD_DEADBAND_ROWS, Math.floor(budget * 0.2));
  const previousRows = tab.inlineWidgetAutoNaturalRows;
  // Re-expanding needs the fully expanded block to fit for two frames in a row:
  // one frame would let a one-row jitter flip the decisions back and forth,
  // while content that keeps shrinking still clears them.
  const fits = naturalRows <= budget;
  const fitStreak = fits ? (tab.inlineWidgetAutoFitStreak ?? 0) + 1 : 0;
  const hold =
    tab.inlineWidgetAutoSignature === signature &&
    previousRows !== undefined &&
    Math.abs(naturalRows - previousRows) <= deadband &&
    fitStreak < INLINE_TAIL_EXPAND_STREAK;
  tab.inlineWidgetAutoSignature = signature;
  tab.inlineWidgetAutoNaturalRows = naturalRows;
  tab.inlineWidgetAutoFitStreak = fitStreak;
  if (!hold) autoCollapsed.clear();
  const sticky = hold
    ? new Set([...autoCollapsed].filter((key) => !pinned.has(key)))
    : new Set<string>();
  const hidden = new Set([...manuallyCollapsed, ...sticky]);
  // Record automatic decisions once, so a header can say it collapsed itself.
  const finish = (bodyRows: Map<string, number>): InlineWidgetPlan => {
    for (const entry of entries) {
      const key = entry.widget.key;
      if (pinned.has(key) || hidden.has(key)) continue;
      if ((bodyRows.get(key) ?? 0) === 0) autoCollapsed.add(key);
      else autoCollapsed.delete(key);
    }
    return { bodyRows, autoCollapsed };
  };

  const natural = withBodies(naturalBodies, hidden);
  if (inlineWidgetRows(entries, natural) <= budget) return finish(natural);

  // A bare header stack that already overflows has one answer whatever the
  // bodies are, and deciding it here bounds the allocation work below by the
  // budget: an extension that registers many widgets stays linear per frame.
  const minimum = new Map(entries.map((entry) => [entry.widget.key, 0]));
  if (inlineWidgetRows(entries, minimum) > budget) {
    return { bodyRows: new Map<string, number>(), autoCollapsed };
  }

  // Hand complete bodies to the highest-priority widgets. The first widget
  // whose full body no longer fits is the cut: it and every lower-priority
  // widget collapse to its header. Pins were preloaded above and keep their
  // bodies even when they alone overflow the budget.
  const assigned = new Map(pinnedBodies);
  const byPriority = [...entries].sort((a, b) => compareInlinePriority(b, a));
  for (const entry of byPriority) {
    const key = entry.widget.key;
    if (hidden.has(key) || assigned.has(key)) continue;
    const candidate = new Map(assigned);
    candidate.set(key, naturalBody(entry));
    if (inlineWidgetRows(entries, withBodies(candidate, hidden)) > budget) break;
    assigned.set(key, naturalBody(entry));
  }
  return finish(withBodies(assigned, hidden));
}

/** Higher value = kept expanded longer: most recently updated, then registration order. */
function compareInlinePriority(a: InlineWidgetEntry, b: InlineWidgetEntry): number {
  const recency = (a.widget.updatedAt ?? 0) - (b.widget.updatedAt ?? 0);
  return recency !== 0 ? recency : b.order - a.order;
}

function inlineWidgetSummaryLine(widgetCount: number, bodyWidth: number, width: number): string {
  // Same staging as a collapsed header: the command is the actionable part, so
  // it outranks the count and the label.
  const prefix = truncateToWidth(
    `▸ Inline · ${widgetCount} widgets`,
    Math.max(1, bodyWidth - INLINE_SUMMARY_COMMAND_WIDTH),
    "…",
  );
  const candidates = [`${prefix} · /widgets expand`, `${prefix} · /widgets`, prefix];
  const text = candidates.find((candidate) => visibleWidth(candidate) <= bodyWidth) ?? prefix;
  return renderSingleLineExtensionSlot(activeRenderTheme.dim(text), width);
}

function renderExtensionWidgetsInner(
  tab: MixCodeTabInfo,
  width: number,
  placement: "aboveEditor" | "belowEditor",
): string[] {
  const widgets = tab.extensionUi.widgets.filter((widget) => widget.placement === placement);
  if (!widgets.length) return [];
  const bodyWidth = Math.max(1, width - 2);
  const lines: string[] = [];
  widgets.forEach((widget) => {
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
// Below this, a split would crush chat. Toggle refuses to open; render falls back.
export const EXTENSION_PANEL_MIN_TERMINAL_WIDTH = 80;

/**
 * Compute the side panel column width for a given terminal width. Clamped to a
 * usable minimum. Callers must not split below EXTENSION_PANEL_MIN_TERMINAL_WIDTH.
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
 * hidden edges. The first row is a dim pinned "Widgets" title and the final
 * row is a dim hint on how to close the panel; both collapse on tiny panels
 * (content wins). The
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

// Dim pinned title naming the panel, symmetric with the close hint below.
const EXTENSION_PANEL_TITLE = "Widgets";
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
  // Reserve the bottom row for a dim close hint, then the top row for the
  // panel title, each only when at least one content row remains; on a 1-row
  // panel the content wins.
  const hasHint = height >= 2;
  const hasTitle = height >= 3;
  const contentHeight = height - (hasHint ? 1 : 0) - (hasTitle ? 1 : 0);
  const content: string[] = [];
  ordered.forEach((widget, index) => {
    if (index > 0) content.push(blank);
    // Name each section by its widget key so stacked widgets from different
    // extensions stay distinguishable inside the panel.
    content.push(padLine(`${border} ${widgetSectionHeader(widget.key, bodyWidth)}`, panelWidth));
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
  if (hasTitle) {
    const title = truncateToWidth(EXTENSION_PANEL_TITLE, bodyWidth, "...");
    visible.unshift(padLine(`${border} ${activeRenderTheme.dim(title)}`, panelWidth));
  }
  if (hasHint) {
    const hint = truncateToWidth(EXTENSION_PANEL_CLOSE_HINT, bodyWidth, "...");
    visible.push(padLine(`${border} ${activeRenderTheme.dim(hint)}`, panelWidth));
  }
  return visible;
}

/**
 * Dim `─ key ───` rule heading one panel section. The label is the widget's
 * extension-chosen key, truncated to fit; the rule fills the body width.
 */
function widgetSectionHeader(key: string, bodyWidth: number): string {
  const label = truncateToWidth(sanitizeWidgetLine(key), Math.max(1, bodyWidth - 4), "...");
  const rule = "─".repeat(Math.max(0, bodyWidth - visibleWidth(label) - 3));
  return activeRenderTheme.dim(`─ ${label} ${rule}`);
}

// `▸ Inline · ` plus one label character and the space before the rule: the
// room a header hint may not claim.
const INLINE_HEADER_PREFIX_WIDTH = 13;
// Room kept for ` · /widgets expand` on the one-line summary row.
const INLINE_SUMMARY_COMMAND_WIDTH = 18;

function inlineWidgetSectionHeader(
  key: string,
  bodyWidth: number,
  collapsed = false,
  autoCollapsed = false,
): string {
  const hint = collapsed ? inlineWidgetHint(key, bodyWidth, autoCollapsed) : "";
  const label = truncateToWidth(
    sanitizeWidgetLine(key),
    Math.max(1, bodyWidth - 16 - visibleWidth(hint)),
    "...",
  );
  const inlineLabel = `▸ Inline · ${label}`;
  const rule = "─".repeat(
    Math.max(0, bodyWidth - visibleWidth(inlineLabel) - visibleWidth(hint) - 1),
  );
  // Long keys plus the expand hint can outgrow a narrow column; the header is
  // the only row describing a collapsed widget, so clip it instead of wrapping.
  return activeRenderTheme.dim(truncateToWidth(`${inlineLabel} ${rule}${hint}`, bodyWidth, "…"));
}

/**
 * Expand hint for a collapsed header, dropping the parts that do not fit: the
 * marker first, then the widget key, then the command's argument, so the
 * actionable part survives as long as the row allows.
 */
function inlineWidgetHint(key: string, bodyWidth: number, autoCollapsed: boolean): string {
  const budget = bodyWidth - INLINE_HEADER_PREFIX_WIDTH;
  const candidates = autoCollapsed
    ? [` (auto) /widgets expand ${key}`, ` /widgets expand ${key}`, " /widgets expand", " /widgets"]
    : [` /widgets expand ${key}`, " /widgets expand", " /widgets"];
  return candidates.find((candidate) => visibleWidth(candidate) <= budget) ?? "";
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

const TAB_FOCUS_MARK = "▌";
/**
 * Focus mark for a chip painted in a tab color. The glyph fills the inner half of
 * its cell, so the chip keeps its own color on the outer edge against whatever
 * surrounds the tab bar. The mark uses the color's contrast pair, which equals
 * that surrounding background in the matching theme (black under a dark
 * background, white under a light one), and on the outer half it would merge
 * with the background instead of reading as a bar.
 */
const TAB_FOCUS_MARK_INNER = "▐";
export const TAB_ACTIVE_SHIMMER_PERIOD_MS = 3000;
export const TAB_ACTIVE_SHIMMER_SWEEP_MS = 2000;

function withFocusMark(paint: (text: string) => string, body: string): string {
  return paintTabChip(paint, `${activeRenderTheme.vimBorder(TAB_FOCUS_MARK)}${body}`);
}

/**
 * Brightness steps of the active-tab wave, from the lit peak outwards. The
 * default steps use the theme's text and accent colors, which read over a theme
 * chip background only.
 */
export interface TabShimmerStyles {
  peak: (text: string) => string;
  shoulder: (text: string) => string;
  tail: (text: string) => string;
}

const THEME_SHIMMER_STYLES: TabShimmerStyles = {
  peak: (text) => activeRenderTheme.bold(activeRenderTheme.text(text)),
  shoulder: (text) => activeRenderTheme.bold(activeRenderTheme.accent(text)),
  tail: (text) => activeRenderTheme.accent(text),
};

/**
 * Wave steps for a chip painted in a tab color. Theme foregrounds have no
 * contrast over a chip color, and the chip's contrast pair provides no second
 * brightness level, so the wave inverts the lit cells with reverse video. That
 * keeps both halves of the pair and reads on every chip color. Weight stays with
 * the caller, so a done chip remains bold across the whole label.
 */
const COLORED_SHIMMER_STYLES: TabShimmerStyles = {
  peak: (text) => `\x1b[7m${text}\x1b[27m`,
  shoulder: (text) => `\x1b[7m${text}\x1b[27m`,
  tail: (text) => text,
};

/**
 * Apply a bouncing highlight to the active tab label. A brightness wave travels
 * to the right edge and back within TAB_ACTIVE_SHIMMER_SWEEP_MS (2000ms), then
 * the label renders unstyled for the remaining 1000ms of
 * TAB_ACTIVE_SHIMMER_PERIOD_MS.
 *
 * Two details carry the bounce. Each leg is eased so the wave decelerates into
 * the turnaround, and the brightness falls off over three steps so the lit
 * region reads as a moving peak rather than a block.
 */
export function applyActiveTabShimmer(
  text: string,
  activatedAt: number | undefined,
  now = Date.now(),
  styles: TabShimmerStyles = THEME_SHIMMER_STYLES,
): string {
  const baseTime = activatedAt ?? 0;
  const elapsed = (now - baseTime) % TAB_ACTIVE_SHIMMER_PERIOD_MS;
  if (elapsed >= TAB_ACTIVE_SHIMMER_SWEEP_MS) return text;

  // Calculate shimmer wave progress across visible characters.
  const chars = Array.from(text);
  const total = chars.length;
  if (total === 0) return text;

  const progress = elapsed / TAB_ACTIVE_SHIMMER_SWEEP_MS;
  // Triangle wave: travel right over the first half, return over the second.
  const leg = progress < 0.5 ? progress * 2 : (1 - progress) * 2;
  // Ease-out slows each leg as it approaches its turnaround.
  const eased = 1 - (1 - leg) * (1 - leg);
  // Turnarounds sit one cell outside the label so the wave still grazes the
  // first and last character; a wider overshoot leaves the label dark there.
  const waveCenter = eased * (total + 1) - 1;

  return chars
    .map((char, index) => {
      const dist = Math.abs(index - waveCenter);
      // Brightness falls off with distance from the wave center: peak, shoulder, tail.
      if (dist < 0.6) return styles.peak(char);
      if (dist < 1.6) return styles.shoulder(char);
      if (dist < 2.8) return styles.tail(char);
      return char;
    })
    .join("");
}

function tabBarSegments(state: MixCodeState): Array<{ id: string; text: string }> {
  const homeText = " MixCode Home ";
  const isHomeActive = state.activeTabId === HOME_TAB_ID;
  let homeBody = homeText;
  if (isHomeActive) {
    const rawRest = homeText.slice(1);
    const shimmery = applyActiveTabShimmer(rawRest, state.homeActivatedAt);
    homeBody = withFocusMark(activeRenderTheme.homeTabActive, shimmery);
  } else {
    homeBody = activeRenderTheme.homeTab(homeText);
  }
  return [
    { id: HOME_TAB_ID, text: homeBody },
    ...state.tabs.map((tab) => ({
      id: tab.sessionId,
      text: renderTabSegmentText(
        tab,
        state.activeTabId === tab.sessionId,
        recentAgentTabRank(state, tab.sessionId),
        state.activeTabId === HOME_TAB_ID,
      ),
    })),
  ];
}

function tabChipOpenSeq(paint: (text: string) => string): string {
  const marked = paint("\u0000");
  const index = marked.indexOf("\u0000");
  return index >= 0 ? marked.slice(0, index) : "";
}

function paintTabChip(paint: (text: string) => string, body: string): string {
  const open = tabChipOpenSeq(paint);
  if (!open) return paint(body);
  // Focus, status, and shimmer spans reset foreground, intensity, or inverse.
  // Re-open the chip so nested spans cannot strip the title's theme styling.
  return paint(body.replace(/\x1b\[(39|22|27)m/g, (reset) => `${reset}${open}`));
}

function tabStatusFg(tab: MixCodeTabInfo): ((text: string) => string) | undefined {
  if (tabIsWaitingForInput(tab)) return activeRenderTheme.waitingFg;
  if (tab.status === "running" || tab.status === "thinking") return activeRenderTheme.workingFg;
  if (tab.status === "error") return activeRenderTheme.errorFg;
  if (tab.status === "done" || tab.unreadDone) return activeRenderTheme.doneFg;
  return undefined;
}

function renderTabSegmentText(
  tab: MixCodeTabInfo,
  active: boolean,
  recentRank: number,
  onHome: boolean,
): string {
  const glyph = tabStatusGlyph(tab);
  const raw = ` ${glyph} ${tab.title} `;
  const fg = tabStatusFg(tab);
  const body = active ? applyActiveTabShimmer(raw.slice(1), tab.activatedAt) : raw;
  // Apply status color after the chip so default-color prefixes survive.
  const paint = (chip: (label: string) => string): string => {
    const rendered = active ? withFocusMark(chip, body) : paintTabChip(chip, body);
    return fg ? rendered.replace(glyph, `${fg(glyph)}${tabChipOpenSeq(chip)}`) : rendered;
  };
  // A colored chip takes its background and foreground from the color's
  // contrast pair, the only foreground with guaranteed contrast over that
  // background. The theme's success color measures under 3:1 against every chip
  // color, so a done chip keeps the pair and shows completion through the `✓`
  // glyph and a bold title; uncolored chips below keep the success color. Other
  // status colors (running, waiting, error) stay shape-only on colored chips.
  if (tab.color) {
    const idle = glyph === "✓" ? activeRenderTheme.bold(raw) : raw;
    // The wave inverts cells rather than recoloring them, and the enclosing bold
    // carries the label's weight in every phase, including the rest phase that
    // returns plain text.
    const shimmer = applyActiveTabShimmer(
      raw.slice(1),
      tab.activatedAt,
      Date.now(),
      COLORED_SHIMMER_STYLES,
    );
    return paintTabChip(
      tabColorPaint(tab.color),
      active ? `${TAB_FOCUS_MARK_INNER}${activeRenderTheme.bold(shimmer)}` : idle,
    );
  }
  if (glyph === "✓") {
    // Completion must remain visible regardless of recency, without borrowing the focus background.
    const base = active ? activeRenderTheme.activeTab : activeRenderTheme.recentTab;
    const completed = (label: string) =>
      base(activeRenderTheme.bold(activeRenderTheme.doneFg(label)));
    return paint(completed);
  }
  if (active) return paint(activeRenderTheme.activeTab);
  if (onHome) {
    if (recentRank === 0) return paint(activeRenderTheme.recentTab);
    if (recentRank === 1) return paint(activeRenderTheme.olderRecentTab);
    return paint(activeRenderTheme.tab);
  }
  if (recentRank === 1) return paint(activeRenderTheme.recentTab);
  if (recentRank === 2) return paint(activeRenderTheme.olderRecentTab);
  return paint(activeRenderTheme.tab);
}

export function tabStatusGlyph(tab: MixCodeTabInfo): string {
  if (tab.status === "Not Ready") {
    // Wall-clock driven braille frames: animation without per-tab state; needs a
    // periodic requestRender while any tab is loading (bindLoadingRedraw).
    return DEFAULT_WORKING_INDICATOR_FRAMES[
      Math.floor(Date.now() / DEFAULT_WORKING_INDICATOR_INTERVAL_MS) %
        DEFAULT_WORKING_INDICATOR_FRAMES.length
    ]!;
  }
  if (tab.status === "error") return "x";
  if (tabIsWaitingForInput(tab)) return "?";
  if (tab.status === "running" || tab.status === "thinking") return "●";
  if (tab.status === "done" || tab.unreadDone) return "✓";
  return "-";
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

/** Seconds elapsed since an ISO stamp, rendered as `1h 02m 03s` / `2m 05s` / `7s`. */
export function formatElapsed(startedAt: string | undefined, now: Date): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedSeconds = Number.isFinite(start)
    ? Math.max(0, Math.floor((now.getTime() - start) / 1000))
    : 0;
  return formatDuration(elapsedSeconds);
}

export function formatDuration(elapsedSeconds: number): string {
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
