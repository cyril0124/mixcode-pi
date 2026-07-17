import type { Component } from "@earendil-works/pi-tui";
import {
	matchesKey,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	formatElapsed,
	formatTokenResource,
	formatTokensCompact,
	formatTimeResource,
	goalStatusLabel,
	objectiveExcerpt,
} from "../../domain/format.js";
import type { GoalState, GoalStatus } from "../../domain/types.js";

export type GoalQueueRow = {
	queueId: string;
	objective: string;
	template?: string;
};

export type GoalOverlaySnapshot = {
	goal: GoalState | null;
	queue: GoalQueueRow[];
};

export type GoalOverlayActions = {
	getSnapshot: () => GoalOverlaySnapshot;
	pause: () => void;
	resume: () => void;
	clear: () => void;
	enableTools?: () => void;
	removeQueueItem: (queueId: string) => void;
	clearQueue: () => void;
};

type PanelMode = "home" | "queue" | "confirm-clear" | "confirm-clear-queue";

// Keep theme untyped like mpi-loop: Theme.fg/bg use narrow color unions that
// reject string-parameter ThemeLike under strict function compatibility.
type ThemeLike = any;

const STATUS_STYLE: Record<GoalStatus, { color: string; icon: string; label: string }> = {
	active: { color: "success", icon: "●", label: "ACTIVE" },
	paused: { color: "warning", icon: "❚❚", label: "PAUSED" },
	budgetLimited: { color: "error", icon: "▲", label: "BUDGET" },
	complete: { color: "accent", icon: "✓", label: "DONE" },
};

/**
 * Full-screen-ish overlay for /goal with no args.
 * Shows status, usage bars, objective, queue, and keyboard actions.
 */
export class GoalManagementView implements Component {
	private mode: PanelMode = "home";
	private queueIndex = 0;
	private objectiveScroll = 0;

