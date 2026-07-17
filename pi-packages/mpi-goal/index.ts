import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wireMpiGoal } from "./src/app.js";

/**
 * mpi-goal — MixCode built-in goal extension.
 *
 * Capability surface follows npm:pi-goals (goal/queue/templates/budgets/floors/
 * continuation/UI) without the external churn-monitor subprocess.
 *
 * Progressive tool disclosure (Pi Dynamic Tool Loading):
 * all goal tools are registerTool'd at load, but stay out of the active set
 * until the user runs /goal, /goal tools, overlay "t", or an unfinished goal
 * is restored from session state. Activation uses additive setActiveTools only,
 * and never during factory load (runtime not bound yet).
 */
export default function mpiGoal(pi: ExtensionAPI): void {
	wireMpiGoal(pi);
}
