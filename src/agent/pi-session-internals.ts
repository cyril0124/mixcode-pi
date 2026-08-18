import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SearchToolAvailability } from "../core/system-prompt.js";
import { buildMixCodeSystemPromptFromParts } from "../core/system-prompt.js";
import type { RuntimeTab } from "./runtime-types.js";

// Single adapter over the MixCode patch exports on AgentSession
// (patches/@earendil-works+pi-coding-agent+*.patch): targeted queue dequeue /
// restore and the system prompt assembler hook. If the patch is missing, these
// calls throw at runtime (fail loud) instead of silently degrading.

export type QueueKind = "steering" | "followUp";
export type RemovedQueuedMessage = { message: AgentMessage; text: string };

/** Remove queued messages by exact text; returns removed entries for restore. */
export function removeQueuedMessages(
  runtimeTab: RuntimeTab,
  kind: QueueKind,
  messages: readonly string[],
): RemovedQueuedMessage[] {
  if (messages.length === 0) return [];
  return runtimeTab.agentSession.removeQueuedMessages(kind, messages);
}

export function restoreSteeringMessages(
  runtimeTab: RuntimeTab,
  removed: readonly RemovedQueuedMessage[],
): void {
  if (removed.length === 0) return;
  runtimeTab.agentSession.restoreQueuedMessages("steering", removed);
}

/**
 * Own system prompt assembly: Pi collects tool snippets/guidelines/skills into
 * BuildSystemPromptOptions, MixCode assembles the final prompt (identity, docs,
 * search tool availability) and publishes the amended options to extensions.
 */
export function applyMixCodeSystemPrompt(
  agentSession: AgentSession,
  searchTools: SearchToolAvailability,
): void {
  agentSession.setSystemPromptAssembler((collected) => {
    const options = { ...collected, searchTools };
    return { prompt: buildMixCodeSystemPromptFromParts(options), options };
  });
}
