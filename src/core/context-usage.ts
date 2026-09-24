import { estimateTextTokens } from "./token-estimate.js";

/** One named contiguous fragment of the system prompt, as the session recorded it. */
export interface ContextUsageSection {
  name: string;
  text: string;
}

export interface ContextUsageInput {
  /** Effective window: MixCode's `tab.contextLimit`, so the panel matches the status bar. */
  contextWindow: number;
  /**
   * Provider-anchored context tokens from the last real response, or `null`
   * while that number is unknown (right after compaction, before the next
   * response). `null` degrades the panel to estimates instead of showing 0.
   */
  usedTokens: number | null;
  /**
   * Whether `usedTokens` traces back to a real response. The SDK also returns a
   * numeric estimate when no response has reported usage, so a non-null total
   * alone does not make it provider-anchored.
   */
  anchored: boolean;
  /** System prompt sections in wire order; their texts concatenate to the prompt. */
  sections: readonly ContextUsageSection[];
  /** Per-tool wire payloads (name + description + parameter schema) actually sent to the model. */
  toolTexts: readonly string[];
  /**
   * Headroom kept below the auto-compaction threshold. Pass 0 when compaction
   * is disabled: this module does not read settings, so callers own that policy.
   */
  reserveTokens: number;
}

export type ContextUsageCategoryId =
  | "systemPrompt"
  | "projectContext"
  | "skills"
  | "toolGuidelines"
  | "toolSchemas"
  | "messages";

export interface ContextUsageCategory {
  id: ContextUsageCategoryId;
  label: string;
  tokens: number;
}

export interface ContextUsageBreakdown {
  contextWindow: number;
  /** Total the categories explain: the anchored provider count when known, else the estimate. */
  usedTokens: number;
  /** False when `usedTokens` is an estimate because the provider count is unknown. */
  anchored: boolean;
  categories: ContextUsageCategory[];
  autoCompactBufferTokens: number;
  freeTokens: number;
}

const CATEGORY_LABELS: Record<ContextUsageCategoryId, string> = {
  systemPrompt: "System prompt",
  projectContext: "Project context",
  skills: "Skills",
  toolGuidelines: "Tool guidelines",
  toolSchemas: "Tool schemas",
  messages: "Messages",
};

/** Non-message category totals before scaling, in legend order. */
type NonMessageTotals = Record<Exclude<ContextUsageCategoryId, "messages">, number>;

/**
 * Which legend category a system-prompt section belongs to.
 *
 * Keys come from MixCode's assembler (`buildMixCodeSystemPromptSections`):
 * preamble/docs/addendum/extensions are host prompt text, `tools` is the
 * available-tools + guidelines section, `skills` is the Pi-formatted skill list,
 * and `project_context`/`environment` are the session's project surroundings.
 * Unknown keys fall back to the host prompt so extension-added sections stay
 * counted rather than disappearing from the legend.
 */
function sectionCategory(name: string): Exclude<ContextUsageCategoryId, "messages"> {
  if (name === "skills") return "skills";
  if (name === "tools") return "toolGuidelines";
  if (name === "environment" || name.startsWith("project_context")) return "projectContext";
  return "systemPrompt";
}

function sumSections(sections: readonly ContextUsageSection[]): NonMessageTotals {
  const totals: NonMessageTotals = {
    systemPrompt: 0,
    projectContext: 0,
    skills: 0,
    toolGuidelines: 0,
    toolSchemas: 0,
  };
  for (const section of sections) {
    totals[sectionCategory(section.name)] += estimateTextTokens(section.text);
  }
  return totals;
}

function totalOf(totals: NonMessageTotals): number {
  return (
    totals.systemPrompt +
    totals.projectContext +
    totals.skills +
    totals.toolGuidelines +
    totals.toolSchemas
  );
}

/**
 * Scale non-message categories to fit `target`, trimming rounding residue from
 * the largest category last.
 *
 * The heuristic estimator can overshoot the provider-anchored total (the
 * provider applies its own prompt formatting), and the legend must never
 * explain more tokens than the header reports.
 */
function fitToTotal(totals: NonMessageTotals, target: number): NonMessageTotals {
  const sum = totalOf(totals);
  if (sum <= target || sum === 0) return totals;
  const scale = Math.max(0, target) / sum;
  const scaled: NonMessageTotals = {
    systemPrompt: Math.floor(totals.systemPrompt * scale),
    projectContext: Math.floor(totals.projectContext * scale),
    skills: Math.floor(totals.skills * scale),
    toolGuidelines: Math.floor(totals.toolGuidelines * scale),
    toolSchemas: Math.floor(totals.toolSchemas * scale),
  };
  let residual = Math.max(0, target) - totalOf(scaled);
  const order: Array<Exclude<ContextUsageCategoryId, "messages">> = [
    "systemPrompt",
    "projectContext",
    "skills",
    "toolGuidelines",
    "toolSchemas",
  ];
  while (residual > 0) {
    const largest = order.reduce((best, id) => (scaled[id] > scaled[best] ? id : best), order[0]!);
    scaled[largest] += 1;
    residual -= 1;
  }
  return scaled;
}

/**
 * Compute the `/context` panel numbers from a session snapshot.
 *
 * Contract: pure arithmetic, no session or settings access. With an anchored
 * provider count, Messages is whatever the non-message categories do not
 * explain, so the legend always sums to the reported total; without one, only
 * the non-message categories are known and `anchored` is false.
 *
 * Budget invariant: `min(usedTokens, contextWindow) + autoCompactBufferTokens +
 * freeTokens === contextWindow` for every input, because buffer and free are
 * clamped at zero when usage is already past the window. `usedTokens` itself may
 * exceed the window (a model switch to a smaller window leaves the anchor above
 * it), and `window` of 0 or `null` (unknown) leaves both at zero.
 */
export function computeContextUsage(input: ContextUsageInput): ContextUsageBreakdown {
  const contextWindow = Number.isFinite(input.contextWindow) ? Math.max(0, input.contextWindow) : 0;
  const estimated = sumSections(input.sections);
  estimated.toolSchemas = input.toolTexts.reduce((sum, text) => sum + estimateTextTokens(text), 0);

  const providedTokens =
    input.usedTokens !== null && Number.isFinite(input.usedTokens) && input.usedTokens > 0
      ? Math.max(0, input.usedTokens)
      : null;
  const usedTokens = providedTokens ?? totalOf(estimated);
  const anchored = input.anchored && providedTokens !== null;
  const fitted = providedTokens !== null ? fitToTotal(estimated, usedTokens) : estimated;

  // Messages is whatever the total does not explain; with no total at all
  // (post-compaction, before the next response) only the non-message
  // categories are known, so no Messages row is invented.
  const messagesTokens = providedTokens !== null ? Math.max(0, usedTokens - totalOf(fitted)) : 0;
  const categories: ContextUsageCategory[] = (
    ["systemPrompt", "projectContext", "skills", "toolGuidelines", "toolSchemas"] as const
  ).map((id) => ({ id, label: CATEGORY_LABELS[id], tokens: fitted[id] }));
  if (providedTokens !== null) {
    categories.push({ id: "messages", label: CATEGORY_LABELS.messages, tokens: messagesTokens });
  }

  const reserveTokens = Number.isFinite(input.reserveTokens) ? Math.max(0, input.reserveTokens) : 0;
  const autoCompactBufferTokens = Math.min(reserveTokens, Math.max(0, contextWindow - usedTokens));
  const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

  return {
    contextWindow,
    usedTokens,
    anchored,
    categories,
    autoCompactBufferTokens,
    freeTokens,
  };
}
