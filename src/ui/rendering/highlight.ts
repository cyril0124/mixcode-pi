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
 * nesting safely inside persistent background wraps like theme.selection
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
