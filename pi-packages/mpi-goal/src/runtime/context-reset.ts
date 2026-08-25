import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { PostCompletionActionRunner } from "./post-completion.js";

let commandContext: ExtensionCommandContext | undefined;

export function captureContextResetCommandContext(ctx: ExtensionCommandContext): void {
	commandContext = ctx;
}

export function createContextResetActionRunner(): PostCompletionActionRunner {
	return {
		async run(input) {
			if (input.action.type !== "context.reset") return { ok: false, actionId: input.action.id, status: "failed", severity: "warning", message: `Unsupported post-completion action ${input.action.type}` };
			if (input.action.mode === "clear") {
				const flag = process.env.PI_GOAL_CONTEXT_RESET_CLEAR?.trim().toLowerCase();
				if (flag !== "1" && flag !== "true" && flag !== "yes" && flag !== "on") {
					return { ok: true, actionId: input.action.id, status: "skipped", severity: "warning", message: "clear mode disabled by PI_GOAL_CONTEXT_RESET_CLEAR" };
				}
			}
			const ctx = commandContext;
			if (!ctx?.navigateTree || !input.action.anchorEntryId) return { ok: false, actionId: input.action.id, status: "failed", severity: "warning", message: "Context summarization for tool-created goals requires /goal tools before completion." };
			const result = await ctx.navigateTree(input.action.anchorEntryId, input.action.mode === "summarize" ? { summarize: true, customInstructions: `Summarize context for completed goal ${input.goal.goalId}.`, replaceInstructions: false } : { summarize: false });
			if (result.cancelled) return { ok: false, actionId: input.action.id, status: "failed", severity: "warning", message: "Pi tree navigation was cancelled." };
			return { ok: true, actionId: input.action.id, status: "done", message: `context reset ${input.action.mode} completed` };
		},
	};
}
