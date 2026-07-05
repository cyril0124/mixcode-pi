import { fuzzyFilter, fuzzyMatch as piFuzzyMatch } from "@earendil-works/pi-tui";

/**
 * Compatibility wrapper around Pi TUI fuzzy matching.
 * MixCode keeps its historical number/undefined API while sharing Pi's scoring semantics.
 */
export function fuzzyContains(query: string, text: string): boolean {
  return piFuzzyMatch(query, text).matches;
}

export function fuzzyMatch(query: string, name: string): number | undefined {
  const match = piFuzzyMatch(query, name);
  return match.matches ? match.score : undefined;
}

export function fuzzyMatchBatch(
  query: string,
  candidates: string[],
  limit = 20,
): Array<[number, string]> {
  return fuzzyFilter(candidates, query, (candidate) => candidate)
    .slice(0, limit)
    .map((candidate) => [fuzzyFilterScore(query, candidate) ?? 0, candidate]);
}

export function fuzzyMatchBatchScored(query: string, candidates: string[]): Map<number, number> {
  const result = new Map<number, number>();
  candidates.forEach((candidate, index) => {
    const score = fuzzyFilterScore(query, candidate);
    if (score !== undefined) result.set(index, score);
  });
  return result;
}

function fuzzyFilterScore(query: string, text: string): number | undefined {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) return 0;
  let total = 0;
  for (const token of tokens) {
    const match = piFuzzyMatch(token, text);
    if (!match.matches) return undefined;
    total += match.score;
  }
  return total;
}

/**
 * Indices in `text` matched by `query`'s characters via the same leftmost-
 * greedy left-to-right subsequence scan pi-tui's fuzzyMatch uses internally
 * to decide match/no-match (case-insensitive). This is a standalone scan for
 * rendering match highlights — it does not reuse or reimplement fuzzyMatch's
 * scoring math, only mirrors the same character-by-character advance.
 * Returns [] when `query` is empty or does not fully match `text`.
 *
 * ponytail: does not replicate fuzzyMatch's rare alphanumeric-swap fallback
 * (e.g. a query like "2v" matching text "v2"); such matches simply render
 * unhighlighted. Add if reported as a real gap.
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
 * Union of fuzzyMatchPositions for every whitespace-separated token in
 * `query`, mirroring fuzzyMatchBatch/fuzzyFilterScore's tokenization (all
 * tokens must match). Returns [] if any token fails to match `text`, or the
 * query has no tokens.
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
 * Indices of the first case-insensitive substring occurrence of `query` in
 * `text`. Mirrors plain `.includes()`-style filters (e.g. the workdir
 * picker), which match a contiguous substring rather than a fuzzy
 * subsequence. Returns [] when not found or `query` is empty.
 */
export function substringMatchPositions(query: string, text: string): number[] {
  if (!query) return [];
  const index = text.toLowerCase().indexOf(query.toLowerCase());
  if (index === -1) return [];
  return Array.from({ length: query.length }, (_, i) => index + i);
}
