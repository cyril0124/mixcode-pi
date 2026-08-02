import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

/**
 * Thin extension entry: register /goal shell + session_start gate without
 * statically importing the full goal module graph (lifecycle/tools/overlay/…).
 * Full surface is loaded once via ensureMpiGoalWired().
 */

type WireState = {
	promise?: Promise<void>;
	wired: boolean;
};

const wireStateByPi = new WeakMap<ExtensionAPI, WireState>();

function stateFor(pi: ExtensionAPI): WireState {
	let state = wireStateByPi.get(pi);
	if (!state) {
		state = { wired: false };
		wireStateByPi.set(pi, state);
	}
	return state;
}

/** Load and apply the full wireMpiGoal surface (tools + lifecycle; command stays on shell). */
export function ensureMpiGoalWired(pi: ExtensionAPI): Promise<void> {
	const state = stateFor(pi);
	if (state.wired) return Promise.resolve();
	if (!state.promise) {
		state.promise = import("./app.js").then(({ wireMpiGoal }) => {
			wireMpiGoal(pi, { registerCommand: false });
			state.wired = true;
		});
	}
	return state.promise;
}

/** Test/helper: whether full wire has completed for this pi instance. */
export function isMpiGoalWired(pi: ExtensionAPI): boolean {
	return stateFor(pi).wired;
}

const GOAL_SUBCOMMANDS: Array<{ name: string; description: string }> = [
	{ name: "pause", description: "Pause the current goal" },
	{ name: "resume", description: "Resume a paused goal" },
	{ name: "clear", description: "Clear the current goal" },
	{ name: "queue", description: "List queued goals or enqueue a new goal" },
	{ name: "tools", description: "Activate all goal/queue model tools (Dynamic Tool Loading)" },
];

function shellGoalCompletions(argumentPrefix: string): AutocompleteItem[] | null {
	const query = argumentPrefix.trimStart();
	if (/\s/.test(query)) return null;
	const lower = query.toLowerCase();
	const items = GOAL_SUBCOMMANDS.filter((item) => item.name.startsWith(lower) || !lower).map(
		(item) =>
			({
				value: item.name,
				label: item.name,
				description: item.description,
			}) as AutocompleteItem,
	);
	return items.length ? items : null;
}

/**
 * Register the cold-path shell for mpi-goal.
 * Does not statically import app/lifecycle/tools graphs.
 */
export function registerMpiGoalShell(pi: ExtensionAPI): void {
	pi.registerCommand("goal", {
		description: "Set or view the goal for a long-running task",
		getArgumentCompletions: (argumentPrefix: string) => {
			// After full wire, prefer the rich completer (templates, etc.).
			if (isMpiGoalWired(pi)) {
				// Sync path: use already-loaded module if present in the graph.
				// Dynamic import is async; keep shell completions when not wired.
				return shellGoalCompletions(argumentPrefix);
			}
			return shellGoalCompletions(argumentPrefix);
		},
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ensureMpiGoalWired(pi);
			const { dispatchGoalCommand } = await import("./app.js");
			await dispatchGoalCommand(pi, args, ctx);
		},
	});

	// Restore path: only pay full wire when this session already has goal/queue state.
	pi.on("session_start", async (_event, ctx) => {
		const { sessionNeedsGoalWire } = await import("./session-gate.js");
		if (sessionNeedsGoalWire(ctx)) {
			await ensureMpiGoalWired(pi);
		}
	});
}
