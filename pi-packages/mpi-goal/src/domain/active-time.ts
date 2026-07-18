import type { GoalState } from "./types.js";

/**
 * In-memory active-wall clock for goal time accounting (Codex-style).
 * Not persisted: session authority remains goal.timeUsedSeconds via account events.
 * Hot paths only do O(1) arithmetic; callers decide when to persist.
 */
let lastAccountedAt: number | null = null;
/** Sub-second remainder carried across stop/start so short turns accumulate. */
let suspendedRemainderMs = 0;

export function beginActiveTime(now = Date.now()): void {
	// Re-apply unbilled sub-second time from the previous active window.
	lastAccountedAt = now - suspendedRemainderMs;
	suspendedRemainderMs = 0;
}

/** Stop the clock, keeping only the sub-second tail for the next begin. */
export function stopActiveTime(now = Date.now()): void {
	if (lastAccountedAt !== null) {
		// Whole seconds must be take()'n first; only the sub-second tail is kept.
		suspendedRemainderMs = Math.max(0, (now - lastAccountedAt) % 1000);
	}
	lastAccountedAt = null;
}

/** Drop clock and remainder (stale/replaced goal — do not bill the next goal). */
export function discardActiveTime(): void {
	lastAccountedAt = null;
	suspendedRemainderMs = 0;
}

export function isActiveTimeRunning(): boolean {
	return lastAccountedAt !== null;
}

/** Unpersisted whole seconds since the last accounting anchor. */
export function liveActiveExtraSeconds(now = Date.now()): number {
	if (lastAccountedAt === null) return 0;
	return Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
}

/**
 * Consume whole seconds since the anchor and advance the anchor by that many seconds
 * (sub-second remainder stays on the clock for the next take).
 */
export function takeActiveElapsedSeconds(now = Date.now()): number {
	const elapsed = liveActiveExtraSeconds(now);
	if (elapsed > 0 && lastAccountedAt !== null) {
		lastAccountedAt += elapsed * 1000;
	}
	return elapsed;
}

/** Display / estimate helper: persisted used + live extra (no I/O). */
export function withLiveActiveTime(goal: GoalState, now = Date.now()): GoalState {
	const extra = liveActiveExtraSeconds(now);
	if (extra === 0) return goal;
	return { ...goal, timeUsedSeconds: goal.timeUsedSeconds + extra };
}

export function resetActiveTimeForTests(): void {
	lastAccountedAt = null;
	suspendedRemainderMs = 0;
}

/** Test-only peek. */
export function getLastAccountedAtForTests(): number | null {
	return lastAccountedAt;
}
