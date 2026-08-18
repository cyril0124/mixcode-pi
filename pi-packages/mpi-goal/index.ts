import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMpiGoalShell } from "./src/shell.js";

/**
 * mpi-goal — MixCode built-in goal extension.
 *
 * Capability surface follows npm:pi-goals (goal/queue/templates/budgets/floors/
 * continuation/UI) without the external churn-monitor subprocess.
 *
 * Cold load: only the thin shell is imported (command registration + session gate).
 * Full tools/lifecycle/overlay graph is loaded once via ensureMpiGoalWired() on
 * first /goal use or when session restore finds an unfinished goal/queue.
 *
 * Progressive tool disclosure (Pi Dynamic Tool Loading):
 * after full wire, all goal tools are registerTool'd but stay out of the active
 * set until the user runs /goal, /goal tools, overlay "t", or an unfinished goal
 * is restored. Activation uses additive setActiveTools only, and never during
 * factory load (runtime not bound yet).
 */
export default function mpiGoal(pi: ExtensionAPI): void {
	registerMpiGoalShell(pi);
}
