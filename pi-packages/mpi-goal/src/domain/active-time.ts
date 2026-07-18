import type { GoalState } from "./types.js";
import { currentGoalSessionKey } from "./session-scope.js";

/**
 * In-memory active-wall clock for goal time accounting (Codex-style).
 * Not persisted: session authority remains goal.timeUsedSeconds via account events.
 * Scoped per MixCode tab/session so concurrent tabs do not share one clock.
 *
 * Sub-second remainders carry across stop→begin so many short turns still accumulate.
 */
type ClockState = {
	lastAccountedAt: number | null;
	/** Unbilled milliseconds preserved across stop/begin (0..999 typically). */
	carryMs: number;
};

const clocks = new Map<string, ClockState>();

function clock(): ClockState {
	const key = currentGoalSessionKey();
	let state = clocks.get(key);
	if (!state) {
		state = { lastAccountedAt: null, carryMs: 0 };
		clocks.set(key, state);
	}
	return state;
}

export function beginActiveTime(now = Date.now()): void {
	const c = clock();
	// Apply carried sub-second residue so short consecutive turns accumulate.
	c.lastAccountedAt = now - c.carryMs;
	c.carryMs = 0;
}

export function stopActiveTime(now = Date.now()): void {
	const c = clock();
	if (c.lastAccountedAt !== null) {
		const leftover = Math.max(0, now - c.lastAccountedAt);
		// Keep only sub-second residue; whole seconds should have been taken already.
		c.carryMs = leftover % 1000;
	}
	c.lastAccountedAt = null;
}

/** Drop residual active seconds without billing (stale/replaced goal). */
export function discardActiveTime(): void {
	const c = clock();
	c.lastAccountedAt = null;
	c.carryMs = 0;
}

export function isActiveTimeRunning(): boolean {
	return clock().lastAccountedAt !== null;
}

/** Unpersisted whole seconds since the last accounting anchor. */
export function liveActiveExtraSeconds(now = Date.now()): number {
	const lastAccountedAt = clock().lastAccountedAt;
	if (lastAccountedAt === null) return 0;
	return Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
}

/**
 * Consume whole seconds since the anchor and advance the anchor by that many seconds
 * (sub-second remainder stays on the clock for the next take).
 */
export function takeActiveElapsedSeconds(now = Date.now()): number {
	const c = clock();
	const elapsed = liveActiveExtraSeconds(now);
	if (elapsed > 0 && c.lastAccountedAt !== null) {
		c.lastAccountedAt += elapsed * 1000;
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
	clocks.set(currentGoalSessionKey(), { lastAccountedAt: null, carryMs: 0 });
}

/** Test-only peek. */
export function getLastAccountedAtForTests(): number | null {
	return clock().lastAccountedAt;
}
