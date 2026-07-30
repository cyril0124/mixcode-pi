import { fuzzyMatch as piFuzzyMatch } from "@earendil-works/pi-tui";

/**
 * Pi TUI fuzzy score adapter: lower is better; undefined = no match.
 * Call sites sort with Number.POSITIVE_INFINITY for non-matches.
 */
export function fuzzyMatch(query: string, text: string): number | undefined {
  const match = piFuzzyMatch(query, text);
  return match.matches ? match.score : undefined;
}

/**
 * Indices in `text` matched by `query` via leftmost-greedy subsequence scan
 * (case-insensitive). Used for highlight rendering — pi-tui does not export
 * match positions. Returns [] when query is empty or does not fully match.
 *
 * ponytail: does not replicate fuzzyMatch's rare alphanumeric-swap fallback
 * (e.g. "2v" vs "v2"); those matches render unhighlighted.
 */
export function fuzzyMatchPositions(query: string, text: string): number[] {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  const positions: number[] = [];
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      positions.push(i);
      qi++;
    }
  }
  return qi === q.length ? positions : [];
}

/**
 * Union of fuzzyMatchPositions for every whitespace-separated token.
 * All tokens must match; returns [] if any fails or query has no tokens.
 */
export function fuzzyMatchAllPositions(query: string, text: string): number[] {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return [];
  const positions = new Set<number>();
  for (const token of tokens) {
    const tokenPositions = fuzzyMatchPositions(token, text);
    if (tokenPositions.length === 0) return [];
    for (const pos of tokenPositions) positions.add(pos);
  }
  return [...positions].sort((a, b) => a - b);
}

/**
 * Indices of the first case-insensitive contiguous substring match of `query`.
 * For plain includes-style filters (e.g. workdir picker), not fuzzy subsequence.
 */
export function substringMatchPositions(query: string, text: string): number[] {
  if (!query) return [];
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return [];
  return Array.from({ length: query.length }, (_, i) => index + i);
}
