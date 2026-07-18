import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { evaluateCompletionFloor } from "../../domain/floor.js";
import { commandHint, formatElapsed, formatTokensCompact, goalStatusLabel, objectiveExcerpt } from "../../domain/format.js";
import type { GoalState, GoalStatus } from "../../domain/types.js";

type ThemeColor = "accent" | "success" | "warning" | "error" | "muted" | "dim" | "text" | "border" | "borderAccent";

type GoalWidgetTheme = {
	fg(color: ThemeColor, text: string): string;
	bold(text: string): string;
};

type GoalWidgetComponent = {
	render(width: number): string[];
	invalidate(): void;
};

type StatusStyle = {
	icon: string;
	label: string;
	color: ThemeColor;
};

type ResourceSpec = {
	icon: string;
	label: string;
	used: number;
	budget?: number;
	format(value: number): string;
	suffix?: string;
};

const BAR_WIDTH = 10;

export function goalWidgetFactory(goal: GoalState): (_tui: unknown, theme: GoalWidgetTheme) => GoalWidgetComponent {
	return (_tui, theme) => new GoalWidget(goal, theme);
}

/**
 * mpi-loop-style chrome: accent DynamicBorder top/bottom, content inside.
 * One layout for all widths (truncate); no separate compact branch.
 */
export function renderGoalWidget(goal: GoalState, theme: GoalWidgetTheme, width: number): string[] {
	const container = new Container();
	const borderColor = (s: string) => theme.fg("accent", s);
	container.addChild(new DynamicBorder(borderColor));

	const style = statusStyle(goal);
	const title =
		theme.bold(`${theme.fg(style.color, style.icon)} ${theme.fg("accent", "mpi-goal")}`) +
		"  " +
		theme.fg(style.color, style.label);
	const body = [
		title,
		theme.fg("dim", objectiveExcerpt(goal.objective, Math.max(8, width - 4))),
		resourceLine(timeResource(goal), theme),
		resourceLine(tokenResource(goal), theme),
		floorLine(goal, theme),
		commandLine(goal.status, theme),
	].join("\n");
	// Match mpi-loop: indent content by 1 inside DynamicBorder.
	container.addChild(new Text(body, 1, 0));
	container.addChild(new DynamicBorder(borderColor));

	return container.render(width).map((line) => truncateToWidth(line, Math.max(1, width)));
}

class GoalWidget implements GoalWidgetComponent {
	constructor(
		private readonly goal: GoalState,
		private readonly theme: GoalWidgetTheme,
	) {}

	render(width: number): string[] {
		return renderGoalWidget(this.goal, this.theme, width);
	}

	invalidate(): void {}
}

function commandLine(status: GoalStatus, theme: GoalWidgetTheme): string {
	const commands = commandHint(status).replace(/^Commands: /, "").split(", ");
	return `${theme.fg("muted", "next")} ${commands.map((cmd) => theme.fg("accent", cmd)).join("  ")}`;
}

function resourceLine(spec: ResourceSpec, theme: GoalWidgetTheme): string {
	if (spec.budget === undefined) {
		return `${spec.icon} ${theme.fg("muted", spec.label)}  ${resourceValue(spec.used, spec.format, spec.suffix)}`;
	}
	const percent = percentage(spec.used, spec.budget);
	return [
		`${spec.icon} ${theme.fg("muted", spec.label.padEnd(6))}`,
		progressBar(percent, theme),
		`${spec.format(spec.used)} / ${spec.format(spec.budget)}`,
		`${percent}%`,
	].join("  ");
}

function progressBar(percent: number, theme: GoalWidgetTheme): string {
	const filled = Math.round((clamp(percent, 0, 100) / 100) * BAR_WIDTH);
	return `${theme.fg("success", "█".repeat(filled))}${theme.fg("dim", "░".repeat(BAR_WIDTH - filled))}`;
}

function timeResource(goal: GoalState): ResourceSpec {
	return {
		icon: "⏱",
		label: "Active",
		used: goal.timeUsedSeconds,
		budget: goal.timeBudgetSeconds,
		format: formatElapsed,
	};
}

function tokenResource(goal: GoalState): ResourceSpec {
	return {
		icon: "◈",
		label: "Tokens",
		used: goal.tokensUsed,
		budget: goal.tokenBudget,
		format: formatTokensCompact,
		suffix: "tokens",
	};
}

function floorLine(goal: GoalState, theme: GoalWidgetTheme): string {
	const floor = evaluateCompletionFloor(goal);
	if (!floor.anyFloorConfigured) return `${theme.fg("muted", "floor")} none`;
	const parts: string[] = [];
	if (goal.minTimeSecondsBeforeWrapUp !== undefined) {
		parts.push(
			`time ${formatElapsed(goal.timeUsedSeconds)} / ${formatElapsed(goal.minTimeSecondsBeforeWrapUp)}`,
		);
	}
	if (goal.minTokensBeforeWrapUp !== undefined) {
		parts.push(
			`tokens ${formatTokensCompact(goal.tokensUsed)} / ${formatTokensCompact(goal.minTokensBeforeWrapUp)}`,
		);
	}
	const state = floor.allFloorsMet ? theme.fg("success", "met") : theme.fg("warning", "before wrap-up");
	return `⌊ ${theme.fg("muted", "floor")}  ${parts.join("; ")}  ${state}`;
}

function resourceValue(value: number, format: (value: number) => string, suffix?: string): string {
	const formatted = format(value);
	return suffix ? `${formatted} ${suffix}` : formatted;
}

function percentage(used: number, budget: number): number {
	return clamp(Math.round((Math.max(0, used) / Math.max(1, budget)) * 100), 0, 100);
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

function statusStyle(goal: GoalState): StatusStyle {
	switch (goal.status) {
		case "active":
			return { icon: "🎯", label: "active", color: "accent" };
		case "paused":
			return { icon: "⏸", label: "paused", color: "warning" };
		case "budgetLimited":
			return { icon: "⚠", label: goalStatusLabel(goal), color: "warning" };
		case "complete":
			return { icon: "✓", label: "complete", color: "success" };
		default: {
			const _exhaustive: never = goal.status;
			return _exhaustive;
		}
	}
}
