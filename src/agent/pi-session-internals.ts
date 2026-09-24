import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { contentText, getCurrentSystemMessage, getSystemMessageText } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  calculateContextTokens,
  type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import type { ContextUsageInput } from "../core/context-usage.js";
import type { SearchToolAvailability, SystemPromptSection } from "../core/system-prompt.js";
import { buildMixCodeSystemPromptSections, sectionRowsFromRecord } from "../core/system-prompt.js";
import type { QueueKind } from "../core/types.js";
import type { RuntimeTab } from "./runtime-types.js";
import { getActiveToolInfos } from "./tools.js";

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
    assembledPromptSections.set(agentSession, sectionRowsFromRecord(transcriptSections));
    return { sections: transcriptSections, options };
  });
}

/**
 * Sections of the last prompt this session assembled, keyed by session.
 *
 * `/context` normally reads the recorded system message, which carries whatever
 * the provider actually received. Before the first request nothing is recorded,
 * and that message is the only other place the section split exists: without this
 * cache a pre-first-request panel cannot attribute the prompt at all (no System
 * prompt, no Skills), even though those tokens are already being sent.
 */
const assembledPromptSections = new WeakMap<AgentSession, SystemPromptSection[]>();

/**
 * Section split for a session that has not recorded a system message yet.
 *
 * Pi renders `systemPrompt` through MixCode's assembler, so reading it records
 * the split as a side effect; ask for the prompt, then read the cache. Returns
 * empty when the session cannot render one (no model, or a prompt built before
 * MixCode installed the assembler).
 *
 * Extension-contributed prompt sections only exist once a request has collected
 * them (`before_agent_start`), so a pre-first-request split can attribute a few
 * hundred tokens less to the prompt than the recorded one does. The panel reports
 * that state as an estimate.
 */
function warmAssembledPromptSections(agentSession: AgentSession): SystemPromptSection[] {
  const cached = assembledPromptSections.get(agentSession);
  if (cached) return cached;
  try {
    void agentSession.systemPrompt;
  } catch {
    return [];
  }
  return assembledPromptSections.get(agentSession) ?? [];
}

/**
 * Pi's usable-usage predicate for context accounting: a real assistant turn whose
 * provider usage is non-zero. Mirrors the internal `getAssistantUsage` that
 * `getLastAssistantUsage` (re-exported from the package root) wraps, because Pi
 * compares the usage entry's *index* internally and exposes only the value.
 * Anchoring on an index is what lets a later `context_edit`/`compaction`
 * invalidate the usage, which a value-only lookup cannot express.
 */
function hasUsableAssistantUsage(entry: SessionEntry): boolean {
  if (entry.type !== "message" || entry.message.role !== "assistant") return false;
  const { stopReason, usage } = entry.message;
  // `usage` is required in the type but absent on some imported/restored messages,
  // and `calculateContextTokens` throws on it; a malformed entry must not drop the
  // earlier valid anchor.
  if (!usage) return false;
  return stopReason !== "aborted" && stopReason !== "error" && calculateContextTokens(usage) > 0;
}

/** Snapshot the `/context` panel draws from, plus the model labels it prints. */
export interface ContextUsageSnapshot {
  input: ContextUsageInput;
  modelName: string;
  modelId: string;
}

/**
 * Collect the context-usage inputs for one tab from Pi's public session API.
 *
 * The window is MixCode's `tab.contextLimit` (not `model.contextWindow`) so the
 * panel and the status bar can never disagree while a `/context-limit` override
 * is active. `usedTokens` stays `null` when the SDK reports an invalidated
 * count, and `anchored` is false whenever no response has reported usage (the
 * SDK still returns an estimate in that state). The estimator itself can also
 * throw on restored history it cannot handle (see `syncContextUsage`), which
 * degrades to the same `null`.
 *
 * Tool payloads mirror what the provider receives: name, description, and the
 * parameter schema, counted for the tools actually active in this session (the
 * registry can hold more than `defaultTools` enables). A schema that cannot be
 * serialized (extension tools may carry functions or cycles) contributes its
 * name and description only.
 */
export function collectContextUsage(runtimeTab: RuntimeTab): ContextUsageSnapshot {
  const { agentSession, tab } = runtimeTab;
  let usedTokens: number | null = null;
  try {
    usedTokens = agentSession.getContextUsage()?.tokens ?? null;
  } catch {
    usedTokens = null;
  }

  // `getContextUsage()` also returns a numeric estimate when the active branch's
  // usage is not usable as an anchor, and a numeric total therefore does not make
  // it provider-anchored. Read the active branch (not session-wide totals, which
  // also count abandoned branches) and apply Pi's own anchor rule
  // (`estimateProjectedContextTokens`): usable usage, with no `context_edit` or
  // `compaction` after it. Auto-retry appends a `context_edit` when it abandons an
  // attempt, which is exactly the case that would otherwise mislabel an estimate.
  let anchored = false;
  try {
    const branch = agentSession.sessionManager.getBranch();
    const usageIndex = branch.findLastIndex(hasUsableAssistantUsage);
    const invalidatedAt = branch.findLastIndex(
      (entry) => entry.type === "context_edit" || entry.type === "compaction",
    );
    anchored = usageIndex >= 0 && usageIndex > invalidatedAt;
  } catch {
    anchored = false;
  }
  const effective = getEffectiveSystemPrompt(agentSession);
  const sections = effective?.sections ?? warmAssembledPromptSections(agentSession);
  const toolTexts = getActiveToolInfos(agentSession).map((tool) => {
    const parts = [tool.name, typeof tool.description === "string" ? tool.description : ""];
    try {
      // `parameters` is a TypeBox schema in practice; keep only real wire bytes.
      parts.push(JSON.stringify(tool.parameters) ?? "");
    } catch {
      parts.push("");
    }
    return parts.join("\n");
  });

  const compaction = agentSession.settingsManager.getCompactionSettings({
    provider: tab.model.provider,
    id: tab.model.modelId,
  });
  return {
    input: {
      contextWindow: tab.contextLimit,
      usedTokens,
      anchored,
      sections,
      toolTexts,
      reserveTokens: compaction.enabled ? compaction.reserveTokens : 0,
    },
    modelName: tab.model.displayName,
    modelId: tab.model.modelId,
  };
}
