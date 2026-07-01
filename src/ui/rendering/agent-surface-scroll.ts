import type { ChatLine } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

// Default per-block height assumption used before any block has been rendered
// once. Roughly matches a typical assistant paragraph at 120 cols.
export const BLOCK_HEIGHT_FALLBACK = 4;

// Per-tab scroll-freeze bookkeeping. When the user has scrolled up (offset > 0)
// and new content streams in below, we "freeze" the viewport on a stable anchor
// line so the visible text does not jump. State is keyed on the tab object.
interface ScrollFreezeState {
  total: number;
  width: number;
  height: number;
  offset?: number;
  frozen?: boolean;
  line?: string;
  row?: number;
}
const scrollFreezeStates = new WeakMap<MixCodeTabInfo, ScrollFreezeState>();

/** Whether the tab's viewport is currently frozen at a scrolled-up anchor. */
export function isScrollFrozen(tab: MixCodeTabInfo): boolean {
  return scrollFreezeStates.get(tab)?.frozen === true;
}

/**
 * Keep the scrolled-up view stable when total content height grows. Returns
 * true when the viewport is (still) frozen so callers can re-run layout with
 * the adjusted offset.
 */
export function keepScrolledViewStable(
  tab: MixCodeTabInfo,
  total: number,
  width: number,
  height: number,
): boolean {
  const previous = scrollFreezeStates.get(tab);
  const grew = total > (previous?.total ?? total);
  const canFreeze =
    tab.chatScrollOffset > 0 &&
    previous?.width === width &&
    previous.height === height &&
    previous.offset === tab.chatScrollOffset;
  if (canFreeze && grew) {
    tab.chatScrollOffset += total - previous.total;
  }
  scrollFreezeStates.set(tab, {
    ...previous,
    total,
    width,
    height,
    offset: tab.chatScrollOffset,
    frozen: canFreeze,
  });
  return canFreeze;
}

/**
 * Re-align chatScrollOffset onto the remembered anchor line so the frozen
 * viewport shows the same content after content above it changed height.
 */
export function applyScrollFreezeAnchor(
  tab: MixCodeTabInfo,
  lines: string[],
  viewport: number,
  width: number,
): void {
  const state = scrollFreezeStates.get(tab);
  if (
    tab.chatScrollOffset <= 0 ||
    !state?.frozen ||
    state.offset !== tab.chatScrollOffset ||
    !state.line ||
    state.width !== width ||
    state.height !== viewport
  ) {
    return;
  }
  const index = findScrollFreezeAnchorIndex(lines, state.line, viewport, tab.chatScrollOffset, state.row ?? 0);
  if (index < 0) return;
  const maxStart = Math.max(0, lines.length - viewport);
  const start = Math.max(0, Math.min(index - (state.row ?? 0), maxStart));
  tab.chatScrollOffset = Math.max(0, lines.length - (start + viewport));
}

/** Remember the top visible non-marker line as the freeze anchor for next frame. */
export function rememberScrollFreezeAnchor(
  tab: MixCodeTabInfo,
  visible: string[],
  width: number,
  height: number,
): void {
  const current = scrollFreezeStates.get(tab) ?? { total: 0, width, height };
  if (tab.chatScrollOffset <= 0) {
    scrollFreezeStates.set(tab, { total: current.total, width, height, offset: tab.chatScrollOffset });
    return;
  }
  const row = visible.findIndex((line) => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.includes("... older above") && !trimmed.includes("... newer below");
  });
  scrollFreezeStates.set(tab, {
    ...current,
    width,
    height,
    offset: tab.chatScrollOffset,
    frozen: current.frozen === true && current.offset === tab.chatScrollOffset,
    line: row >= 0 ? visible[row] : undefined,
    row: row >= 0 ? row : undefined,
  });
}

function findScrollFreezeAnchorIndex(
  lines: string[],
  line: string,
  viewport: number,
  scrollOffset: number,
  row: number,
): number {
  const expected = Math.max(0, Math.min(lines.length - 1, lines.length - scrollOffset - viewport + row));
  for (let distance = 0; distance < lines.length; distance++) {
    const before = expected - distance;
    if (before >= 0 && lines[before] === line) return before;
    const after = expected + distance;
    if (after < lines.length && lines[after] === line) return after;
  }
  return -1;
}

/**
 * Estimate total virtual height. Uses cached heights for blocks already
 * rendered, BLOCK_HEIGHT_FALLBACK for blocks not yet rendered. Ignores
 * separator rows for the un-rendered prefix to keep the estimate simple
 * (±few rows error is acceptable for scrollbar thumb only).
 *
 * `extraRows` counts non-chat rows that are always present at the top of the
 * scrollable surface (e.g. the extension header), so scroll bounds and the
 * scrollbar thumb stay correct.
 */
export function estimateTotalHeight(
  chat: ChatLine[],
  queueRows: number,
  width: number,
  frameBlockHeights: ReadonlyMap<ChatLine, number>,
  extraRows = 0,
): number {
  void width;
  let total = queueRows + Math.max(0, extraRows);
  let nonEmpty = 0;
  for (const line of chat) {
    const h = frameBlockHeights.get(line) ?? BLOCK_HEIGHT_FALLBACK;
    total += h;
    if (h > 0) nonEmpty++;
  }
  total += Math.max(0, nonEmpty - 1);
  return total;
}

/**
 * Apply the same boundary markers fitScrolledLinesWithInfo applies (... older
 * above / ... newer below) so the windowed output is visually identical.
 */
export function decorateWindow(
  visible: string[],
  start: number,
  total: number,
  viewport: number,
  width: number,
): string[] {
  if (visible.length === 0) return visible;
  const out = visible.slice();
  if (viewport <= 1) return out;
  if (start > 0) {
    out[0] = padLine(activeRenderTheme.dim("... older above"), width);
  }
  if (start + visible.length < total) {
    out[out.length - 1] = padLine(activeRenderTheme.dim("... newer below"), width);
  }
  return out;
}
