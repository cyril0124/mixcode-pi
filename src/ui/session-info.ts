/**
 * /session dump formatter aligned with Pi interactive-mode handleSessionCommand.
 * Cache waste comes from Pi cache-stats (patched public export); usage breakdown
 * stays local until usage-totals is also exported.
 */
import type { Usage } from "@earendil-works/pi-ai";
import {
  computeCacheWaste,
  type ModelPriceSource,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";

export {
  computeCacheWaste,
  type CacheWasteTotals,
  type ModelPriceSource,
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

type UsageTotals = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
};

export type UsageCostBreakdownEntry = {
  key: string;
  cost: number;
  tokens: number;
};

const EMPTY_MODEL_PRICES: ModelPriceSource = { getModel: () => undefined };

function createUsageTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
}

function addUsageToTotals(totals: UsageTotals, usage: Usage): void {
  totals.input += usage.input;
  totals.output += usage.output;
  totals.cacheRead += usage.cacheRead;
  totals.cacheWrite += usage.cacheWrite;
  totals.cost += usage.cost.total;
}

/** Group attributable assistant usage by model; tools/summaries share one bucket. */
export function getUsageCostBreakdown(entries: SessionEntry[]): UsageCostBreakdownEntry[] {
  const totalsByKey = new Map<string, UsageTotals>();
  for (const entry of entries) {
    let key: string | undefined;
    let usage: Usage | undefined;
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as {
        provider: string;
        model: string;
        responseModel?: string;
        usage: Usage;
      };
      key = `${message.provider}/${message.responseModel ?? message.model}`;
      usage = message.usage;
    } else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.usage) {
      key = "Tools/summaries";
      usage = entry.message.usage;
    } else if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
      key = "Tools/summaries";
      usage = entry.usage;
    }
    if (!key || !usage) continue;
    let totals = totalsByKey.get(key);
    if (!totals) {
      totals = createUsageTotals();
      totalsByKey.set(key, totals);
    }
    addUsageToTotals(totals, usage);
  }
  return Array.from(totalsByKey, ([key, totals]) => ({
    key,
    cost: totals.cost,
    tokens: totals.input + totals.output + totals.cacheRead + totals.cacheWrite,
  }))
    .filter((entry) => entry.cost > 0 || entry.tokens > 0)
    .sort((a, b) => b.cost - a.cost);
}

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
