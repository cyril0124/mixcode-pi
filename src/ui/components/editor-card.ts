import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MixCodeTheme } from "../themes.js";

/**
 * Paint an edge at a width of at least eight columns, accepting ANSI-styled labels.
 * Top labels share the right edge; optional mode labels anchor the left edge.
 * Narrow tops drop mode labels and context before truncating identity.
 * Narrow bottoms preserve the primary action.
 */
export function renderEditorCardEdge(
  width: number,
  edge: "top" | "bottom",
  left: string,
  right: string,
  theme: MixCodeTheme,
  frame: MixCodeTheme["borderMuted"],
  modeLabel = "",
): string {
  const start = edge === "top" ? "╭" : "╰";
  const end = edge === "top" ? "╮" : "╯";
  const available = Math.max(0, width - 6);
  if (visibleWidth(left) === 0) left = "";
  if (visibleWidth(right) === 0) right = "";
  if (edge === "top") {
    let modes = visibleWidth(modeLabel) > 0 ? ` ${modeLabel} ` : "";
    if (visibleWidth(modes) + Math.min(visibleWidth(left), 16) + 1 > available) modes = "";
    const titleBudget = available - visibleWidth(modes);
    if (visibleWidth(left) + visibleWidth(right) + 3 > titleBudget) right = "";
    const context = right ? `${theme.dim(" · ")}${right}` : "";
    const title = truncateToWidth(left, Math.max(0, titleBudget - visibleWidth(context)));
    const label = ` ${title}${context} `;
    const fill = width - 4 - visibleWidth(modes) - visibleWidth(label);
    return `${frame("╭─")}${modes}${frame("─".repeat(fill))}${label}${frame("─╮")}`;
  }
  if (visibleWidth(left) + visibleWidth(right) + 3 > available) {
    left = "";
    right = truncateToWidth(right, available);
  }
  const minLeftWidth = Math.min(visibleWidth(left), 16);
  if (left && visibleWidth(right) + minLeftWidth + 3 > available) right = "";
  const leftBudget = available - (right ? visibleWidth(right) + 3 : 0);
  const leftLabel = left ? ` ${truncateToWidth(left, Math.max(0, leftBudget))} ` : "";
  const rightLabel = right ? ` ${right} ` : "";
  const fill = Math.max(0, width - 4 - visibleWidth(leftLabel) - visibleWidth(rightLabel));
  return `${frame(`${start}─`)}${leftLabel}${frame("─".repeat(fill))}${rightLabel}${frame(`─${end}`)}`;
}
