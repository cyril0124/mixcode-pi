import { activateTab } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";

interface CommandCompletion {
  resolve: () => void;
  reject: (error: unknown) => void;
}

const pendingConfirmations = new WeakMap<MixCodeState, CommandCompletion>();
const confirmationTails = new WeakMap<MixCodeState, Promise<void>>();
const confirmationEpochs = new WeakMap<MixCodeState, number>();

/**
 * Direct submissions finish after opening the dialog. Queued submissions hold
 * the host until cancellation or the confirmed async action finishes. Serialize
 * queued dialogs across tabs because the app owns one confirmation slot.
 */
export async function runCommandConfirmation(
  state: MixCodeState,
  queued: boolean | undefined,
  open: () => void | Promise<void>,
  ownerSessionId?: string,
  focusOwner = true,
): Promise<void> {
  if (!queued) {
    await open();
    return;
  }

  const epoch = confirmationEpochs.get(state) ?? 0;
  const previous = confirmationTails.get(state);
  const released = Promise.withResolvers<void>();
  confirmationTails.set(state, released.promise);
  await previous;

  const completion = Promise.withResolvers<void>();
  pendingConfirmations.set(state, completion);
  try {
    if (epoch !== (confirmationEpochs.get(state) ?? 0)) {
      throw new Error("Error: Queued command cancelled");
    }
    if (ownerSessionId) {
      if (!state.tabs.some((tab) => tab.sessionId === ownerSessionId)) {
        throw new Error("Error: Queued command cancelled");
      }
      // Tab-owned confirmations must be visible even when execution starts in
      // the background. Focus only when this dialog acquires the shared slot.
      if (focusOwner) activateTab(state, ownerSessionId);
    }
    // The new dialog clears existing overlays before setting its own flags.
    // Ignore that opening clear, but settle any later replacement or close.
    state.dismissQueuedConfirmation = () => {
      if (
        !state.sessionActionConfirm &&
        !state.closeAllSessionsConfirmOpen &&
        !state.deleteAllSessionsConfirmOpen
      )
        return;
      confirmationEpochs.set(state, epoch + 1);
      takeQueuedCommandCompletion(state)?.reject(new Error("Error: Queued command cancelled"));
    };
    // Observe the completion before host callbacks can cancel it synchronously.
    await Promise.all([completion.promise, Promise.resolve().then(open)]);
  } finally {
    if (pendingConfirmations.get(state) === completion) takeQueuedCommandCompletion(state);
    if (confirmationTails.get(state) === released.promise) confirmationTails.delete(state);
    released.resolve();
  }
}

/** Prevent a direct or queued submission from replacing an unresolved confirmation. */
export function assertQueuedConfirmationCanOpen(state: MixCodeState): void {
  const confirmationOpen =
    state.sessionActionConfirm ||
    state.closeAllSessionsConfirmOpen ||
    state.deleteAllSessionsConfirmOpen;
  if (pendingConfirmations.has(state) && confirmationOpen) {
    throw new Error("Error: Another session confirmation is already open");
  }
}

/** Claim once before clearing the dialog; resolve only after its action/persistence. */
export function takeQueuedCommandCompletion(state: MixCodeState): CommandCompletion | undefined {
  const completion = pendingConfirmations.get(state);
  pendingConfirmations.delete(state);
  state.dismissQueuedConfirmation = undefined;
  return completion;
}
