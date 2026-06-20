import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

/**
 * Per-session live state cells.
 *
 * ponytail: keyed by session id so multiple MixCode tabs (each a distinct
 * AgentSession sharing this single, process-wide extension module) keep
 * independent todo lists. Upstream used a single module-level `state` cell,
 * which made every tab read and write the same list — the editor overlay was
 * shared across tabs. Map keyed by session id is the smallest change that
 * isolates them; a WeakMap can't be used because the key is a string id, not
 * the session object.
 *
 * Entries are created lazily on first read/write and dropped on
 * `disposeSession` (wired from the extension's `session_shutdown` handler) so
 * closed tabs don't leak.
 */
const statesBySession = new Map<string, TaskState>();

function freshState(): TaskState {
	return { tasks: [...EMPTY_STATE.tasks], nextId: EMPTY_STATE.nextId };
}

function cell(sessionId: string): TaskState {
	let state = statesBySession.get(sessionId);
	if (!state) {
		state = freshState();
		statesBySession.set(sessionId, state);
	}
	return state;
}

/**
 * Live tasks accessor. Returned `readonly Task[]` so callers (overlay render
 * hook, `/todos` command, `renderCall` subject lookup) cannot mutate the live
 * cell. Consumers must not cast back.
 */
export function getTodos(sessionId: string): readonly Task[] {
	return cell(sessionId).tasks;
}

export function getNextId(sessionId: string): number {
	return cell(sessionId).nextId;
}

/** Snapshot accessor used by reducer callers to pass canonical state in. */
export function getState(sessionId: string): TaskState {
	return cell(sessionId);
}

/**
 * Replay seam. Lifecycle handlers in `index.ts` call this on
 * `session_start` / `session_compact` / `session_tree` after
 * `replayFromBranch` decodes the latest snapshot.
 */
export function replaceState(sessionId: string, next: TaskState): void {
	statesBySession.set(sessionId, next);
}

/**
 * Post-reducer commit seam. Tool execute() calls this with the reducer's
 * `state` output to publish the new canonical state to live readers (overlay,
 * `/todos`, renderCall).
 */
export function commitState(sessionId: string, next: TaskState): void {
	statesBySession.set(sessionId, next);
}

/**
 * Drop a session's state cell. Wired from `session_shutdown` so closed tabs
 * release their todo list instead of accumulating in the process-wide map.
 */
export function disposeSession(sessionId: string): void {
	statesBySession.delete(sessionId);
}

/**
 * Test-setup reset. Wired into the global `test/setup.ts` `beforeEach` via
 * the existing `__resetState` import path. Clears every session cell so tests
 * start from a clean slate regardless of which session ids they used.
 */
export function __resetState(): void {
	statesBySession.clear();
}
