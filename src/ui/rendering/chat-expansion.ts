// Per-block expansion state for the chat's pointer targets, layered on the
// global `toolsExpanded` toggle.
import type { ChatLine } from "../../agent/runtime.js";
import type { ChatSummaryMessage } from "../../agent/runtime-types.js";
import type { ChatExpandTarget, MixCodeTabInfo } from "../../core/types.js";

/**
 * Key of a summary card's own expansion state. The session entry id is unique
 * and survives a chat rebuild; the `role:timestamp` fallback covers lines that
 * are built without an entry attached.
 */
function summaryCardId(line: ChatLine, message: ChatSummaryMessage): string {
  return line.entryId ?? `${message.role}:${message.timestamp}`;
}

/**
 * The block a pointer click toggles on its own: an agent tool call or a
 * summary card. A `!` command the user typed renders through its own path and
 * answers no pointer.
 */
export function chatExpandTarget(line: ChatLine): ChatExpandTarget | undefined {
  if (line.role === "tool" && line.variant !== "user-bash" && line.toolCallId) {
    return { kind: "tool", id: line.toolCallId };
  }
  const summary = line.summaryMessage;
  return summary ? { kind: "summary", id: summaryCardId(line, summary) } : undefined;
}

/** A block is expanded when the global toggle is on or the block itself was clicked. */
function chatExpandTargetExpanded(
  tab: MixCodeTabInfo | undefined,
  target: ChatExpandTarget,
): boolean {
  if (tab?.extensionUi.toolsExpanded === true) return true;
  const own = target.kind === "tool" ? tab?.expandedToolCalls : tab?.expandedSummaryCards;
  return own?.has(target.id) === true;
}

/** Toggles one block's own expansion, leaving the global toggle alone. */
export function toggleChatExpansion(tab: MixCodeTabInfo, target: ChatExpandTarget): void {
  const own =
    (target.kind === "tool" ? tab.expandedToolCalls : tab.expandedSummaryCards) ??
    new Set<string>();
  const next = new Set(own);
  if (next.has(target.id)) next.delete(target.id);
  else next.add(target.id);
  if (target.kind === "tool") tab.expandedToolCalls = next;
  else tab.expandedSummaryCards = next;
}

export function toolCallIdExpanded(
  tab: MixCodeTabInfo | undefined,
  toolCallId: string | undefined,
): boolean {
  if (!toolCallId) return tab?.extensionUi.toolsExpanded === true;
  return chatExpandTargetExpanded(tab, { kind: "tool", id: toolCallId });
}

export function toolCallExpanded(tab: MixCodeTabInfo | undefined, line: ChatLine): boolean {
  return toolCallIdExpanded(tab, line.toolCallId);
}

export function summaryCardExpanded(tab: MixCodeTabInfo | undefined, line: ChatLine): boolean {
  const target = chatExpandTarget(line);
  return target !== undefined && chatExpandTargetExpanded(tab, target);
}
