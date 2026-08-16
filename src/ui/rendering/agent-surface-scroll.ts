import { stripTerminalSequences } from "@earendil-works/pi-tui";
import type { ChatLine } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

// Default per-block height assumption used before any block has been rendered
// once. Roughly matches a typical assistant paragraph at 120 cols.
export const BLOCK_HEIGHT_FALLBACK = 4;

// Per-tab scroll-freeze bookkeeping. When the user has scrolled up (offset > 0)
// and new content streams in below, we "freeze" the viewport on a stable anchor
// so the visible text does not jump. Resize re-anchors via ChatLine + progress.
interface ScrollFreezeState {
  total: number;
  width: number;
  height: number;
  offset?: number;
  frozen?: boolean;
  /** Rendered-line fallback (width-stable matching). */
  line?: string;
  row?: number;
  /** Stable message object for reflow-tolerant resize anchoring. */
  chatLine?: ChatLine;
  /** 0–1 progress through the anchored chat block (top of viewport content). */
  blockProgress?: number;
  /** Exact row inside the anchored block and the height it was recorded at. */
  blockRow?: number;
  blockRowHeight?: number;
  /**
   * User scroll delta this frame (wheel/key). Applied after anchor re-pin so
   * stream growth can be absorbed without undoing intentional scrolling.
   */
  userDelta?: number;
}
const scrollFreezeStates = new WeakMap<MixCodeTabInfo, ScrollFreezeState>();

/** Drop freeze metadata so the next scroll starts from the live tail. */
export function clearScrollFreeze(tab: MixCodeTabInfo): void {
  scrollFreezeStates.delete(tab);
}

export interface ChatBlockLayout {
  line: ChatLine;
  start: number;
  height: number;
}

/** Whether the tab's viewport is currently frozen at a scrolled-up anchor. */
export function isScrollFrozen(tab: MixCodeTabInfo): boolean {
  return scrollFreezeStates.get(tab)?.frozen === true;
}

/**
 * Keep the scrolled-up view stable when total content height grows. Returns
 * true when growth adjusted the offset so callers can re-run layout.
 *
 * Same-frame user scroll + stream growth:
 *   1. Capture userDelta, reset to last frame's offset
 *   2. Absorb content growth onto that base
 *   3. Keep frozen so apply* re-pins to the old anchor (fixes estimate noise)
 *   4. applyPendingScrollUserDelta restores the intentional scroll
 */
export function keepScrolledViewStable(
  tab: MixCodeTabInfo,
  total: number,
  width: number,
  height: number,
): boolean {
  const previous = scrollFreezeStates.get(tab);
  const grew = total > (previous?.total ?? total);
  const sameSize = previous?.width === width && previous?.height === height;
  const scrolledUp = tab.chatScrollOffset > 0;
  const userDelta =
    previous && sameSize ? tab.chatScrollOffset - (previous.offset ?? tab.chatScrollOffset) : 0;
  let adjusted = false;
  if (scrolledUp && sameSize && previous !== undefined) {
    // Work from last frame's offset so apply* can re-pin, then re-apply userDelta.
    tab.chatScrollOffset = previous.offset ?? tab.chatScrollOffset;
    if (grew) {
      tab.chatScrollOffset += total - previous.total;
      adjusted = true;
    }
  }
  // Freeze when scrolled up with stable size (including same-frame user scroll).
  const canFreeze = scrolledUp && sameSize && previous !== undefined;
  // Stay frozen across size changes so apply* can re-align to the anchor.
  const keepFrozen =
    scrolledUp && Boolean(previous?.line || previous?.chatLine) && (canFreeze || !sameSize);
  scrollFreezeStates.set(tab, {
    ...previous,
    total,
    width,
    height,
    offset: tab.chatScrollOffset,
    frozen: keepFrozen || canFreeze,
    // Preserve userDelta across freezeAdjusted re-renders (keep is skipped then).
    userDelta: userDelta !== 0 ? userDelta : previous?.userDelta,
  });
  return adjusted;
}

