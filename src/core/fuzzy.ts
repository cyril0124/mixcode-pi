export function fuzzyContains(query: string, text: string): boolean {
  if (!query) return true;
  if (!text) return false;
  let qi = 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  for (const ch of t) {
    if (ch === q[qi]) qi += 1;
    if (qi === q.length) return true;
  }
  return false;
}

export function fuzzyMatch(query: string, name: string): number | undefined {
  if (!query) return 0;
  if (!name || query.length > name.length) return undefined;
  return fuzzyContains(query, name) ? name.length - query.length : undefined;
}

export function fuzzyMatchBatch(
  query: string,
  candidates: string[],
  limit = 20,
): Array<[number, string]> {
  const scored: Array<[number, string]> = [];
  for (const candidate of candidates) {
    const score = fuzzyMatch(query, candidate);
    if (score !== undefined) scored.push([score, candidate]);
  }
  return scored.sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1])).slice(0, limit);
}

export function fuzzyMatchBatchScored(query: string, candidates: string[]): Map<number, number> {
  const result = new Map<number, number>();
  candidates.forEach((candidate, index) => {
    const score = fuzzyMatch(query, candidate);
    if (score !== undefined) result.set(index, score);
  });
  return result;
}
