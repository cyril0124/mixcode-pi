import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { QueueKind } from "../core/types.js";
import {
  type RemovedQueuedMessage,
  removeQueuedMessages,
  restoreSteeringMessages,
} from "./pi-session-internals.js";
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
  await waitForSessionClaim(() => agentSession.isCompacting || agentSession.isStreaming);
  if (agentSession.isCompacting) {
    await waitForCompactionIdle(agentSession);
    // Resume is queued after compact onComplete; wait for it to own the session.
    await waitForSessionClaim(() => agentSession.isStreaming);
  }
}

/** Pop one queued message of the requested kind for editor revision. */
export function popRuntimePendingMessage(
  runtimeTab: RuntimeTab,
  kind: QueueKind,
): string | undefined {
  const messages =
    kind === "followUp" ? runtimeTab.tab.pendingFollowUps : runtimeTab.tab.pendingMessages;
  const wasRuntimeQueued =
    kind === "followUp" ? runtimeTab.queuedFollowUpCount > 0 : runtimeTab.queuedPromptCount > 0;
  const message = messages.pop();
  if (message === undefined || !wasRuntimeQueued) return message;

  if (kind === "followUp") {
    runtimeTab.queuedFollowUpCount = Math.max(0, runtimeTab.queuedFollowUpCount - 1);
  } else {
    runtimeTab.queuedPromptCount = Math.max(0, runtimeTab.queuedPromptCount - 1);
  }
  removeQueuedMessages(runtimeTab, kind, [message]);
  return message;
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
