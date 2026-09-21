import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Context accompanies a prompt without becoming part of its editable user text. */
export type PromptContextMessage = Parameters<AgentSession["sendCustomMessage"]>[0];

// Host-owned queue entries retain context until they are delivered or discarded.
const entryContexts = new WeakMap<object, readonly PromptContextMessage[]>();
const pendingContexts = new WeakMap<string[], Map<number, readonly PromptContextMessage[]>>();

export function attachPromptContext(
  entry: object,
  messages: readonly PromptContextMessage[],
): void {
  if (messages.length > 0) entryContexts.set(entry, messages);
}

export function promptContext(entry: object): readonly PromptContextMessage[] {
  return entryContexts.get(entry) ?? [];
}

/** Send custom context through Pi's steering queue, or append it without a turn when idle. */
export async function deliverPromptContext(
  session: AgentSession,
  messages: readonly PromptContextMessage[],
): Promise<void> {
  for (const message of messages) {
    await session.sendCustomMessage(
      message,
      session.isStreaming ? { deliverAs: "steer" } : { triggerTurn: false },
    );
  }
}

/** Associate context with the index of a newly appended compaction-deferred prompt. */
export function attachPendingPromptContext(
  queue: string[],
  messages: readonly PromptContextMessage[],
): void {
  if (messages.length === 0) return;
  let contexts = pendingContexts.get(queue);
  if (!contexts) {
    contexts = new Map();
    pendingContexts.set(queue, contexts);
  }
  contexts.set(queue.length - 1, messages);
}

/** Remove context at the spliced text indices and shift the remaining associations. */
export function takePendingPromptContext(
  queue: string[],
  start: number,
  count: number,
): Array<readonly PromptContextMessage[]> {
  const contexts = pendingContexts.get(queue);
  const removed = Array.from({ length: count }, (_, index) => contexts?.get(start + index) ?? []);
  if (!contexts) return removed;
  const retained = new Map<number, readonly PromptContextMessage[]>();
  for (const [index, messages] of contexts) {
    if (index < start) retained.set(index, messages);
    else if (index >= start + count) retained.set(index - count, messages);
  }
  pendingContexts.set(queue, retained);
  return removed;
}

/** Insert context at the restored text indices and shift existing associations. */
export function restorePendingPromptContext(
  queue: string[],
  start: number,
  removed: ReadonlyArray<readonly PromptContextMessage[]>,
): void {
  const contexts = pendingContexts.get(queue) ?? new Map();
  const restored = new Map<number, readonly PromptContextMessage[]>();
  for (const [index, messages] of contexts) {
    restored.set(index < start ? index : index + removed.length, messages);
  }
  removed.forEach((messages, index) => {
    if (messages.length > 0) restored.set(start + index, messages);
  });
  pendingContexts.set(queue, restored);
}
