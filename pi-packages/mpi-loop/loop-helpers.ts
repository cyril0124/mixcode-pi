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

export interface ParseResult {
  intervalMs: number;
  intervalLabel: string;
  prompt: string;
}

/**
 * Parse `[interval] <prompt>` using the same priority rules as the original skill:
 * 1. Leading token that matches \d+[smhd]
 * 2. Trailing "every <interval>" clause
 * 3. Default interval (DEFAULT_INTERVAL)
 */
export function parseArgs(input: string): ParseResult | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Rule 1 — leading token
  const leading = trimmed.match(/^\S+/)?.[0] ?? "";
  const leadingMs = parseIntervalToken(leading);
  if (leadingMs !== null) {
    const prompt = trimmed.slice(leading.length).trim();
    return { intervalMs: leadingMs, intervalLabel: leading.toLowerCase(), prompt };
  }

  // Rule 2 — trailing "every <interval>" or "every <number> <unit>"
  const trailingExact = trimmed.match(
    /^([\s\S]+?)\s+every\s+(\d+(?:\.\d+)?)(s|m|h|d|seconds?|minutes?|hours?|days?)$/i,
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
    return { intervalMs: ms, intervalLabel: token, prompt };
  }

  // Rule 3 — default
  const defaultMs = parseIntervalToken(DEFAULT_INTERVAL)!;
  return { intervalMs: defaultMs, intervalLabel: DEFAULT_INTERVAL, prompt: trimmed };
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

  let timeStr: string;
  if (days > 0) {
    timeStr = `${days}d`;
  } else if (hours > 0) {
    timeStr = `${hours}h`;
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
