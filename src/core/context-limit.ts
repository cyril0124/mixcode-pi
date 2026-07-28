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
    pushToast(tab, {
      type: "success",
      message: `Context limit reset to ${formatCompactTokens(tab.model.contextWindow)}`,
    });
    return;
  }

  tab.contextLimit = value;
  tab.contextLimitOverridden = true;

  if (value > tab.model.contextWindow) {
    pushToast(tab, {
      type: "warning",
      message: `Context limit set to ${formatCompactTokens(value)} (exceeds model capacity of ${formatCompactTokens(tab.model.contextWindow)})`,
    });
  } else {
    pushToast(tab, {
      type: "success",
      message: `Context limit set to ${formatCompactTokens(value)}`,
    });
  }
}

/**
 * Live AgentSession model used by Pi SDK and extensions.
 * They read `model.contextWindow` / `getContextUsage().contextWindow`, not MixCode's
 * tab.contextLimit. Keep the two aligned for the active session only.
 */
export type SessionContextWindowModel = { contextWindow: number };

/**
 * Push tab.contextLimit into the live session model so Pi-native compaction and
 * extensions that resolve the window from ctx.model see the /context-limit value.
 * Session-ephemeral: does not rewrite models.json; model switch replaces the object.
 */
export function syncContextLimitToSessionModel(
  tab: MixCodeTabInfo,
  model: SessionContextWindowModel | undefined | null,
): void {
  if (!model) return;
  // Canonical capacity stays on tab.model.contextWindow (MixCodeModelRef).
  model.contextWindow = tab.contextLimitOverridden ? tab.contextLimit : tab.model.contextWindow;
}

/**
 * Full /context-limit apply: UI tab + live model window + SDK compaction budgets.
 */
export function applyContextLimitToSession(
  tab: MixCodeTabInfo,
  value: number | "reset",
  session: {
    model?: SessionContextWindowModel | null;
    settingsManager: CompactionOverrideTarget;
  },
): void {
  applyContextLimit(tab, value);
  syncContextLimitToSessionModel(tab, session.model);
  adjustCompactionSettingsForLimit(
    session.settingsManager,
    tab.contextLimit,
    tab.contextLimitOverridden ?? false,
  );
}

type CompactionBudget = { reserveTokens?: number; keepRecentTokens?: number };

interface CompactionOverrideTarget {
  applyOverrides: (overrides: { compaction?: CompactionBudget }) => void;
}

interface CompactionBaselineSource {
  getCompactionSettings: () => { reserveTokens: number; keepRecentTokens: number };
}

// Fallback used only when a manager's real baseline was never captured (e.g.
// bare test mocks). Matches Pi's SDK compaction defaults.
const SDK_COMPACTION_FALLBACK: Required<CompactionBudget> = {
  reserveTokens: 16384,
  keepRecentTokens: 20000,
};

// Per-manager baseline compaction budgets, captured once before any
// /context-limit override mutates the manager. Keyed by manager identity so
// each tab's own SettingsManager restores its own user-configured values on
// reset instead of hardcoded SDK defaults. WeakMap avoids retaining disposed
// managers.
const compactionBaselines = new WeakMap<object, CompactionBudget>();

/**
 * Record a manager's current compaction budgets as its reset baseline.
 * Call once per manager after session defaults are applied but before any
 * /context-limit override, so a later reset restores the user's real values.
 * Re-capturing is a no-op to avoid storing an already-overridden value.
 */
export function captureCompactionBaseline(
  manager: CompactionOverrideTarget & CompactionBaselineSource,
): void {
  if (compactionBaselines.has(manager)) return;
  const { reserveTokens, keepRecentTokens } = manager.getCompactionSettings();
  compactionBaselines.set(manager, { reserveTokens, keepRecentTokens });
}

/**
 * Adjust compaction budgets to match the context limit override.
 * keepRecentTokens controls the cut point; reserveTokens controls when the SDK
 * decides compaction is needed, so both must fit under tiny custom limits.
 */
export function adjustCompactionSettingsForLimit(
  settingsManager: CompactionOverrideTarget,
  contextLimit: number,
  overridden: boolean,
): void {
  if (!overridden) {
    // Reset restores the manager's captured baseline (its user-configured
    // compaction values), falling back to SDK defaults only when no baseline
    // was captured for this manager.
    const baseline = compactionBaselines.get(settingsManager) ?? SDK_COMPACTION_FALLBACK;
    settingsManager.applyOverrides({ compaction: { ...baseline } });
    return;
  }
  const reserveTokens = Math.max(1, Math.min(16384, Math.round(contextLimit * 0.1)));
  const keepRecent = Math.max(1, Math.round(contextLimit * 0.25));
  settingsManager.applyOverrides({ compaction: { reserveTokens, keepRecentTokens: keepRecent } });
}

/**
 * Format a token count in compact form (e.g. "32k", "131k").
 */
function formatCompactTokens(tokens: number): string {
  const value = tokens / 1_000;
  if (Number.isInteger(value)) return `${value.toFixed(0)}k`;
  return `${value.toFixed(1)}k`;
}