	constructor(
		private theme: ThemeLike,
		private requestRender: () => void,
		private done: () => void,
		private getMaxVisibleRows: () => number,
		private actions: GoalOverlayActions,
	) {}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.mode === "confirm-clear" || this.mode === "confirm-clear-queue") {
			this.handleConfirm(data);
			return;
		}
		if (this.mode === "queue") {
			this.handleQueueInput(data);
			return;
		}
		this.handleHomeInput(data);
	}

	private handleConfirm(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "n") || matchesKey(data, "q")) {
			this.mode = this.mode === "confirm-clear-queue" ? "queue" : "home";
			this.requestRender();
			return;
		}
		if (matchesKey(data, "y") || matchesKey(data, "enter")) {
			if (this.mode === "confirm-clear") this.actions.clear();
			else this.actions.clearQueue();
			this.mode = "home";
			this.requestRender();
		}
	}

	private handleHomeInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q")) {
			this.done();
			return;
		}
		const snap = this.actions.getSnapshot();
		if (matchesKey(data, "p")) {
			if (snap.goal?.status === "active") this.actions.pause();
			this.requestRender();
			return;
		}
		if (matchesKey(data, "r")) {
			if (snap.goal && snap.goal.status !== "complete") this.actions.resume();
			this.requestRender();
			return;
		}
		if (matchesKey(data, "x") || matchesKey(data, "c")) {
			if (snap.goal) {
				this.mode = "confirm-clear";
				this.requestRender();
			}
			return;
		}
		if (matchesKey(data, "t")) {
			this.actions.enableTools?.();
			this.requestRender();
			return;
		}
		if (matchesKey(data, "v") || matchesKey(data, "tab")) {
			this.mode = "queue";
			this.queueIndex = 0;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			this.objectiveScroll += 1;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			this.objectiveScroll = Math.max(0, this.objectiveScroll - 1);
			this.requestRender();
		}
	}

	private handleQueueInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "backspace")) {
			this.mode = "home";
			this.requestRender();
			return;
		}
		const { queue } = this.actions.getSnapshot();
		if (matchesKey(data, "up") || matchesKey(data, "k")) {
			if (queue.length) this.queueIndex = (this.queueIndex - 1 + queue.length) % queue.length;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j")) {
			if (queue.length) this.queueIndex = (this.queueIndex + 1) % queue.length;
			this.requestRender();
			return;
		}
		if (matchesKey(data, "x") || matchesKey(data, "d")) {
			const item = queue[this.queueIndex];
			if (item) {
				this.actions.removeQueueItem(item.queueId);
				this.queueIndex = Math.max(0, Math.min(this.queueIndex, queue.length - 2));
			}
			this.requestRender();
			return;
		}
		if (matchesKey(data, "c")) {
			if (queue.length) {
				this.mode = "confirm-clear-queue";
				this.requestRender();
			}
		}
	}

	render(width: number): string[] {
		const snap = this.actions.getSnapshot();
		if (this.mode === "confirm-clear") {
			return this.panel(
				[
					this.theme.fg("warning", " Clear the current goal?"),
					"",
					this.theme.fg("dim", "  Session history keeps past entries; active state is removed."),
					"",
					this.theme.fg("dim", "  y confirm   n cancel"),
				],
				width,
				"Confirm",
			);
		}
		if (this.mode === "confirm-clear-queue") {
			return this.panel(
				[
					this.theme.fg("warning", ` Clear all ${snap.queue.length} queued goals?`),
					"",
					this.theme.fg("dim", "  y confirm   n cancel"),
				],
				width,
				"Confirm",
			);
		}
		if (this.mode === "queue") return this.renderQueue(snap, width);
		return this.renderHome(snap, width);
	}

	private renderHome(snap: GoalOverlaySnapshot, width: number): string[] {
		const inner = Math.max(1, width - 2);
		const goal = snap.goal;
		const lines: string[] = [];

		if (!goal) {
			lines.push(this.theme.fg("dim", "  No active goal"));
			lines.push("");
			lines.push(this.theme.fg("dim", "  Start one:"));
			lines.push(this.theme.fg("accent", "    /goal <objective>"));
			lines.push(this.theme.fg("dim", "    /goal queue <later work>"));
			lines.push("");
			if (snap.queue.length > 0) {
				lines.push(this.theme.fg("accent", `  Queue: ${snap.queue.length} waiting  (v to inspect)`));
			} else {
				lines.push(this.theme.fg("dim", "  Queue empty"));
			}
			lines.push("");
			lines.push(this.theme.fg("dim", "  t tools   v queue   esc close"));
			return this.panel(lines, width, "mpi-goal");
		}

		const style = STATUS_STYLE[goal.status];
		const badge = this.theme.bold(this.theme.fg(style.color, `${style.icon} ${style.label}`));
		const statusText = this.theme.fg("dim", goalStatusLabel(goal));
		lines.push(`  ${badge}  ${statusText}`);
		lines.push(this.theme.fg("border", "─".repeat(inner)));

		// Usage meters
		lines.push(...this.renderMeters(goal, inner));
		lines.push(this.theme.fg("border", "─".repeat(inner)));

		// Objective
		lines.push(`  ${this.theme.bold(this.theme.fg("accent", "Objective"))}`);
		const objWidth = Math.max(1, inner - 4);
		const wrapped = wrapTextWithAnsi(goal.objective, objWidth);
		const maxObjRows = Math.max(3, Math.min(10, this.getMaxVisibleRows() - 12));
		const maxOffset = Math.max(0, wrapped.length - maxObjRows);
		this.objectiveScroll = Math.min(this.objectiveScroll, maxOffset);
		const slice = wrapped.slice(this.objectiveScroll, this.objectiveScroll + maxObjRows);
		for (const line of slice.length ? slice : [""]) {
			lines.push(`  ${line}`);
		}
		if (wrapped.length > maxObjRows) {
			lines.push(
				this.theme.fg(
					"dim",
					`  ↕ ${this.objectiveScroll + 1}-${this.objectiveScroll + slice.length}/${wrapped.length}`,
				),
			);
		}

		lines.push(this.theme.fg("border", "─".repeat(inner)));
		const queueLabel =
			snap.queue.length === 0
				? this.theme.fg("dim", "Queue empty")
				: this.theme.fg("accent", `Queue ${snap.queue.length} waiting`);
		lines.push(`  ${queueLabel}${snap.queue.length ? this.theme.fg("dim", "  ·  v to open") : ""}`);
		if (snap.queue[0]) {
			lines.push(
				this.theme.fg(
					"dim",
					`  next: ${objectiveExcerpt(snap.queue[0].objective, Math.max(20, inner - 10))}`,
				),
			);
		}

		lines.push("");
		lines.push(this.footerHints(goal));
		return this.panel(lines, width, "mpi-goal");
	}

	private renderMeters(goal: GoalState, inner: number): string[] {
		const barWidth = Math.max(10, Math.min(28, inner - 28));
		const lines: string[] = [];

		const tokenUsed = goal.tokensUsed;
		const tokenBudget = goal.tokenBudget;
		const tokenRatio = tokenBudget && tokenBudget > 0 ? Math.min(1, tokenUsed / tokenBudget) : null;
		const tokenBar =
			tokenRatio === null
				? this.theme.fg("dim", "·".repeat(barWidth))
				: this.meterBar(tokenRatio, barWidth, goal.status === "budgetLimited" ? "error" : "accent");
		const tokenText =
			tokenBudget !== undefined
				? `${formatTokensCompact(tokenUsed)} / ${formatTokensCompact(tokenBudget)}`
				: formatTokensCompact(tokenUsed);
		lines.push(`  ${this.pad("Tokens", 8)} ${tokenBar}  ${this.theme.fg("dim", tokenText)}`);

		const timeUsed = goal.timeUsedSeconds;
		const timeBudget = goal.timeBudgetSeconds;
		const timeRatio = timeBudget && timeBudget > 0 ? Math.min(1, timeUsed / timeBudget) : null;
		const timeBar =
			timeRatio === null
				? this.theme.fg("dim", "·".repeat(barWidth))
				: this.meterBar(timeRatio, barWidth, "success");
		const timeText =
			timeBudget !== undefined
				? `${formatElapsed(timeUsed)} / ${formatElapsed(timeBudget)}`
				: formatElapsed(timeUsed);
		lines.push(`  ${this.pad("Time", 8)} ${timeBar}  ${this.theme.fg("dim", timeText)}`);

		if (goal.minTokensBeforeWrapUp !== undefined || goal.minTimeSecondsBeforeWrapUp !== undefined) {
			const floorBits: string[] = [];
			if (goal.minTokensBeforeWrapUp !== undefined) {
				floorBits.push(`tok ≥ ${formatTokensCompact(goal.minTokensBeforeWrapUp)}`);
			}
			if (goal.minTimeSecondsBeforeWrapUp !== undefined) {
				floorBits.push(`time ≥ ${formatElapsed(goal.minTimeSecondsBeforeWrapUp)}`);
			}
			lines.push(`  ${this.pad("Floor", 8)} ${this.theme.fg("dim", floorBits.join("  ·  "))}`);
		}

		// compact resource lines as secondary info when no budget bars
		if (tokenBudget === undefined && timeBudget === undefined) {
			lines.push(
				this.theme.fg("dim", `  ${formatTokenResource(goal)}  ·  ${formatTimeResource(goal)}`),
			);
		}

		return lines;
	}

	private meterBar(ratio: number, width: number, color: string): string {
		const filled = Math.round(ratio * width);
		const empty = Math.max(0, width - filled);
		return (
			this.theme.fg(color, "█".repeat(Math.max(0, filled))) +
			this.theme.fg("dim", "░".repeat(empty))
		);
	}

	private footerHints(goal: GoalState): string {
		const parts: string[] = [];
		if (goal.status === "active") parts.push("p pause");
		if (goal.status === "paused" || goal.status === "budgetLimited") parts.push("r resume");
		parts.push("x clear", "t tools", "v queue", "↑↓ scroll", "esc close");
		return this.theme.fg("dim", `  ${parts.join("   ")}`);
	}

	private renderQueue(snap: GoalOverlaySnapshot, width: number): string[] {
		const inner = Math.max(1, width - 2);
		const lines: string[] = [];
		if (snap.queue.length === 0) {
			lines.push(this.theme.fg("dim", "  Queue is empty"));
			lines.push("");
			lines.push(this.theme.fg("dim", "  Enqueue: /goal queue <objective>"));
			lines.push("");
			lines.push(this.theme.fg("dim", "  esc back"));
			return this.panel(lines, width, "Queue");
		}

		const maxVisible = Math.min(12, Math.max(1, this.getMaxVisibleRows() - 4));
		const start = Math.min(
			Math.max(0, this.queueIndex - maxVisible + 1),
			Math.max(0, snap.queue.length - maxVisible),
		);
		for (let i = start; i < Math.min(snap.queue.length, start + maxVisible); i++) {
			const item = snap.queue[i];
			const selected = i === this.queueIndex;
			const marker = selected ? this.theme.fg("accent", "› ") : "  ";
			const idx = this.theme.fg("dim", String(i + 1).padStart(2, " "));
			const head = item.template ? this.theme.fg("accent", `[${item.template}] `) : "";
			const text = truncateToWidth(
				`${head}${item.objective.replace(/[\r\n]+/g, " ")}`,
				Math.max(8, inner - 8),
				"…",
			);
			const row = this.pad(`${marker}${idx}  ${text}`, inner);
			lines.push(selected ? this.theme.bg("selectedBg", row) : row);
		}
		lines.push("");
		lines.push(this.theme.fg("dim", "  ↑↓ select   x remove   c clear all   esc back"));
		return this.panel(lines, width, `Queue (${snap.queue.length})`);
	}

	private panel(lines: string[], width: number, title: string): string[] {
		const inner = Math.max(0, width - 2);
		const label = ` ${title} `;
		const border = (s: string) => this.theme.fg("border", s);
		const titleText = this.theme.bold(this.theme.fg("accent", label));
		const titlePad = this.pad(
			titleText + this.theme.fg("border", "─".repeat(Math.max(0, inner - visibleWidth(label)))),
			inner,
		);
		return [
			`${border("╭")}${titlePad}${border("╮")}`,
			...lines.map((line) => `${border("│")}${this.pad(line, inner)}${border("│")}`),
			`${border("╰")}${border("─".repeat(inner))}${border("╯")}`,
		];
	}

	private pad(text: string, width: number): string {
		const single = text.replace(/[\r\n]+/g, " ");
		const clipped = visibleWidth(single) <= width ? single : truncateToWidth(single, width, "…");
		return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
	}
}
