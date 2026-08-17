import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  AgentSession,
  AgentSessionServices,
  BuildSystemPromptOptions,
} from "@earendil-works/pi-coding-agent";
import type { SearchToolAvailability } from "../core/system-prompt.js";
import { buildMixCodeSystemPromptFromParts } from "../core/system-prompt.js";
import type { RuntimeTab } from "./runtime-types.js";

export type QueueKind = "steering" | "followUp";
export type RemovedQueuedMessage = { message: AgentMessage; text: string };

type QueueInternals = {
  _steeringMessages?: string[];
  _followUpMessages?: string[];
  _emitQueueUpdate?: () => void;
  agent?: {
    steeringQueue?: { messages?: AgentMessage[] };
    followUpQueue?: { messages?: AgentMessage[] };
  };
};

type SystemPromptInternals = {
  _rebuildSystemPrompt?: (toolNames: string[]) => string;
  _baseSystemPrompt?: string;
  _baseSystemPromptOptions?: BuildSystemPromptOptions;
  _systemPromptOverride?: string;
};

const originalRebuildBySession = new WeakMap<AgentSession, (toolNames: string[]) => string>();

/**
 * Pi 0.84.1 has no public targeted dequeue API. Keep both internal queue layers
 * synchronized without awaiting between the capability check and mutation.
 */
export function removeQueuedMessages(
  runtimeTab: RuntimeTab,
  kind: QueueKind,
  messages: readonly string[],
): RemovedQueuedMessage[] {
  if (messages.length === 0) return [];
  const session = runtimeTab.agentSession as unknown as QueueInternals;
  const tracked = kind === "steering" ? session._steeringMessages : session._followUpMessages;
  const pendingQueue =
    kind === "steering" ? session.agent?.steeringQueue : session.agent?.followUpQueue;
  const pending = pendingQueue?.messages;
  if (!Array.isArray(tracked) || !Array.isArray(pending) || !session._emitQueueUpdate) {
    throw new Error(`Pi ${kind} queue internals changed; cannot dequeue safely.`);
  }

  const nextTracked = [...tracked];
  const nextPending = [...pending];
  const removed: Array<RemovedQueuedMessage & { index: number }> = [];
  for (let requestedIndex = messages.length - 1; requestedIndex >= 0; requestedIndex -= 1) {
    const text = messages[requestedIndex]!;
    const trackedIndex = nextTracked.lastIndexOf(text);
    if (trackedIndex === -1) continue;
    nextTracked.splice(trackedIndex, 1);
    const pendingIndex = findQueuedUserMessageFromEnd(nextPending, text);
    if (pendingIndex === -1) continue;
    removed.push({ index: pendingIndex, message: nextPending.splice(pendingIndex, 1)[0]!, text });
  }

  tracked.splice(0, tracked.length, ...nextTracked);
  pending.splice(0, pending.length, ...nextPending);
  session._emitQueueUpdate();
  return removed.sort((left, right) => left.index - right.index);
}

export function restoreSteeringMessages(
  runtimeTab: RuntimeTab,
  removed: readonly RemovedQueuedMessage[],
): void {
  if (removed.length === 0) return;
  const session = runtimeTab.agentSession as unknown as QueueInternals;
  const tracked = session._steeringMessages;
  const pending = session.agent?.steeringQueue?.messages;
  if (!Array.isArray(tracked) || !Array.isArray(pending) || !session._emitQueueUpdate) {
    throw new Error(
      "Pi steering queue internals changed; cannot restore dequeued messages safely.",
    );
  }
  tracked.push(...removed.map((item) => item.text));
  pending.push(...removed.map((item) => item.message));
  session._emitQueueUpdate();
}

function findQueuedUserMessageFromEnd(messages: readonly AgentMessage[], text: string): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role === "user" && queuedUserText(message) === text) return index;
  }
  return -1;
}

function queuedUserText(message: Extract<AgentMessage, { role: "user" }>): string {
  if (typeof message.content === "string") return message.content;
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

/**
 * Pi has no public system-prompt-builder hook. Keep this capability-checked private
 * coupling in one adapter until the SDK exposes an equivalent entry point.
 */
export function applyMixCodeSystemPrompt(
  services: AgentSessionServices,
  cwd: string,
  agentSession: AgentSession,
  searchTools: SearchToolAvailability,
): void {
  const internals = agentSession as unknown as SystemPromptInternals;
  if (typeof internals._rebuildSystemPrompt !== "function") {
    throw new Error(
      "Pi AgentSession._rebuildSystemPrompt internals changed; MixCode cannot own system prompt assembly.",
    );
  }

  // Reuse Pi's collector (_toolPromptSnippets / _toolPromptGuidelines) instead of
  // re-reading getToolDefinition. Then assemble with MixCode identity/docs/search.
  let originalRebuild = originalRebuildBySession.get(agentSession);
  if (!originalRebuild) {
    originalRebuild = internals._rebuildSystemPrompt.bind(agentSession);
    originalRebuildBySession.set(agentSession, originalRebuild);
  }

  internals._rebuildSystemPrompt = (toolNames: string[]) => {
    originalRebuild(toolNames);
    const collected = internals._baseSystemPromptOptions;
    if (!collected) {
      throw new Error(
        "Pi AgentSession._rebuildSystemPrompt did not publish _baseSystemPromptOptions; MixCode cannot assemble tools/guidelines.",
      );
    }
    const options = { ...collected, searchTools };
    const prompt = buildMixCodeSystemPromptFromParts(options);
    internals._baseSystemPromptOptions = options;
    return prompt;
  };

  const prompt = internals._rebuildSystemPrompt(agentSession.getActiveToolNames());
  internals._baseSystemPrompt = prompt;
  agentSession.agent.state.systemPrompt = internals._systemPromptOverride ?? prompt;
}
