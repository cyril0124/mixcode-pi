import type { MixCodeTabInfo } from "../core/types.js";

/**
 * Poll cadence for noticing that a restoring tab is waiting on a human. A tab
 * publishes its pending extension interaction to
 * `tab.extensionUi.waitingForInputs` (see `addWaitingForInput`) before the
 * dialog can be answered, so a short poll is enough: restores are one-time
 * startup work and the check is a length read.
 */
const RESTORE_INPUT_POLL_MS = 25;

export interface TabRestoreQueueOptions {
  /** Load one tab; resolves once the tab is published and usable. */
  restore: (tab: MixCodeTabInfo) => Promise<void>;
  /** Called when a restoring tab opened an extension dialog instead of finishing. */
  onAwaitingInput?: (tab: MixCodeTabInfo) => void;
  /** Called when a restore rejected; the queue keeps loading the remaining tabs. */
  onError?: (tab: MixCodeTabInfo, error: unknown) => void;
}

/**
 * Restore tabs one at a time, in order, without ever waiting on the user.
 *
 * Serializing keeps the restore peak at one heavy session build. A strict
 * `for ... await` also serializes on extension `session_start` handlers that ask
 * the user a question. Such a tab is no longer loading, its session exists and it
 * waits on a human, so blocking there leaves every later tab "Not Ready" until
 * that human intervenes. Once a restoring tab publishes a pending interaction
 * the queue moves on; the parked restore keeps running and still reports failure
 * through `onError`.
 *
 * A failing tab likewise does not strand the tabs behind it.
 */
export async function restoreTabsInOrder(
  tabs: readonly MixCodeTabInfo[],
  options: TabRestoreQueueOptions,
): Promise<void> {
  for (const tab of tabs) await restoreTab(tab, options);
}

type TabRestoreOutcome = "restored" | "awaiting-input" | "failed";

async function restoreTab(
  tab: MixCodeTabInfo,
  options: TabRestoreQueueOptions,
): Promise<TabRestoreOutcome> {
  let outcome: TabRestoreOutcome | undefined;
  // Attach handlers up front: a parked restore can reject long after the queue
  // moved on, and an unattached rejection would be unhandled.
  void options.restore(tab).then(
    () => {
      outcome = "restored";
    },
    (error: unknown) => {
      outcome = "failed";
      options.onError?.(tab, error);
    },
  );
  for (;;) {
    if (outcome !== undefined) return outcome;
    if (tab.extensionUi.waitingForInputs.length > 0) {
      options.onAwaitingInput?.(tab);
      // Deliberately not awaiting the restore promise: the parked tab waits on
      // a human, and the queue must not wait with it.
      return "awaiting-input";
    }
    await Bun.sleep(RESTORE_INPUT_POLL_MS);
  }
}
