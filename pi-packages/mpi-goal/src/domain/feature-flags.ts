const ENABLED_VALUES = new Set(["1", "true", "yes", "on"]);

/** Destructive tree-clear is opt-in. */
export function isContextResetClearEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const value = env.PI_GOAL_CONTEXT_RESET_CLEAR;
	if (value === undefined) return false;
	return ENABLED_VALUES.has(value.trim().toLowerCase());
}
