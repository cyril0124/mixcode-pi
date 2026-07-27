import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { drainPendingMessages } from "./runtime-chat.js";
import { syncQueueState } from "./runtime-events.js";
import type { RuntimeTab } from "./runtime-types.js";

/**
 * Serialize prompt dispatch decisions at idle→active transitions.
 * Acquires per-tab gate, executes send(), releases gate when preflightResult fires.
 * Prevents concurrent agentSession.prompt() calls from racing through isStreaming checks.
 */
export async function dispatchTurn(
  tab: RuntimeTab,
  send: (signalRegistered: () => void) => Promise<void>,
): Promise<void> {
  const prev = tab.promptDispatchGate ?? Promise.resolve();
  let release!: () => void;
  tab.promptDispatchGate = new Promise<void>((r) => (release = r));
  await prev.catch(() => {}); // Wait for previous dispatch to register
  try {
    let done = false;
    const signalRegistered = () => {
      if (!done) {
        done = true;
        release();
      }
    };
    try {
      await send(signalRegistered);
    } finally {
      signalRegistered(); // Ensure release on steer/early-exit paths
    }
  } catch (error) {
    release(); // Release on exception
    throw error;
  }
}

/**
 * Flush only the steer queue (Esc → send now). Follow-up messages must survive:
 * Esc must not promote a "wait until idle" message into an immediate prompt.
 */
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
    await dispatchTurn(runtimeTab, async (signalRegistered) => {
      await runtimeTab.agentSession.prompt(text, { preflightResult: signalRegistered });
    });
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
  onError: (sessionId: string, error: unknown) => void,
): void {
  // Pi emits agent_end before the full session settles, so wait before draining
  // queued input. The whole chain is fire-and-forget from a session event
  // callback, so a rejected flush (e.g. the next run fails to start) would
  // otherwise become an unhandled rejection and crash the TUI process. Catch it
  // and surface it through onError; flushRuntimePendingMessage already re-queues
  // the failed messages, so the user's text is preserved.
  void agentSession
    .waitForIdle()
    .then(() => {
      const runtimeTab = getRuntimeTab(sessionId);
      if (!runtimeTab || runtimeTab.queuedPromptCount === 0) return;
      return flushPendingMessage(sessionId, runtimeTab.queuedPromptCount);
    })
    .catch((error: unknown) => onError(sessionId, error));
}

export function consumeDeferredPendingMessageFlush(runtimeTab: RuntimeTab): boolean {
  if (!runtimeTab.deferPendingMessageFlush) return false;
  runtimeTab.deferPendingMessageFlush = false;
  return true;
}

/**
 * Pop one queued message for Ctrl+U edit. Prefer follow-up (user is more often
 * revising "do this after") then fall back to steer.
 */
export function popRuntimePendingMessage(runtimeTab: RuntimeTab): string | undefined {
  if (runtimeTab.tab.pendingFollowUps.length > 0) {
    const wasRuntimeQueued = runtimeTab.queuedFollowUpCount > 0;
    const message = runtimeTab.tab.pendingFollowUps.pop();
    if (message !== undefined && wasRuntimeQueued) {
      removeFollowUpMessages(runtimeTab.agentSession, [message]);
      runtimeTab.queuedFollowUpCount = Math.max(0, runtimeTab.queuedFollowUpCount - 1);
    }
    return message;
  }

  const wasRuntimeQueued = runtimeTab.queuedPromptCount > 0;
  const message = runtimeTab.tab.pendingMessages.pop();
  if (message !== undefined && wasRuntimeQueued) {
    removeSteeringMessages(runtimeTab.agentSession, [message]);
    runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - 1);
  }
  return message;
}

type QueueInternals = {
  _steeringMessages?: string[];
  _followUpMessages?: string[];
};

function getMutableSteeringMessages(agentSession: AgentSession): string[] {
  const state = agentSession as unknown as QueueInternals;
  if (!Array.isArray(state._steeringMessages)) {
    throw new Error(
      "Pi AgentSession steering queue internals changed; MixCode queue flush cannot safely remove sent messages.",
    );
  }
  return state._steeringMessages;
}

function getMutableFollowUpMessages(agentSession: AgentSession): string[] {
  const state = agentSession as unknown as QueueInternals;
  if (!Array.isArray(state._followUpMessages)) {
    throw new Error(
      "Pi AgentSession follow-up queue internals changed; MixCode queue edit cannot safely remove sent messages.",
    );
  }
  return state._followUpMessages;
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

function removeFollowUpMessages(agentSession: AgentSession, messages: readonly string[]): void {
  if (messages.length === 0) return;
  const remaining = [...getMutableFollowUpMessages(agentSession)];
  for (const message of messages) {
    const index = remaining.indexOf(message);
    if (index !== -1) remaining.splice(index, 1);
  }
  rebuildFollowUpQueue(agentSession, remaining);
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

function rebuildFollowUpQueue(agentSession: AgentSession, followUp: readonly string[]): void {
  const messages = getMutableFollowUpMessages(agentSession);
  messages.splice(0, messages.length, ...followUp);
  agentSession.agent.clearFollowUpQueue();
  for (const text of followUp) {
    agentSession.agent.followUp({
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    });
  }
}

function syncPendingMessagesFromSteering(runtimeTab: RuntimeTab): void {
  const steering = runtimeTab.agentSession.getSteeringMessages();
  const followUp = runtimeTab.agentSession.getFollowUpMessages();
  if (
    steering.length <= runtimeTab.queuedPromptCount &&
    followUp.length <= runtimeTab.queuedFollowUpCount
  ) {
    return;
  }
  syncQueueState(runtimeTab, steering, followUp);
}
