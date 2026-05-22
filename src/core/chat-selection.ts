import { visibleWidth } from "@earendil-works/pi-tui";

export interface ChatSurfaceBounds {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface ChatSelectionPoint {
  row: number;
  col: number;
}

export interface ChatSelectionState {
  anchor: ChatSelectionPoint;
  focus: ChatSelectionPoint;
  dragging: boolean;
}

export interface NormalizedChatSelection {
  start: ChatSelectionPoint;
  end: ChatSelectionPoint;
}

export function pointInChatSurface(
  bounds: ChatSurfaceBounds | undefined,
  point: ChatSelectionPoint,
): boolean {
  if (!bounds) return false;
  return (
    point.row >= bounds.top &&
    point.row < bounds.top + bounds.height &&
    point.col >= bounds.left &&
    point.col < bounds.left + bounds.width
  );
}

export function screenToChatSelectionPoint(
  bounds: ChatSurfaceBounds,
  row: number,
  col: number,
): ChatSelectionPoint {
  return {
    row: clamp(Math.floor(row - bounds.top), 0, Math.max(0, bounds.height - 1)),
    col: clamp(Math.floor(col - bounds.left), 0, Math.max(0, bounds.width)),
  };
}

export function normalizeChatSelection(
  selection: ChatSelectionState,
): NormalizedChatSelection {
  const anchor = selection.anchor;
  const focus = selection.focus;
  if (anchor.row < focus.row || (anchor.row === focus.row && anchor.col <= focus.col)) {
    return { start: anchor, end: focus };
  }
  return { start: focus, end: anchor };
}

export function isCollapsedChatSelection(selection: ChatSelectionState): boolean {
  return selection.anchor.row === selection.focus.row && selection.anchor.col === selection.focus.col;
}

export function selectedChatText(lines: string[], selection: ChatSelectionState): string {
  if (isCollapsedChatSelection(selection)) return "";
  const normalized = normalizeChatSelection(selection);
  const parts: string[] = [];
  for (let row = normalized.start.row; row <= normalized.end.row; row++) {
    const text = stripAnsi(lines[row] ?? "").trimEnd();
    const startCol = row === normalized.start.row ? normalized.start.col : 0;
    const endCol = row === normalized.end.row ? normalized.end.col : visibleWidth(text);
    parts.push(sliceVisibleText(text, startCol, endCol));
  }
  return parts.join("\n").replace(/[ \t]+$/gm, "");
}

export function highlightChatSelectionLine(
  line: string,
  row: number,
  selection: ChatSelectionState | undefined,
  highlight: (text: string) => string,
): string {
  if (!selection || isCollapsedChatSelection(selection)) return line;
  const normalized = normalizeChatSelection(selection);
  if (row < normalized.start.row || row > normalized.end.row) return line;
  const plain = stripAnsi(line);
  const lineWidth = visibleWidth(plain);
  const startCol = row === normalized.start.row ? normalized.start.col : 0;
  const endCol = row === normalized.end.row ? normalized.end.col : lineWidth;
  if (endCol <= startCol) return line;
  const before = sliceVisibleText(plain, 0, startCol);
  const selected = sliceVisibleText(plain, startCol, endCol);
  const after = sliceVisibleText(plain, endCol, lineWidth);
  return `${before}${highlight(selected)}${after}`;
}

export function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;:]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[PX^_][\s\S]*?(?:\x07|\x1b\\)/g, "");
}

function sliceVisibleText(text: string, start: number, end: number): string {
  const from = Math.max(0, Math.floor(start));
  const to = Math.max(from, Math.floor(end));
  let width = 0;
  let output = "";
  for (const char of text) {
    const nextWidth = width + visibleWidth(char);
    if (nextWidth > from && width < to) output += char;
    width = nextWidth;
    if (width >= to) break;
  }
  return output;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
