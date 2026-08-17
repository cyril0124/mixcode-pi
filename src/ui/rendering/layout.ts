import { visibleWidth } from "@earendil-works/pi-tui";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

export function centerLine(text: string, width: number): string {
  const left = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return `${" ".repeat(left)}${text}`;
}

export function joinColumns(
  left: string[],
  right: string[],
  leftWidth: number,
  rightWidth: number,
): string[] {
  const height = Math.max(left.length, right.length);
  return Array.from(
    { length: height },
    (_, index) =>
      `${padLine(left[index] ?? "", leftWidth)} ${padLine(right[index] ?? "", rightWidth)}`,
  );
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
