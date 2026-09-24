// No tokenizer dependency ships with the project; callers must label these
// numbers as estimates. CJK chars tokenize at roughly one per char vs ~4 chars
// per token for latin text, so counting them separately keeps proportions sane
// for Chinese-heavy AGENTS.md files and skill descriptions.
const CJK_RE =
  /[\u{1100}-\u{11FF}\u{3040}-\u{30FF}\u{3130}-\u{318F}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{AC00}-\u{D7AF}\u{F900}-\u{FAFF}\u{FF00}-\u{FFEF}]/gu;

/**
 * Estimate the token count of prompt text.
 *
 * Single home for the project's heuristic (~4 chars/token, ~1/CJK char). The
 * `/context` panel and the `/system-prompt` and `/system-tools` stats must agree,
 * so callers share this instead of growing their own approximation.
 */
export function estimateTextTokens(text: string): number {
  const cjk = (text.match(CJK_RE) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}
