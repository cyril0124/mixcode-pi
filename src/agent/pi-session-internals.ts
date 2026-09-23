import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { SearchToolAvailability, SystemPromptSection } from "../core/system-prompt.js";
import { buildMixCodeSystemPromptSections, sectionRowsFromRecord } from "../core/system-prompt.js";
import type { QueueKind } from "../core/types.js";
import type { RuntimeTab } from "./runtime-types.js";

// Single adapter over the MixCode patch exports on AgentSession
// (patches/@earendil-works%2Fpi-coding-agent@*.patch): targeted queue dequeue /
// restore and the system prompt assembler hook. If the patch is missing, these
// calls throw at runtime (fail loud) instead of silently degrading.

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

/** Leading system prompt the provider receives, with its display rows. */
export interface EffectiveSystemPrompt {
  /** Exact text after every recorded section patch is replayed. */
  text: string;
  /** Rows whose texts concatenate to `text`, for the `/system-prompt` footer. */
  sections: SystemPromptSection[];
}

/**
 * Leading system prompt of a session with all recorded section patches replayed.
 *
 * Read the replay instead of `agentSession.systemPrompt`. Once a run settles, Pi
 * renders that getter from the base build options, and `before_agent_start`
 * extensions write their sections to a per-run copy, so extension sections are
 * missing from it. The transcript keeps them, and it carries what the provider
 * receives.
 *
 * Returns undefined before the first system message is recorded.
 */
export function getEffectiveSystemPrompt(
  agentSession: AgentSession,
): EffectiveSystemPrompt | undefined {
  const message = getCurrentSystemMessage(agentSession.messages);
  if (!message) return undefined;
  const recorded: Record<string, string> = {};
  for (const [name, value] of Object.entries(message.sections ?? {})) {
    if (typeof value === "string") recorded[name] = value;
  }
  // getSystemMessageText renders the content first, then the sections.
  const content = contentText(message.content);
  const rows = sectionRowsFromRecord(recorded);
  return {
    text: getSystemMessageText(message),
    sections:
      content.length === 0
        ? rows
        : [
            { name: "content", text: content },
            ...rows.map((row, index) => (index === 0 ? { ...row, text: `\n\n${row.text}` } : row)),
          ],
  };
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
    const { transcriptSections } = buildMixCodeSystemPromptSections(options);
    return { sections: transcriptSections, options };
  });
}