/** Re-apply intentional user scroll after anchor re-pin. */
export function applyPendingScrollUserDelta(tab: MixCodeTabInfo): void {
  const state = scrollFreezeStates.get(tab);
  const userDelta = state?.userDelta ?? 0;
  if (!state || userDelta === 0) return;
  tab.chatScrollOffset = Math.max(0, tab.chatScrollOffset + userDelta);
  scrollFreezeStates.set(tab, {
    ...state,
    offset: tab.chatScrollOffset,
    userDelta: 0,
  });
}

/**
 * Re-align chatScrollOffset onto the remembered anchor line so the frozen
 * viewport shows the same content after content above it changed height.
 * Also used after resize when rendered lines still match the stored text.
 */
export function applyScrollFreezeAnchor(
  tab: MixCodeTabInfo,
  lines: string[],
  viewport: number,
  width: number,
  allowChatLineFallback = false,
): void {
  const state = scrollFreezeStates.get(tab);
  if (tab.chatScrollOffset <= 0 || !state?.frozen || !state.line) {
    return;
  }
  // Windowed rendering applies the stronger ChatLine anchor first. Full
  // rendering has no block layouts, so it must fall back to the rendered line.
  if (state.chatLine && !allowChatLineFallback) return;
  const index = findScrollFreezeAnchorIndex(
    lines,
    state.line,
    viewport,
    tab.chatScrollOffset,
    state.row ?? 0,
  );
  if (index < 0) return;
  const maxStart = Math.max(0, lines.length - viewport);
  const start = Math.max(0, Math.min(index - (state.row ?? 0), maxStart));
  tab.chatScrollOffset = Math.max(0, lines.length - (start + viewport));
  // Keep bookkeeping aligned with the new layout size after re-anchor.
  scrollFreezeStates.set(tab, {
    ...state,
    width,
    height: viewport,
    offset: tab.chatScrollOffset,
    frozen: true,
  });
}

/**
 * Re-align offset using a stable ChatLine + progress through that block.
 * Survives width reflow where rendered line text no longer matches. Returns
 * false when callers must fall back to the rendered-line anchor.
 */
export function applyChatBlockScrollAnchor(
  tab: MixCodeTabInfo,
  blocks: readonly ChatBlockLayout[],
  linesLength: number,
  viewport: number,
  width: number,
): boolean {
  const state = scrollFreezeStates.get(tab);
  if (tab.chatScrollOffset <= 0 || !state?.frozen || !state.chatLine) return false;
  let block = blocks.find((entry) => entry.line === state.chatLine);
  if (!block) {
    // Session rebuild may drop object identity; fall back to entryId/text match.
    block = blocks.find(
      (entry) =>
        (state.chatLine?.entryId && entry.line.entryId === state.chatLine.entryId) ||
        (state.chatLine?.text &&
          entry.line.role === state.chatLine.role &&
          entry.line.text === state.chatLine.text),
    );
  }
  if (!block || block.height <= 0) return false;
  const progress = Math.min(1, Math.max(0, state.blockProgress ?? 0));
  // Prefer the exact remembered row when the block height is unchanged:
  // floor(progress * height) is not round-trip stable (56/142*142 floors to 55
  // under IEEE rounding) and intermittently drifts the viewport up one row.
  const rowInBlock =
    state.blockRow !== undefined && state.blockRowHeight === block.height
      ? Math.min(block.height - 1, state.blockRow)
      : Math.min(block.height - 1, Math.round(progress * block.height));
  const index = block.start + rowInBlock;
  const maxStart = Math.max(0, linesLength - viewport);
  const start = Math.max(0, Math.min(index - (state.row ?? 0), maxStart));
  tab.chatScrollOffset = Math.max(0, linesLength - (start + viewport));
  scrollFreezeStates.set(tab, {
    ...state,
    width,
    height: viewport,
    offset: tab.chatScrollOffset,
    frozen: true,
  });
  return true;
}

