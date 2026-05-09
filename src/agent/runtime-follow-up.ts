import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  agentMessageText,
  drainPendingMessages,
  getMutableAgentFollowUpQueue,
  getMutableFollowUpMessages,
} from "./runtime-chat.js";
import { syncQueueState } from "./runtime-events.js";
import type { RuntimeTab } from "./runtime-types.js";

export async function flushRuntimePendingMessage(
  runtimeTab: RuntimeTab,
  count?: number,
): Promise<void> {
  if (runtimeTab.agentSession.isStreaming) {
    await runtimeTab.agentSession.agent.waitForIdle();
  }
  syncPendingMessagesFromFollowUp(runtimeTab);
  const queued = drainPendingMessages(runtimeTab.tab.pendingMessages, count);
  runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - queued.items.length);
  try {
    removeFlushedFollowUpMessages(runtimeTab.agentSession, queued.items);
    const text = queued.items.filter((item) => item.trim()).join("\n\n");
    if (!text) return;
    await runtimeTab.agentSession.prompt(text);
  } catch (error) {
    runtimeTab.tab.pendingMessages.splice(queued.start, 0, ...queued.items);
    runtimeTab.queuedPromptCount += queued.items.length;
    throw error;
  }
}

export function scheduleRuntimePendingMessageFlush(
  sessionId: string,
  agentSession: AgentSession,
  getRuntimeTab: (sessionId: string) => RuntimeTab | undefined,
  flushPendingMessage: (sessionId: string, count?: number) => Promise<void>,
): void {
  // Pi emits agent_end before clearing isStreaming, so wait for idle before draining queued input.
  void agentSession.agent.waitForIdle().then(() => {
    const runtimeTab = getRuntimeTab(sessionId);
    if (!runtimeTab || runtimeTab.queuedPromptCount === 0) return;
    return flushPendingMessage(sessionId, runtimeTab.queuedPromptCount);
  });
}

export function popRuntimePendingMessage(runtimeTab: RuntimeTab): string | undefined {
  const wasRuntimeQueued = runtimeTab.queuedPromptCount > 0;
  const message = runtimeTab.tab.pendingMessages.pop();
  if (message !== undefined && wasRuntimeQueued) {
    removeSingleFollowUpMessage(runtimeTab.agentSession, message);
    runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - 1);
    clearFollowUpQueueIfEmpty(runtimeTab.agentSession);
  }
  return message;
}

function syncPendingMessagesFromFollowUp(runtimeTab: RuntimeTab): void {
  const followUp = getMutableFollowUpMessages(runtimeTab.agentSession);
  if (followUp.length <= runtimeTab.queuedPromptCount) return;
  syncQueueState(runtimeTab, followUp);
}

function removeFlushedFollowUpMessages(
  agentSession: AgentSession,
  messages: readonly string[],
): void {
  for (const message of messages) {
    removeSingleFollowUpMessage(agentSession, message);
  }
  if (messages.length > 0) {
    clearFollowUpQueueIfEmpty(agentSession);
  }
}

function removeSingleFollowUpMessage(agentSession: AgentSession, message: string): void {
  const list = getMutableFollowUpMessages(agentSession);
  const index = list.indexOf(message);
  if (index !== -1) list.splice(index, 1);
  const queue = getMutableAgentFollowUpQueue(agentSession.agent);
  const queueIndex = queue.findIndex((queued) => agentMessageText(queued) === message);
  if (queueIndex !== -1) queue.splice(queueIndex, 1);
}

function clearFollowUpQueueIfEmpty(agentSession: AgentSession): void {
  if (agentSession.getFollowUpMessages().length > 0) return;
  agentSession.agent.clearFollowUpQueue();
}
