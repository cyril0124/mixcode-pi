import { cropKittyImageLine, getKittyImageMetadata } from "@earendil-works/pi-tui";
import { activeRenderTheme } from "./context.js";
import { isImageSequenceLine, padLine } from "./primitives.js";

// Column isolation: a left-column row may end with SGR state still open
// (e.g. after in-pane overlay compositing). Reset explicitly so the separator
// and the right column never inherit styling from the left column.
const SGR_RESET = "\x1b[0m";

export function joinColumns(
  left: string[],
  right: string[],
  leftWidth: number,
  rightWidth: number,
): string[] {
  const height = Math.max(left.length, right.length);
  return Array.from({ length: height }, (_, index) => {
    const rightCell = `${SGR_RESET} ${padLine(right[index] ?? "", rightWidth)}`;
    const leftCell = left[index] ?? "";
    // Kitty placements do not advance the cursor, so an inline image row cannot be
    // space-padded: those pad cells would paint over the placement. Jump straight
    // to the separator column instead.
    if (isImageSequenceLine(leftCell)) return `${leftCell}\x1b[${leftWidth + 1}G${rightCell}`;
    return `${padLine(leftCell, leftWidth)}${rightCell}`;
  });
}

/**
 * Restore and crop image placements after slicing/decorating a chat viewport.
 * Source rows must include the complete rendered blocks intersecting the window;
 * Kitty stores the transmission on the first row and reserves empty rows below.
 * Returns a copy so viewport crops never overwrite cached full-image commands.
 */
export function clipChatImages(source: string[], start: number, visible: string[]): string[] {
  if (visible.length === 0) return visible;
  const end = start + visible.length;
  const result = visible.slice();
  for (let row = 0; row < Math.min(source.length, end); row++) {
    const line = source[row]!;
    const image = getKittyImageMetadata(line);
    if (!image || row + image.rows <= start) continue;
    const firstVisibleRow = Math.max(start, row);
    const hiddenRows = firstVisibleRow - row;
    const visibleRows = Math.min(row + image.rows, end) - firstVisibleRow;
    result[firstVisibleRow - start] = cropKittyImageLine(line, hiddenRows, visibleRows);
  }
  return result;
}

export function fitTailLines(lines: string[], maxHeight: number, width: number): string[] {
  const height = Math.max(0, Math.floor(maxHeight));
  if (height === 0) return [];
  if (lines.length <= height) return lines;
  const marker = padLine(activeRenderTheme.dim("↑ older above"), width);
  if (height === 1) return [marker];
  return [marker, ...lines.slice(-(height - 1))];
}

export interface ScrolledLinesResult {
  lines: string[];
  total: number;
  height: number;
  start: number;
  end: number;
  scrollable: boolean;
}

export function fitScrolledLinesWithInfo(
  lines: string[],
  maxHeight: number,
  width: number,
  scrollOffset: number,
): ScrolledLinesResult {
  const height = Math.max(0, Math.floor(maxHeight));
  if (height === 0)
    return { lines: [], total: lines.length, height, start: 0, end: 0, scrollable: false };
  if (lines.length <= height)
    return {
      lines,
      total: lines.length,
      height,
      start: 0,
      end: lines.length,
      scrollable: false,
    };
  const offset = Math.max(0, Math.floor(scrollOffset));
  if (offset === 0) {
    const fitted = fitTailLines(lines, height, width);
    return {
      lines: fitted,
      total: lines.length,
      height,
      start: Math.max(0, lines.length - height),
      end: lines.length,
      scrollable: true,
    };
  }
  if (height === 1) {
    const start = Math.max(0, lines.length - offset - 1);
    const end = Math.min(lines.length, Math.max(1, lines.length - offset));
    const marker = start > 0 ? "↑ older above" : "↓ newer below";
    return {
      lines: [padLine(activeRenderTheme.dim(marker), width)],
      total: lines.length,
      height,
      start,
      end,
      scrollable: true,
    };
  }
  const end = Math.min(lines.length, Math.max(height, lines.length - offset));
  const start = Math.max(0, end - height);
  const window = lines.slice(start, end);
  if (start > 0 && window.length > 0)
    window[0] = padLine(activeRenderTheme.dim("↑ older above"), width);
  if (end < lines.length && window.length > 1)
    window[window.length - 1] = padLine(activeRenderTheme.dim("↓ newer below"), width);
  return { lines: window, total: lines.length, height, start, end, scrollable: true };
}

export function fitHeadLines(lines: string[], maxHeight: number, width: number): string[] {
  const height = Math.max(0, Math.floor(maxHeight));
  if (height === 0) return [];
  if (lines.length <= height) return lines;
  const marker = padLine(activeRenderTheme.dim("↓ newer below"), width);
  if (height === 1) return [marker];
  return [...lines.slice(0, height - 1), marker];
}
