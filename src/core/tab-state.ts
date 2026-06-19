// Tab-state mutation seam.
//
// MixCodeTabInfo carries the per-tab agent runtime state machine. Before this
// module, ~45 sites across runtime-events / runtime-lifecycle / runtime.ts wrote
// `tab.status`, `tab.workingStartedAt` and `tab.lastWorkedDurationSeconds`
// directly, each re-deriving the timer invariant by hand. Funneling those
// writes through one seam concentrates the invariant in a single place
// (locality) and gives the runtime a small interface to exercise (leverage).
//
// The fields stay public — this is a disciplinary seam in the existing
// free-function/public-field style of core/tabs.ts, not an encapsulated class.

import type { MixCodeTabInfo, TabStatus } from "./types.js";

/** Statuses that represent the agent actively working (a timer is running). */
const WORKING_STATUSES: ReadonlySet<TabStatus> = new Set<TabStatus>(["running", "thinking"]);

export interface SetTabStatusOptions {
  /** Clock injection point; defaults to now. Tests pass a fixed Date. */
  now?: Date;
  /**
   * Force this stamp as workingStartedAt when entering a working status,
   * instead of the current time. Used by SDK post-run compaction which reuses
   * the just-ended run's start time (postRunWorkingStartedAt).
   */
  startedAt?: string;
  /**
   * Force a fresh workingStartedAt stamp when entering a working status, even if
   * one already exists. Used at a fresh agent run start, which always restarts
   * the timer. Without this, an existing stamp is preserved (??= semantics).
   */
  restart?: boolean;
  /**
   * Keep an existing workingStartedAt and skip duration computation. Used by the
   * auto-compaction continuation cycle, which stays "running" across a compaction
   * without restarting or closing the timer.
   */
  preserveStartedAt?: boolean;
}

/**
 * Set the tab status and maintain the status<->time invariant in one place:
 *   - entering a working status stamps workingStartedAt (unless preserved) and
 *     clears lastWorkedDurationSeconds
 *   - leaving a working status computes lastWorkedDurationSeconds from the stamp
 *     and clears the stamp
 *   - preserveStartedAt keeps the stamp untouched (continuation case)
 */
export function setTabStatus(
  tab: MixCodeTabInfo,
  status: TabStatus,
  options: SetTabStatusOptions = {},
): void {
  const now = options.now ?? new Date();
  tab.status = status;

  if (options.preserveStartedAt) {
    // Continuation: keep the running timer as-is, don't close it out.
    return;
  }

  if (WORKING_STATUSES.has(status)) {
    if (options.startedAt !== undefined) {
      tab.workingStartedAt = options.startedAt;
    } else if (options.restart) {
      // Fresh run: always restart the clock.
      tab.workingStartedAt = now.toISOString();
    } else {
      // ??= preserves a stamp set by an earlier working transition in the same
      // run (e.g. running -> thinking); only stamp afresh when none exists.
      tab.workingStartedAt ??= now.toISOString();
    }
    tab.lastWorkedDurationSeconds = undefined;
    return;
  }

  // Leaving work: close out the timer into a measured duration.
  tab.lastWorkedDurationSeconds = elapsedSeconds(tab.workingStartedAt, now);
  tab.workingStartedAt = undefined;
}

/** Seconds between an ISO start stamp and now, floored; undefined if no/invalid stamp. */
export function elapsedSeconds(startedAt: string | undefined, now: Date): number | undefined {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  if (!Number.isFinite(start)) return undefined;
  return Math.max(0, Math.floor((now.getTime() - start) / 1000));
}

/** Accumulate token usage onto the tab counters, treating missing fields as zero. */
export function addTabTokens(
  tab: MixCodeTabInfo,
  usage: { input?: number; output?: number },
): void {
  tab.tokenInput += usage.input ?? 0;
  tab.tokenOutput += usage.output ?? 0;
}

/** Set or clear the current context token count. */
export function setTabContextTokens(tab: MixCodeTabInfo, tokens: number | undefined): void {
  tab.currentContextTokens = tokens;
}

/** Replace the queued (pending) prompt list. */
export function setPendingMessages(tab: MixCodeTabInfo, messages: string[]): void {
  tab.pendingMessages = messages;
}
