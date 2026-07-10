import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { drainPendingMessages } from "./runtime-chat.js";
import { syncQueueState } from "./runtime-events.js";
import type { RuntimeTab } from "./runtime-types.js";

export async function flushRuntimePendingMessage(
  runtimeTab: RuntimeTab,
  count?: number,
): Promise<void> {
  // Detach queued messages from the steering queue BEFORE awaiting idle. On the
  // Esc path (abort + flush), the run is still parked on a tool call; awaiting
  // first lets the aborting loop drain these into the dying turn (queue_update([])
  // zeroes pendingMessages), so the flush finds nothing and the agent just stops.
  syncPendingMessagesFromSteering(runtimeTab);
  const steeringBeforeFlush = [...getMutableSteeringMessages(runtimeTab.agentSession)];
  const queued = drainPendingMessages(runtimeTab.tab.pendingMessages, count);
  runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - queued.items.length);
  // Remove only MixCode-managed steering messages; Pi follow-up messages must survive.
  removeSteeringMessages(runtimeTab.agentSession, queued.items);
  try {
    if (runtimeTab.agentSession.isStreaming) {
      await runtimeTab.agentSession.waitForIdle();
    }
    const text = queued.items.filter((item) => item.trim()).join("\n\n");
    if (!text) return;
    await runtimeTab.agentSession.prompt(text);
  } catch (error) {
    runtimeTab.tab.pendingMessages.splice(queued.start, 0, ...queued.items);
    runtimeTab.queuedPromptCount += queued.items.length;
    rebuildSteeringQueue(runtimeTab.agentSession, steeringBeforeFlush);
    throw error;
  }
}

export function scheduleRuntimePendingMessageFlush(
  sessionId: string,
  agentSession: AgentSession,
  getRuntimeTab: (sessionId: string) => RuntimeTab | undefined,
  flushPendingMessage: (sessionId: string, count?: number) => Promise<void>,
): void {
  // Pi emits agent_end before the full session settles, so wait before draining queued input.
  void agentSession.waitForIdle().then(() => {
    const runtimeTab = getRuntimeTab(sessionId);
    if (!runtimeTab || runtimeTab.queuedPromptCount === 0) return;
    return flushPendingMessage(sessionId, runtimeTab.queuedPromptCount);
  });
}

export function consumeDeferredPendingMessageFlush(runtimeTab: RuntimeTab): boolean {
  if (!runtimeTab.deferPendingMessageFlush) return false;
  runtimeTab.deferPendingMessageFlush = false;
  return true;
}

export function popRuntimePendingMessage(runtimeTab: RuntimeTab): string | undefined {
  const wasRuntimeQueued = runtimeTab.queuedPromptCount > 0;
  const message = runtimeTab.tab.pendingMessages.pop();
  if (message !== undefined && wasRuntimeQueued) {
    removeSteeringMessages(runtimeTab.agentSession, [message]);
    runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - 1);
  }
  return message;
}

type SteeringQueueInternals = {
  _steeringMessages?: string[];
};

function getMutableSteeringMessages(agentSession: AgentSession): string[] {
  const state = agentSession as unknown as SteeringQueueInternals;
  if (!Array.isArray(state._steeringMessages)) {
    throw new Error(
      "Pi AgentSession steering queue internals changed; MixCode queue flush cannot safely remove sent messages.",
    );
  }
  return state._steeringMessages;
}

function removeSteeringMessages(agentSession: AgentSession, messages: readonly string[]): void {
  if (messages.length === 0) return;
  const remaining = [...getMutableSteeringMessages(agentSession)];
  for (const message of messages) {
    const index = remaining.indexOf(message);
    if (index !== -1) remaining.splice(index, 1);
  }
  rebuildSteeringQueue(agentSession, remaining);
}

function rebuildSteeringQueue(agentSession: AgentSession, steering: readonly string[]): void {
  const messages = getMutableSteeringMessages(agentSession);
  messages.splice(0, messages.length, ...steering);
  agentSession.agent.clearSteeringQueue();
  for (const text of steering) {
    agentSession.agent.steer({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }
}

function syncPendingMessagesFromSteering(runtimeTab: RuntimeTab): void {
  const steering = runtimeTab.agentSession.getSteeringMessages();
  if (steering.length <= runtimeTab.queuedPromptCount) return;
  syncQueueState(runtimeTab, steering);
}
