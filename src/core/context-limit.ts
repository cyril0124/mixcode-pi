import { pushToast } from "./toast.js";
import type { MixCodeTabInfo, PickerItem } from "./types.js";

/**
 * Parse a user-provided context limit value string.
 * Accepts formats: "32000", "32k", "32K", "32.5k", "reset".
 * Returns the parsed token count, or "reset" for the reset command.
 * Returns undefined if the input is invalid.
 */
export function parseContextLimitValue(input: string): number | "reset" | undefined {
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return undefined;
  if (trimmed === "reset") return "reset";

  // Match number with optional 'k' suffix
  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*k?$/);
  if (!match) return undefined;

  const numStr = match[1]!;
  const hasK = trimmed.endsWith("k");
  const value = parseFloat(numStr);

  if (!Number.isFinite(value) || value <= 0) return undefined;

  const tokens = hasK ? Math.round(value * 1000) : Math.round(value);
  if (tokens <= 0) return undefined;

  return tokens;
}

/**
 * Generate dynamic picker items based on the model's context window.
 * Returns ¼, ½, ¾, Full (reset), and Custom options.
 */
export function contextLimitPickerItems(modelContextWindow: number): PickerItem[] {
  const quarter = Math.round(modelContextWindow / 4);
  const half = Math.round(modelContextWindow / 2);
  const threeQuarter = Math.round((modelContextWindow * 3) / 4);

  return [
    {
      id: String(quarter),
      label: formatCompactTokens(quarter),
      description: "¼ of model capacity",
    },
    {
      id: String(half),
      label: formatCompactTokens(half),
      description: "½ of model capacity",
    },
    {
      id: String(threeQuarter),
      label: formatCompactTokens(threeQuarter),
      description: "¾ of model capacity",
    },
    {
      id: "reset",
      label: formatCompactTokens(modelContextWindow),
      description: "Full (reset to default)",
    },
    {
      id: "custom",
      label: "Custom",
      description: "Enter a custom value...",
    },
  ];
}

/**
 * Apply a context limit value to a tab.
 * Shows appropriate toast feedback.
 */
export function applyContextLimit(
  tab: MixCodeTabInfo,
  value: number | "reset",
): void {
  if (value === "reset") {
    tab.contextLimit = tab.model.contextWindow;
    tab.contextLimitOverridden = false;
    pushToast(tab, `✓ Context limit reset to ${formatCompactTokens(tab.model.contextWindow)}`);
    return;
  }

  tab.contextLimit = value;
  tab.contextLimitOverridden = true;

  if (value > tab.model.contextWindow) {
    pushToast(
      tab,
      `⚠ Set to ${formatCompactTokens(value)} (model: ${formatCompactTokens(tab.model.contextWindow)})`,
    );
  } else {
    pushToast(tab, `✓ Context limit: ${formatCompactTokens(value)}`);
  }
}

/**
 * Format a token count in compact form (e.g. "32k", "131k").
 */
function formatCompactTokens(tokens: number): string {
  const value = tokens / 1_000;
  if (Number.isInteger(value)) return `${value.toFixed(0)}k`;
  return `${value.toFixed(1)}k`;
}