/** Strip terminal controls so invisible rows are not treated as content. */
function visibleText(line: string): string {
  return stripTerminalSequences(line).trim();
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
    scrollFreezeStates.set(tab, {
      total: current.total,
      width,
      height,
      offset: tab.chatScrollOffset,
    });
    return;
  }
  // Prefer real message text over padded blank rows. Theme backgrounds leave
  // ANSI on whitespace-only lines; line.trim() alone treats those as content
  // and the freeze anchor then matches the wrong blank row after growth.
  const row = visible.findIndex((line) => {
    const text = visibleText(line);
    return text.length > 0 && !text.includes("older above") && !text.includes("newer below");
  });
  scrollFreezeStates.set(tab, {
    ...current,
    width,
    height,
    offset: tab.chatScrollOffset,
    frozen: current.frozen === true && current.offset === tab.chatScrollOffset,
    line: row >= 0 ? visible[row] : undefined,
    row: row >= 0 ? row : undefined,
    // A full-render anchor owns the rendered line; stale windowed ChatLine
    // metadata would otherwise snap the next windowed frame back to old content.
    chatLine: undefined,
    blockProgress: undefined,
  });
}

/**
 * Remember a ChatLine-based anchor after a windowed render. Call after the
 * visible window is known so progress reflects the new layout.
 */
export function rememberChatBlockScrollAnchor(
  tab: MixCodeTabInfo,
  blocks: readonly ChatBlockLayout[],
  windowStart: number,
  visible: string[],
  width: number,
  height: number,
): void {
  const current = scrollFreezeStates.get(tab) ?? { total: 0, width, height };
  if (tab.chatScrollOffset <= 0) {
    scrollFreezeStates.set(tab, {
      total: current.total,
      width,
      height,
      offset: tab.chatScrollOffset,
    });
    return;
  }
  const row = visible.findIndex((line) => {
    const text = visibleText(line);
    return text.length > 0 && !text.includes("older above") && !text.includes("newer below");
  });
  const absolute = windowStart + Math.max(0, row);
  const block = blocks.find(
    (entry) => absolute >= entry.start && absolute < entry.start + entry.height,
  );
  const blockProgress =
    block && block.height > 0
      ? Math.min(1, Math.max(0, (absolute - block.start) / block.height))
      : undefined;
  scrollFreezeStates.set(tab, {
    ...current,
    width,
    height,
    offset: tab.chatScrollOffset,
    frozen: true,
    line: row >= 0 ? visible[row] : undefined,
    row: row >= 0 ? row : undefined,
    chatLine: block?.line,
    blockProgress,
    blockRow: block ? absolute - block.start : undefined,
    blockRowHeight: block?.height,
  });
}

function findScrollFreezeAnchorIndex(
  lines: string[],
  line: string,
  viewport: number,
  scrollOffset: number,
  row: number,
): number {
  const expected = Math.max(
    0,
    Math.min(lines.length - 1, lines.length - scrollOffset - viewport + row),
  );
  for (let distance = 0; distance < lines.length; distance++) {
    const before = expected - distance;
    if (before >= 0 && lines[before] === line) return before;
    const after = expected + distance;
    if (after < lines.length && lines[after] === line) return after;
  }
  // Reflow may change padding/ANSI; match by visible text as a second pass.
  const target = visibleText(line);
  if (!target) return -1;
  for (let distance = 0; distance < lines.length; distance++) {
    const before = expected - distance;
    if (before >= 0 && visibleText(lines[before]!) === target) return before;
    const after = expected + distance;
    if (after < lines.length && visibleText(lines[after]!) === target) return after;
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
 * Apply the same boundary markers fitScrolledLinesWithInfo applies (↑ older
 * above / ↓ newer below) so the windowed output is visually identical.
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
    out[0] = padLine(activeRenderTheme.dim("↑ older above"), width);
  }
  if (start + visible.length < total) {
    out[out.length - 1] = padLine(activeRenderTheme.dim("↓ newer below"), width);
  }
  return out;
}
