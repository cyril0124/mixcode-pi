/**
 * /session dump formatter aligned with Pi interactive-mode handleSessionCommand.
 * Pure layout + Pi-equivalent usage breakdown / cache-waste helpers (not public exports).
 */
import type { Usage } from "@earendil-works/pi-ai";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";

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

export type ModelPriceSource = {
  getModel(
    provider: string,
    modelId: string,
  ): { cost: { cacheRead: number } } | undefined;
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

export type CacheWasteTotals = {
  missedTokens: number;
  missedCost: number;
  missCount: number;
};

const NOISE_FLOOR_TOKENS = 1024;

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

type PreviousRequest = {
  promptTokens: number;
  modelKey: string;
  timestamp: number;
  reportedCache: boolean;
};

type CacheMiss = {
  missedTokens: number;
  missedCost: number;
};

function detectMiss(
  prev: PreviousRequest | undefined,
  message: {
    provider: string;
    model: string;
    timestamp: number;
    usage: Usage;
  },
  models?: ModelPriceSource,
): CacheMiss | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (
    !prev ||
    promptTokens <= 0 ||
    (usage.cacheRead + usage.cacheWrite === 0 && !prev.reportedCache)
  ) {
    return undefined;
  }
  const missedTokens = Math.min(prev.promptTokens, promptTokens) - usage.cacheRead;
  if (missedTokens <= NOISE_FLOOR_TOKENS) return undefined;
  const paidTokens = usage.input + usage.cacheWrite;
  const paidPerToken =
    paidTokens > 0 ? (usage.cost.input + usage.cost.cacheWrite) / paidTokens : 0;
  const readPerToken =
    usage.cacheRead > 0
      ? usage.cost.cacheRead / usage.cacheRead
      : (models?.getModel(message.provider, message.model)?.cost.cacheRead ?? 0) / 1_000_000;
  return {
    missedTokens,
    missedCost: missedTokens * Math.max(0, paidPerToken - readPerToken),
  };
}

function asPreviousRequest(
  message: {
    provider: string;
    model: string;
    timestamp: number;
    usage: Usage;
  },
  reportedCache: boolean,
): PreviousRequest | undefined {
  const usage = message.usage;
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  if (promptTokens <= 0) return undefined;
  return {
    promptTokens,
    modelKey: `${message.provider}/${message.model}`,
    timestamp: message.timestamp,
    reportedCache: reportedCache || usage.cacheRead + usage.cacheWrite > 0,
  };
}

/** Cumulative cache waste across a session (Pi computeCacheWaste semantics). */
export function computeCacheWaste(
  entries: SessionEntry[],
  models?: ModelPriceSource,
): CacheWasteTotals {
  let prev: PreviousRequest | undefined;
  const totals: CacheWasteTotals = { missedTokens: 0, missedCost: 0, missCount: 0 };
  for (const entry of entries) {
    if (entry.type === "compaction" || entry.type === "branch_summary") {
      prev = undefined;
      continue;
    }
    if (entry.type === "message" && entry.message.role === "assistant") {
      const message = entry.message as {
        provider: string;
        model: string;
        timestamp: number;
        usage: Usage;
      };
      const miss = detectMiss(prev, message, models);
      if (miss) {
        totals.missedTokens += miss.missedTokens;
        totals.missedCost += miss.missedCost;
        totals.missCount += 1;
      }
      prev = asPreviousRequest(message, prev?.reportedCache ?? false) ?? prev;
    }
  }
  return totals;
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
  const cacheWaste = computeCacheWaste(entries, options.models);
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
