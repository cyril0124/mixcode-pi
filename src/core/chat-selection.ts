import {
  getGraphemeCellRange,
  sliceByColumn,
  stripTerminalSequences,
  visibleWidth,
} from "@earendil-works/pi-tui";

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

interface ScrollableChatSelectionSource {
  originOffset: number;
  lines: Map<number, string>;
}

const scrollableChatSelections = new WeakMap<ChatSelectionState, ScrollableChatSelectionSource>();

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

/** Track visible rows while a drag scrolls so release can copy off-screen text. */
export function startScrollableChatSelection(
  selection: ChatSelectionState,
  lines: string[],
  scrollOffset: number,
): void {
  scrollableChatSelections.set(selection, { originOffset: scrollOffset, lines: new Map() });
  captureScrollableChatSelection(selection, lines, scrollOffset);
}

export function captureScrollableChatSelection(
  selection: ChatSelectionState,
  lines: string[],
  scrollOffset: number,
): void {
  const source = scrollableChatSelections.get(selection);
  if (!source) return;
  const firstRow = source.originOffset - scrollOffset;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row] ?? "";
    if (!isChatScrollMarker(line)) source.lines.set(firstRow + row, line);
  }
}

export function toScrollableChatSelectionPoint(
  selection: ChatSelectionState,
  point: ChatSelectionPoint,
  lines: string[],
  scrollOffset: number,
): ChatSelectionPoint {
  const source = scrollableChatSelections.get(selection);
  if (!source) return point;
  const row = selectableChatRow(lines, point.row);
  return { row: row + source.originOffset - scrollOffset, col: point.col };
}

