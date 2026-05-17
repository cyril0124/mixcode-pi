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
