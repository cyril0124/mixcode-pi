import { visibleWidth } from "@earendil-works/pi-tui";

export interface VisibleColumnRange {
  startCol: number;
  endCol: number;
  current?: boolean;
}

/** Apply styles to visible column ranges without discarding embedded ANSI/OSC sequences. */
export function highlightVisibleColumnRanges(
  line: string,
  ranges: readonly VisibleColumnRange[],
  style: (text: string, range: VisibleColumnRange) => string,
): string {
  let result = line;
  for (const range of [...ranges].sort((left, right) => right.startCol - left.startCol)) {
    const bounds = rawBoundsForVisibleColumns(result, range.startCol, range.endCol);
    if (!bounds) continue;
    const before = result.slice(0, bounds.start);
    const highlighted = result.slice(bounds.start, bounds.end);
    const after = result.slice(bounds.end);
    const restore = activeSgrAt(result, bounds.end);
    result = `${before}${styleAnsiText(highlighted, (text) => style(text, range))}${restore}${after}`;
  }
  return result;
}

const visibleSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function rawBoundsForVisibleColumns(
  text: string,
  startCol: number,
  endCol: number,
): { start: number; end: number } | undefined {
  if (endCol <= startCol) return undefined;
  let column = 0;
  let index = 0;
  let start: number | undefined;
  let end: number | undefined;
  while (index < text.length && column < endCol) {
    const ansi = extractAnsiCode(text, index);
    if (ansi) {
      if (start === undefined && column >= startCol) start = index;
      index += ansi.length;
      continue;
    }
    let plainEnd = index;
    while (plainEnd < text.length && !extractAnsiCode(text, plainEnd)) plainEnd++;
    const plain = text.slice(index, plainEnd);
    for (const item of visibleSegmenter.segment(plain)) {
      const rawStart = index + item.index;
      const rawEnd = rawStart + item.segment.length;
      const width = visibleWidth(item.segment);
      if (column < endCol && column + width > startCol) {
        start ??= rawStart;
        end = rawEnd;
      }
      column += width;
      if (column >= endCol) break;
    }
    index = plainEnd;
  }
  return start !== undefined && end !== undefined ? { start, end } : undefined;
}

function activeSgrAt(text: string, end: number): string {
  const codes: string[] = [];
  for (let index = 0; index < end; ) {
    const ansi = extractAnsiCode(text, index);
    if (!ansi) {
      index++;
      continue;
    }
    if (/^\x1b\[[0-9;]*m$/.test(ansi.code)) {
      const params = ansi.code.slice(2, -1);
      if (!params || params.split(";").includes("0")) codes.length = 0;
      codes.push(ansi.code);
    }
    index += ansi.length;
  }
  return codes.join("");
}

function styleAnsiText(text: string, style: (text: string) => string): string {
  let result = "";
  let plainStart = 0;
  let index = 0;
  while (index < text.length) {
    const ansi = extractAnsiCode(text, index);
    if (!ansi) {
      index++;
      continue;
    }
    if (index > plainStart) result += style(text.slice(plainStart, index));
    result += ansi.code;
    index += ansi.length;
    plainStart = index;
  }
  if (plainStart < text.length) result += style(text.slice(plainStart));
  return result;
}

function extractAnsiCode(text: string, position: number): { code: string; length: number } | null {
  if (text[position] !== "\x1b") return null;
  const kind = text[position + 1];
  if (kind === "[") {
    let end = position + 2;
    while (end < text.length && !/[\x40-\x7e]/.test(text[end]!)) end++;
    return end < text.length
      ? { code: text.slice(position, end + 1), length: end + 1 - position }
      : null;
  }
  if (kind !== "]" && kind !== "_") return null;
  let end = position + 2;
  while (end < text.length) {
    if (text[end] === "\x07") {
      return { code: text.slice(position, end + 1), length: end + 1 - position };
    }
    if (text[end] === "\x1b" && text[end + 1] === "\\") {
      return { code: text.slice(position, end + 2), length: end + 2 - position };
    }
    end++;
  }
  return null;
}

/**
 * Split `text` into matched/unmatched runs by `positions` (indices into
 * `text`, from fuzzyMatchPositions / fuzzyMatchAllPositions /
 * substringMatchPositions) and style each run independently.
 *
 * Runs are emitted as flat, self-closed ANSI spans placed side by side \u2014
 * never one nested inside another's open/close pair. That matters because
 * SGR "off" codes like bold-off (\x1b[22m) are global state, not a stack: if
 * a highlighted run were nested inside another open/close pair (e.g.
 * theme.bold(...) wrapped around a whole already-colored row), the run's own
 * closing code would turn that outer style off partway through the row.
 * Keeping matched/unmatched runs as siblings avoids that, while still
 * nesting safely inside persistent background wraps like theme.selectedBg
 * (see rendering/primitives.ts), which are engineered to survive embedded
 * resets.
 */
export function highlightRanges(
  text: string,
  positions: readonly number[],
  styleMatch: (segment: string) => string,
  styleRest: (segment: string) => string = (segment) => segment,
): string {
  if (positions.length === 0) return styleRest(text);
  const sorted = [...new Set(positions)].sort((a, b) => a - b);
  let result = "";
  let cursor = 0;
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i]!;
    let end = start;
    while (i + 1 < sorted.length && sorted[i + 1] === end + 1) {
      end++;
      i++;
    }
    if (start > cursor) result += styleRest(text.slice(cursor, start));
    result += styleMatch(text.slice(start, end + 1));
    cursor = end + 1;
    i++;
  }
  if (cursor < text.length) result += styleRest(text.slice(cursor));
  return result;
}
