import type { RuntimeTab } from "./runtime-types.js";

type FollowUpEntry = RuntimeTab["tab"]["followUpQueue"][number];

// Execution belongs to the live host, never to serialized tab state. Weak keys
// release command closures when entries are consumed, popped, or discarded.
const commandExecutors = new WeakMap<FollowUpEntry, () => Promise<void>>();

export function attachFollowUpCommand(entry: FollowUpEntry, execute: () => Promise<void>): void {
  commandExecutors.set(entry, execute);
}

export function followUpCommand(entry: FollowUpEntry): (() => Promise<void>) | undefined {
  return commandExecutors.get(entry);
}

/** Refresh the public preview without mixing deferred user tasks into SDK continuations. */
export function syncFollowUpPreview(runtimeTab: RuntimeTab): void {
  const sdkMessages = runtimeTab.agentSession.getFollowUpMessages();
  runtimeTab.tab.pendingFollowUps = [
    ...runtimeTab.tab.followUpQueue.map((entry) => entry.text),
    ...sdkMessages,
  ];
  runtimeTab.queuedFollowUpCount = sdkMessages.length;
}

/** Drop tasks owned by a closed conversation; a resumed drain must not revive them. */
export function discardFollowUps(runtimeTab: RuntimeTab): void {
  runtimeTab.tab.followUpQueue = [];
  runtimeTab.tab.pendingFollowUps = [];
  runtimeTab.tab.followUpsPaused = false;
  runtimeTab.queuedFollowUpCount = 0;
}

/** Pauses deferred user work only. SDK-owned retry/compaction companions remain untouched. */
export function pauseFollowUps(runtimeTab: RuntimeTab): void {
  if (runtimeTab.tab.followUpQueue.length > 0 || runtimeTab.followUpDrain) {
    runtimeTab.tab.followUpsPaused = true;
  }
}

/** Remove a single next task or the leading contiguous batch, preserving submission order. */
export function takeFollowUpBatch(runtimeTab: RuntimeTab): RuntimeTab["tab"]["followUpQueue"] {
  const queue = runtimeTab.tab.followUpQueue;
  const first = queue[0];
  if (!first) return [];
  let count = 1;
  if (first.kind === "batch" && !first.command) {
    while (queue[count]?.kind === "batch" && !queue[count]?.command) count += 1;
  }
  const batch = queue.splice(0, count);
  syncFollowUpPreview(runtimeTab);
  return batch;
}
