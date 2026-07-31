import type { AgentMessage } from "@earendil-works/pi-agent-core";
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
  const { promise, resolve: release } = Promise.withResolvers<void>();
  tab.promptDispatchGate = promise;
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
  const queued = drainPendingMessages(runtimeTab.tab.pendingMessages, count);
  runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - queued.items.length);
  // Remove before awaiting idle so the aborting run cannot consume these messages.
  // Keep dequeue inside try: if internals throw, re-queue UI pending instead of dropping text.
  let removedSteering: RemovedQueuedMessage[] = [];
  try {
    removedSteering = removeQueuedMessages(runtimeTab, "steering", queued.items);
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
    restoreSteeringMessages(runtimeTab, removedSteering);
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
  //
  // After abort, an extension may schedule compact then start a follow-up turn.
  // Yield past that macrotask, wait out compact, and if a new run already owns
  // the session, leave steering queued for the next agent_end.
  void agentSession
    .waitForIdle()
    .then(() => waitOutPostAbortCompactAndResume(agentSession))
    .then(() => {
      const runtimeTab = getRuntimeTab(sessionId);
      if (!runtimeTab || runtimeTab.queuedPromptCount === 0) return;
      // Resume already owns the session; its agent_end will reschedule flush.
      if (agentSession.isStreaming) return;
      return flushPendingMessage(sessionId, runtimeTab.queuedPromptCount);
    })
    .catch((error: unknown) => onError(sessionId, error));
}

function nextMacrotask(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Pi compact() sets isCompacting only after await abort(); a follow-up turn may
// start on compact onComplete. Fixed 1–2 macrotasks lose that race — poll a short window.
const POST_ABORT_CLAIM_TICKS = 8;

async function waitForCompactionIdle(agentSession: AgentSession): Promise<void> {
  if (!agentSession.isCompacting) return;
  await new Promise<void>((resolve) => {
    const unsubscribe = agentSession.subscribe((event) => {
      if (event.type !== "compaction_end") return;
      unsubscribe();
      resolve();
    });
    if (!agentSession.isCompacting) {
      unsubscribe();
      resolve();
    }
  });
}

async function waitForSessionClaim(claimed: () => boolean): Promise<void> {
  if (claimed()) return;
  for (let i = 0; i < POST_ABORT_CLAIM_TICKS; i += 1) {
    await nextMacrotask();
    if (claimed()) return;
  }
}

/** Let post-abort compact/resume claim the session before draining steering. */
async function waitOutPostAbortCompactAndResume(agentSession: AgentSession): Promise<void> {
  await waitForSessionClaim(
    () => agentSession.isCompacting || agentSession.isStreaming,
  );
  if (agentSession.isCompacting) {
    await waitForCompactionIdle(agentSession);
    // Resume is queued after compact onComplete; wait for it to own the session.
    await waitForSessionClaim(() => agentSession.isStreaming);
  }
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
      runtimeTab.queuedFollowUpCount = Math.max(0, runtimeTab.queuedFollowUpCount - 1);
      removeQueuedMessages(runtimeTab, "followUp", [message]);
    }
    return message;
  }

  const wasRuntimeQueued = runtimeTab.queuedPromptCount > 0;
  const message = runtimeTab.tab.pendingMessages.pop();
  if (message !== undefined && wasRuntimeQueued) {
    runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - 1);
    removeQueuedMessages(runtimeTab, "steering", [message]);
  }
  return message;
}

type QueueKind = "steering" | "followUp";

type QueueInternals = {
  _steeringMessages?: string[];
  _followUpMessages?: string[];
  _emitQueueUpdate?: () => void;
  agent?: {
    steeringQueue?: { messages?: AgentMessage[] };
    followUpQueue?: { messages?: AgentMessage[] };
  };
};

type RemovedQueuedMessage = { message: AgentMessage; text: string };

/**
 * Pi 0.82.1 has no public targeted dequeue API. Mutate both of its queue layers
 * synchronously so unrelated full messages (custom payloads and images) survive.
 */
function removeQueuedMessages(
  runtimeTab: RuntimeTab,
  kind: QueueKind,
  messages: readonly string[],
): RemovedQueuedMessage[] {
  if (messages.length === 0) return [];
  const session = runtimeTab.agentSession as unknown as QueueInternals;
  const tracked = kind === "steering" ? session._steeringMessages : session._followUpMessages;
  const pendingQueue = kind === "steering" ? session.agent?.steeringQueue : session.agent?.followUpQueue;
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
    // Agent may already have drained this message (drain → turn_start → message_start).
    // Text tracker still holds it until message_start; treat as delivered, not a hard error.
    if (pendingIndex === -1) continue;
    removed.push({ index: pendingIndex, message: nextPending.splice(pendingIndex, 1)[0]!, text });
  }

  tracked.splice(0, tracked.length, ...nextTracked);
  pending.splice(0, pending.length, ...nextPending);
  session._emitQueueUpdate();
  return removed.sort((left, right) => left.index - right.index);
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

function restoreSteeringMessages(
  runtimeTab: RuntimeTab,
  removed: readonly RemovedQueuedMessage[],
): void {
  if (removed.length === 0) return;
  const session = runtimeTab.agentSession as unknown as QueueInternals;
  const tracked = session._steeringMessages;
  const pending = session.agent?.steeringQueue?.messages;
  if (!Array.isArray(tracked) || !Array.isArray(pending) || !session._emitQueueUpdate) {
    throw new Error("Pi steering queue internals changed; cannot restore dequeued messages safely.");
  }
  tracked.push(...removed.map((item) => item.text));
  pending.push(...removed.map((item) => item.message));
  session._emitQueueUpdate();
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
