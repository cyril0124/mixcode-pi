import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { GOAL_TOOL_NAME_SET, GOAL_TOOL_NAMES } from "./names.js";

/**
 * Progressive disclosure for goal tools (Pi Dynamic Tool Loading):
 * tools are always registered via registerTool, but stay out of the active set
 * until the user runs /goal or an unfinished goal is restored from session state.
 *
 * Activation is additive only — never drop currently active non-goal tools.
 */
export function enableGoalTools(pi: ExtensionAPI): string[] {
	const active = pi.getActiveTools();
	const missing = GOAL_TOOL_NAMES.filter((name) => !active.includes(name));
	if (missing.length === 0) return [];
	pi.setActiveTools([...new Set([...active, ...GOAL_TOOL_NAMES])]);
	return [...missing];
}

export function isGoalToolsActive(pi: ExtensionAPI): boolean {
	const active = new Set(pi.getActiveTools());
	return GOAL_TOOL_NAMES.every((name) => active.has(name));
}

export function anyGoalToolActive(pi: ExtensionAPI): boolean {
	return pi.getActiveTools().some((name) => GOAL_TOOL_NAME_SET.has(name));
}

/** Drop goal tools from the active set while keeping every other tool. */
export function disableGoalTools(pi: ExtensionAPI): void {
	const next = pi.getActiveTools().filter((name) => !GOAL_TOOL_NAME_SET.has(name));
	pi.setActiveTools(next);
}
