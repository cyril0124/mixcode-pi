import type { SystemPromptSection } from "../../core/system-prompt.js";
import { estimateTextTokens } from "../../core/token-estimate.js";

const NAME_WIDTH = 48;

/** One named chunk of text in a token breakdown table. */
interface TokenBreakdownRow {
  name: string;
  text: string;
}

/**
 * Render a fenced token breakdown table.
 *
 * Contract: pure formatting. `totalText` supplies the denominator for the
 * percentage column and the Total row, so callers pass the full text the rows
 * decompose. Empty rows are omitted. `notes` lines are printed under the
 * heading.
 */
export function renderTokenBreakdown(
  heading: string,
  rows: readonly TokenBreakdownRow[],
  totalText: string,
  notes: readonly string[] = [],
): string {
  const totalTokens = estimateTextTokens(totalText);
  const line = (name: string, text: string) => {
    const tokens = estimateTextTokens(text);
    const pct = totalTokens > 0 ? ((tokens / totalTokens) * 100).toFixed(1) : "0.0";
    const label =
      name.length > NAME_WIDTH ? `…${name.slice(-(NAME_WIDTH - 1))}` : name.padEnd(NAME_WIDTH);
    return `${label} ${String(text.length).padStart(7)} chars ${`~${tokens}`.padStart(9)} tok ${pct.padStart(5)}%`;
  };
  const lines = ["---", heading, ...notes];
  for (const row of rows) {
    if (row.text.length === 0) continue;
    lines.push(line(row.name, row.text));
  }
  lines.push(line("Total", totalText));
  return `\n\`\`\`\n${lines.join("\n")}\n\`\`\`\n`;
}

/**
 * Render the /system-prompt stats footer for a section breakdown.
 *
 * Contract: pure formatting, no mutation. Sections must concatenate to the
 * assembled base prompt. Per-turn extension overrides commonly re-emit the
 * base with extra text around it (e.g. appended mode instructions like
 * ponytail); the override delta is decomposed generically into prefix/suffix
 * rows so it stays counted, with totals over the effective prompt. Only when
 * the base cannot be located inside the effective prompt at all does the table
 * describe the base alone, with an explicit note line saying so.
 */
export function renderSystemPromptSectionStats(
  sections: readonly SystemPromptSection[],
  effectivePrompt: string,
): string {
  const assembled = sections.map((s) => s.text).join("");
  const rows = [...sections];
  let covered = assembled;
  let mismatchNote: string | undefined;
  if (effectivePrompt !== assembled) {
    const at = effectivePrompt.indexOf(assembled);
    if (at === -1) {
      mismatchNote =
        "(describes the assembled base prompt; effective prompt differs - extension override or format drift)";
    } else {
      const prefix = effectivePrompt.slice(0, at);
      const suffix = effectivePrompt.slice(at + assembled.length);
      if (prefix) rows.unshift({ name: "(extension override prefix)", text: prefix });
      if (suffix) rows.push({ name: "(extension override suffix)", text: suffix });
      covered = effectivePrompt;
    }
  }

  return renderTokenBreakdown(
    "System prompt section breakdown (token estimates are heuristic: ~4 chars/token, ~1/CJK char):",
    rows,
    covered,
    mismatchNote ? [mismatchNote] : [],
  );
}