export function scrollableChatSelectionForViewport(
  selection: ChatSelectionState,
  scrollOffset: number,
): ChatSelectionState {
  const source = scrollableChatSelections.get(selection);
  if (!source) return selection;
  const rowDelta = scrollOffset - source.originOffset;
  return {
    ...selection,
    anchor: { ...selection.anchor, row: selection.anchor.row + rowDelta },
    focus: { ...selection.focus, row: selection.focus.row + rowDelta },
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

/** Visible [start, end) for `row`, snapped to grapheme cells like Pi TuiAltScreen.getSelectionColumns. */
function chatSelectionColumns(
  line: string,
  row: number,
  selection: ChatSelectionState,
): { start: number; end: number } | undefined {
  const normalized = normalizeChatSelection(selection);
  if (row < normalized.start.row || row > normalized.end.row) return undefined;
  const lineWidth = visibleWidth(line);
  let start = 0;
  let end = lineWidth;
  if (row === normalized.start.row) {
    start =
      getGraphemeCellRange(line, normalized.start.col)?.start ??
      Math.min(normalized.start.col, lineWidth);
  }
  if (row === normalized.end.row) {
    end =
      getGraphemeCellRange(line, normalized.end.col)?.end ??
      Math.min(normalized.end.col + 1, lineWidth);
  }
  start = Math.max(0, start);
  end = Math.min(lineWidth, end);
  if (end <= start) return undefined;
  return { start, end };
}

export function selectedChatText(lines: string[], selection: ChatSelectionState): string {
  if (isCollapsedChatSelection(selection)) return "";
  const normalized = normalizeChatSelection(selection);
  const parts: string[] = [];
  for (let row = normalized.start.row; row <= normalized.end.row; row++) {
    const line = lines[row] ?? "";
    const columns = chatSelectionColumns(line, row, selection);
    if (!columns) {
      parts.push("");
      continue;
    }
    parts.push(
      stripTerminalSequences(
        sliceByColumn(line, columns.start, columns.end - columns.start, true),
      ).trimEnd(),
    );
  }
  return parts.join("\n").replace(/[ \t]+$/gm, "");
}

export function selectedScrollableChatText(
  visibleLines: string[],
  selection: ChatSelectionState,
): string {
  const source = scrollableChatSelections.get(selection);
  if (!source) return selectedChatText(visibleLines, selection);
  const normalized = normalizeChatSelection(selection);
  const lines: string[] = [];
  for (let row = normalized.start.row; row <= normalized.end.row; row++) {
    lines.push(source.lines.get(row) ?? "");
  }
  const shift = normalized.start.row;
  return selectedChatText(lines, {
    ...selection,
    anchor: { ...selection.anchor, row: selection.anchor.row - shift },
    focus: { ...selection.focus, row: selection.focus.row - shift },
  });
}

export function selectedInputText(lines: string[], selection: ChatSelectionState): string {
  return selectedChatText(lines, selection)
    .split("\n")
    .map(normalizeInputSelectionLine)
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** Notice panel copy: drop box borders and the "c/y copy" hint row. */
export function selectedNoticeText(lines: string[], selection: ChatSelectionState): string {
  return selectedChatText(lines, selection)
    .split("\n")
    .map(normalizeNoticeSelectionLine)
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function highlightChatSelectionLine(
  line: string,
  row: number,
  selection: ChatSelectionState | undefined,
  highlight: (text: string) => string,
): string {
  if (!selection || isCollapsedChatSelection(selection)) return line;
  const columns = chatSelectionColumns(line, row, selection);
  if (!columns) return line;
  const lineWidth = visibleWidth(line);
  const before = sliceByColumn(line, 0, columns.start, true);
  const selected = sliceByColumn(line, columns.start, columns.end - columns.start, true);
  const after = sliceByColumn(line, columns.end, Math.max(0, lineWidth - columns.end), true);
  if (!selected) return line;
  return `${before}${applyChatSelectionHighlight(selected, highlight)}${after}`;
}

/** Re-apply selection after every SGR so tool/thinking block backgrounds cannot paint over it. */
function applyChatSelectionHighlight(
  text: string,
  highlight: (text: string) => string,
): string {
  const open = highlightOpen(highlight);
  if (!open || !text.includes("\x1b")) return highlight(text);
  return highlight(text.replace(/\x1b\[[0-9;:]*m/g, (sequence) => `${sequence}${open}`));
}

function highlightOpen(highlight: (text: string) => string): string {
  const marked = highlight("\x01");
  const index = marked.indexOf("\x01");
  return index > 0 ? marked.slice(0, index) : "";
}

function normalizeInputSelectionLine(line: string): string | undefined {
  const visible = line.trimEnd();
  if (isBoxBorderLine(visible)) return undefined;
  const unframed = stripVerticalBorders(visible);
  const body = trimInputChromePadding(unframed.text);
  if (unframed.framed && isFramedInputHintLine(body)) return undefined;
  return body;
}

function normalizeNoticeSelectionLine(line: string): string | undefined {
  const visible = line.trimEnd();
  if (isBoxBorderLine(visible)) return undefined;
  const unframed = stripVerticalBorders(visible);
  const body = unframed.text.trimEnd();
  if (/\bc\/y copy\b/i.test(body) || /\bEsc close\b/i.test(body)) return undefined;
  return body;
}

function isBoxBorderLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (/^[─━═]{3,}$/.test(trimmed)) return true;
  return /^[┌└╭╰╔╚╒╘╓╙].*[┐┘╮╯╗╝╕╛╖╜]$/.test(trimmed) && /[─━═]/.test(trimmed);
}

function stripVerticalBorders(line: string): { text: string; framed: boolean } {
  if (/^[│┃║].*[│┃║]$/.test(line)) return { text: line.slice(1, -1), framed: true };
  if (/^[│┃║]/.test(line)) return { text: line.slice(1), framed: true };
  if (/[│┃║]$/.test(line)) return { text: line.slice(0, -1), framed: true };
  return { text: line, framed: false };
}

function trimInputChromePadding(line: string): string {
  return line.startsWith(" ") ? line.slice(1).trimEnd() : line.trimEnd();
}

function isFramedInputHintLine(line: string): boolean {
  return /[↑↓←→⏎]/.test(line) && /\b(?:enter|ctrl|shift|tab|scroll|select|accept|cancel)\b/i.test(line);
}

function isChatScrollMarker(line: string): boolean {
  const text = stripTerminalSequences(line).trim();
  return text === "↑ older above" || text === "↓ newer below";
}

function selectableChatRow(lines: string[], row: number): number {
  const text = stripTerminalSequences(lines[row] ?? "").trim();
  if (text === "↑ older above") return Math.min(lines.length - 1, row + 1);
  if (text === "↓ newer below") return Math.max(0, row - 1);
  return row;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
