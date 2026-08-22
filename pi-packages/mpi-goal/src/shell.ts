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

// Module-graph singletons: the shell module is evaluated once per process, but
// jiti re-evaluates dynamic imports on every call, so N tabs would re-evaluate
// the gate/app graphs N times at boot. Memoize the import promises instead;
// per-pi wiring below stays per tab.
let gateModulePromise: Promise<typeof import("./session-gate.js")> | undefined;
function loadSessionGate(): Promise<typeof import("./session-gate.js")> {
	gateModulePromise ??= import("./session-gate.js");
	return gateModulePromise;
}
let appModulePromise: Promise<typeof import("./app.js")> | undefined;
function loadGoalApp(): Promise<typeof import("./app.js")> {
	appModulePromise ??= import("./app.js");
	return appModulePromise;
}

function stateFor(pi: ExtensionAPI): WireState {
	let state = wireStateByPi.get(pi);
	if (!state) {
		state = { wired: false };
		wireStateByPi.set(pi, state);
	}
	return state;
}

/** Load and apply the full wireMpiGoal surface (tools + lifecycle; command stays on shell). */
function ensureMpiGoalWired(pi: ExtensionAPI): Promise<void> {
	const state = stateFor(pi);
	if (state.wired) return Promise.resolve();
	if (!state.promise) {
		state.promise = loadGoalApp().then(({ wireMpiGoal }) => {
			wireMpiGoal(pi);
			state.wired = true;
		});
	}
	return state.promise;
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
		getArgumentCompletions: (argumentPrefix: string) => shellGoalCompletions(argumentPrefix),
		handler: async (args: string, ctx: ExtensionCommandContext) => {
			await ensureMpiGoalWired(pi);
			const { dispatchGoalCommand } = await import("./app.js");
			await dispatchGoalCommand(pi, args, ctx);
		},
	});

	// Restore path: only pay full wire when this session already has goal/queue state.
	pi.on("session_start", async (_event, ctx) => {
		const { sessionNeedsGoalWire } = await loadSessionGate();
		if (sessionNeedsGoalWire(ctx)) {
			await ensureMpiGoalWired(pi);
		}
	});
}
