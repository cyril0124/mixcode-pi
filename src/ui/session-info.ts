/**
 * /session dump formatter aligned with Pi interactive-mode handleSessionCommand.
 * Cache waste + usage breakdown come from Pi (patched public exports).
 */
import {
  computeCacheWaste,
  getUsageCostBreakdown,
  type ModelPriceSource,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export type SessionStatsLike = {
  sessionFile?: string;
  sessionId: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
};

export type SessionNameSource = {
  getSessionName?: () => string | undefined | null;
  getEntries?: () => SessionEntry[];
};

const EMPTY_MODEL_PRICES: ModelPriceSource = { getModel: () => undefined };

/** Compact token counts for cost breakdown lines (Pi footer formatTokens). */
export function formatSessionTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

export function renderSessionInfoText(
  session: SessionNameSource,
  info: SessionStatsLike,
  options: {
    entries?: SessionEntry[];
    models?: ModelPriceSource;
  } = {},
): string {
  const name = session.getSessionName?.() ?? undefined;
  const entries = options.entries ?? session.getEntries?.() ?? [];
  const cacheWaste = computeCacheWaste(entries, options.models ?? EMPTY_MODEL_PRICES);
  const usageBreakdown = getUsageCostBreakdown(entries);

  const lines: string[] = ["Session Info", ""];
  if (name) lines.push(`Name: ${name}`);
  lines.push(
    `File: ${info.sessionFile ?? "In-memory"}`,
    `ID: ${info.sessionId}`,
    "",
    "Messages",
    `Total: ${info.totalMessages}`,
    `User: ${info.userMessages}`,
    `Assistant: ${info.assistantMessages}`,
    `Tools: ${info.toolCalls} calls, ${info.toolResults} results`,
    "",
    "Tokens",
  );

  const { input, cacheRead, cacheWrite, output, total } = info.tokens;
  const promptTokens = input + cacheRead + cacheWrite;
  lines.push(`Input: ${promptTokens.toLocaleString()}`);
  if (promptTokens > 0 && (cacheRead > 0 || cacheWrite > 0)) {
    const hitRate = ((cacheRead / promptTokens) * 100).toFixed(1);
    lines.push(`  Cached: ${cacheRead.toLocaleString()} (${hitRate}%)`);
    const written =
      cacheWrite > 0 ? ` (${cacheWrite.toLocaleString()} written to cache)` : "";
    lines.push(`  Uncached: ${(input + cacheWrite).toLocaleString()}${written}`);
  }
  lines.push(`Output: ${output.toLocaleString()}`, `Total: ${total.toLocaleString()}`);

  if (info.cost > 0 || cacheWaste.missedTokens > 0) {
    lines.push("", "Cost", `Total: $${info.cost.toFixed(3)}`);
    if (usageBreakdown.length > 1) {
      for (const entry of usageBreakdown) {
        lines.push(
          `  ${entry.key}: $${entry.cost.toFixed(3)} (${formatSessionTokens(entry.tokens)} tokens)`,
        );
      }
    }
    if (cacheWaste.missedTokens > 0) {
      const missLabel =
        cacheWaste.missCount === 1 ? "1 miss" : `${cacheWaste.missCount} misses`;
      const detail = `${cacheWaste.missedTokens.toLocaleString()} tokens, ${missLabel}`;
      lines.push(
        cacheWaste.missedCost >= 0.0001
          ? `Cache Re-billed: $${cacheWaste.missedCost.toFixed(3)} (${detail})`
          : `Cache Re-billed: ${detail}`,
      );
    }
  }

  return lines.join("\n");
}
