import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Per-session isolation for mpi-goal module state.
 * MixCode runs multiple tabs in one process; extension modules are singletons.
 * Without this, getGoal() in tab B can see tab A's in-memory goal.
 */
const storage = new AsyncLocalStorage<string>();

const DEFAULT_KEY = "__no_session__";

export type SessionIdSource = {
	getSessionId?: () => string;
	getSessionFile?: () => string | null | undefined;
};

export function goalSessionKeyFromManager(sessionManager: SessionIdSource): string {
	const id = typeof sessionManager.getSessionId === "function" ? sessionManager.getSessionId() : undefined;
	if (id && id.length > 0) return id;
	const file = typeof sessionManager.getSessionFile === "function" ? sessionManager.getSessionFile() : undefined;
	if (file && file.length > 0) return file;
	return DEFAULT_KEY;
}

export function currentGoalSessionKey(): string {
	return storage.getStore() ?? DEFAULT_KEY;
}

export function runInGoalSession<T>(sessionKey: string, fn: () => T): T {
	return storage.run(sessionKey, fn);
}

export function withGoalSessionFromCtx<T>(
	ctx: { sessionManager: SessionIdSource },
	fn: () => T,
): T {
	return runInGoalSession(goalSessionKeyFromManager(ctx.sessionManager), fn);
}
