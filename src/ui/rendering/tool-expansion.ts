// Per-tool-call expansion state, layered on the global `toolsExpanded` toggle.
import type { ChatLine } from "../../agent/runtime.js";
import type { MixCodeTabInfo } from "../../core/types.js";

/** A tool block is expanded when the global toggle is on or its own call was clicked. */
export function toolCallIdExpanded(
  tab: MixCodeTabInfo | undefined,
  toolCallId: string | undefined,
): boolean {
  if (tab?.extensionUi.toolsExpanded === true) return true;
  if (!toolCallId) return false;
  return tab?.expandedToolCalls?.has(toolCallId) === true;
}

export function toolCallExpanded(tab: MixCodeTabInfo | undefined, line: ChatLine): boolean {
  return toolCallIdExpanded(tab, line.toolCallId);
}

/** Toggles one tool call's own expansion, leaving the global toggle alone. */
export function toggleToolCallExpansion(tab: MixCodeTabInfo, toolCallId: string): void {
  const current = tab.expandedToolCalls ?? new Set<string>();
  const next = new Set(current);
  if (next.has(toolCallId)) next.delete(toolCallId);
  else next.add(toolCallId);
  tab.expandedToolCalls = next;
}
