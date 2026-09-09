/** Shared pure helpers for mpi-loop command parsing and display. */

export const DEFAULT_INTERVAL = "10m";
export const MIN_INTERVAL_MS = 10_000; // 10 seconds
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Parse a token like "5m", "2h", "30s", "1d" → milliseconds, or null. */
export function parseIntervalToken(token: string): number | null {
  const m = token.match(/^(\d+(?:\.\d+)?)(s|m|h|d)$/i);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const unit = m[2]!.toLowerCase();
  switch (unit) {
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    case "d":
      return n * 86_400_000;
    default:
      return null;
  }
}

/** Human-readable label for an interval in ms. */
export function formatInterval(ms: number): string {
  if (ms < 60_000) return `${Math.round(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}

export class LoopInputError extends Error {}

/** Validate a total against executed runs. Throws LoopInputError for invalid totals. */
export function validateRunLimit(maxFireCount: number | null, fireCount: number): void {
  if (maxFireCount === null) return;
  if (!Number.isSafeInteger(maxFireCount) || maxFireCount < 1) {
    throw new LoopInputError("Error: Max runs must be a positive safe integer or unlimited.");
  }
  if (maxFireCount < fireCount) {
    throw new LoopInputError(
      `Error: Total runs cannot be below the ${fireCount} already executed.`,
    );
  }
}

/** Parse a positive integer or 'unlimited'; invalid totals throw LoopInputError. */
export function parseMaxRuns(value: string, fireCount = 0): number | null {
  if (value === "unlimited") return null;
  if (!/^\d+$/.test(value)) {
    throw new LoopInputError("Error: Max runs must be a positive safe integer or unlimited.");
  }
  const maxFireCount = Number(value);
  validateRunLimit(maxFireCount, fireCount);
  return maxFireCount;
}

export interface ParseResult {
  intervalMs: number;
  intervalLabel: string;
  prompt: string;
  maxFireCount: number | null;
}

/**
 * Parse `[interval] [--max-runs N] [--] <prompt>`, preserving internal prompt whitespace.
 * A leading interval overrides a trailing `every <interval>` clause; otherwise use the default.
 * `--` makes the remaining prompt literal, including a trailing interval clause.
 * Options are consumed only before the prompt. Invalid options throw LoopInputError.
 */
export function parseArgs(input: string): ParseResult | null {
  let remaining = input.trim();
  if (!remaining) return null;

  const leading = remaining.match(/^\S+/)?.[0] ?? "";
  const leadingMs = parseIntervalToken(leading);
  if (leadingMs !== null) remaining = remaining.slice(leading.length).trim();

  let maxFireCount: number | null = null;
  if (/^--max-runs(?:\s|$)/.test(remaining)) {
    remaining = remaining.slice("--max-runs".length).trim();
    const value = remaining.match(/^\S+/)?.[0] ?? "";
    maxFireCount = parseMaxRuns(value);
    if (maxFireCount === null) {
      throw new LoopInputError("Error: --max-runs requires a positive safe integer.");
    }
    remaining = remaining.slice(value.length).trim();
    if (/^--max-runs(?:\s|$)/.test(remaining)) {
      throw new LoopInputError("Error: --max-runs may only be specified once.");
    }
  }

  const literalPrompt = /^--(?:\s|$)/.test(remaining);
  if (literalPrompt) remaining = remaining.slice(2).trim();

  if (leadingMs !== null) {
    return {
      intervalMs: leadingMs,
      intervalLabel: leading.toLowerCase(),
      prompt: remaining,
      maxFireCount,
    };
  }

  const trailingExact = literalPrompt
    ? null
    : remaining.match(
        /^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?)\s*(s|m|h|d|seconds?|minutes?|hours?|days?)$/i,
      );
  if (trailingExact) {
    const rawUnit = trailingExact[3]!.toLowerCase();
    const canonicalUnit = rawUnit.startsWith("s")
      ? "s"
      : rawUnit.startsWith("m")
        ? "m"
        : rawUnit.startsWith("h")
          ? "h"
          : "d";
    const token = `${trailingExact[2]}${canonicalUnit}`;
    const ms = parseIntervalToken(token)!;
    const prompt = trailingExact[1]!.trim();
    return { intervalMs: ms, intervalLabel: token, prompt, maxFireCount };
  }

  const defaultMs = parseIntervalToken(DEFAULT_INTERVAL)!;
  return {
    intervalMs: defaultMs,
    intervalLabel: DEFAULT_INTERVAL,
    prompt: remaining,
    maxFireCount,
  };
}

export function formatRelativeTime(date: Date | number): string {
  const now = Date.now();
  const target = typeof date === "number" ? date : date.getTime();
  const diff = target - now;
  const absDiff = Math.abs(diff);

  const seconds = Math.floor(absDiff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  // Keep the smaller unit so nearly two hours does not appear as only one hour.
  let timeStr: string;
  if (days > 0) {
    const remainingHours = hours % 24;
    timeStr = `${days}d`;
    if (remainingHours > 0) timeStr += `${remainingHours}h`;
  } else if (hours > 0) {
    const remainingMinutes = minutes % 60;
    timeStr = `${hours}h`;
    if (remainingMinutes > 0) timeStr += `${remainingMinutes}m`;
  } else if (minutes > 0) {
    timeStr = `${minutes}m`;
  } else {
    timeStr = `${seconds}s`;
  }

  return diff > 0 ? `in ${timeStr}` : `${timeStr} ago`;
}

export function generateName(prompt: string): string {
  // Extract first meaningful word from prompt
  const words = prompt.trim().split(/\s+/);
  const first = words[0] || "loop";
  // Remove slash prefix if it's a command
  const clean = first.startsWith("/") ? first.slice(1) : first;
  return clean.substring(0, 15);
}

// pi-core invalidates extension ctx after session replacement/reload. Match the
// stable substring so real bugs still surface while async timers/widgets exit cleanly.
export function isStaleCtxError(e: unknown): boolean {
  return /stale after session replacement/.test(String(e));
}
