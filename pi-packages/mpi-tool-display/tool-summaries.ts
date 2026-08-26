// Display summary helpers; license notices: ./THIRD_PARTY_NOTICES.md.
// Scope excludes optional optimizer-specific hints and alternative output modes.
// collapsed to the frozen "summary" output modes.
import { Text } from "@earendil-works/pi-tui";
import type { BashToolDetails, ReadToolDetails } from "@earendil-works/pi-coding-agent";
import {
	compactOutputLines,
	extractTextOutput,
	isLikelyQuietCommand,
	pluralize,
	previewLines,
	shortenPath,
	splitLines,
	stripAllEscapes,
} from "./render-utils.js";
import type { ToolDisplayConfig } from "./types.js";
import {
	countWriteContentLines,
	getWriteContentSizeBytes,
} from "./write-display-utils.js";

export { countWriteContentLines };

export interface RenderThemeLike {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ToolRenderResultOptionsLike {
	expanded: boolean;
	isPartial: boolean;
}

export type ToolRenderInputLike = {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
};

export function textResult(text: string): Text {
	return new Text(text, 0, 0);
}

export function partialResultText(theme: RenderThemeLike, label: string): Text {
	return textResult(theme.fg("warning", label));
}

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

export function getStringField(value: unknown, field: string): string | undefined {
	const raw = toRecord(value)[field];
	return typeof raw === "string" ? raw : undefined;
}

function getNumericField(value: unknown, field: string): number | undefined {
	const raw = toRecord(value)[field];
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

export function getToolPathArg(value: unknown): string | undefined {
	return getStringField(value, "file_path") ?? getStringField(value, "path");
}

export function getToolContentArg(value: unknown): string | undefined {
	return getStringField(value, "content");
}

function getEditPayloadLineCount(value: unknown): number {
	const record = toRecord(value);
	const lines = record.lines;
	if (Array.isArray(lines)) {
		return lines.filter((line): line is string => typeof line === "string").length;
	}
	if (typeof lines === "string") {
		return countTextLines(lines);
	}
	return countTextLines(record.newText);
}

/** Count lines while preserving a trailing empty segment (splitLines keeps a trailing empty segment). */
function countTextLines(value: unknown): number {
	if (typeof value !== "string") {
		return 0;
	}
	return splitLines(value).length;
}

export function getEditLineCount(value: unknown): number {
	const record = toRecord(value);
	const edits = Array.isArray(record.edits) ? (record.edits as unknown[]) : [];
	if (edits.length > 0) {
		return edits.reduce<number>((total, edit) => total + getEditPayloadLineCount(edit), 0);
	}
	return getEditPayloadLineCount(record);
}

export function isToolError(result: unknown, context?: { isError?: boolean }): boolean {
	return context?.isError === true || toRecord(result).isError === true;
}

export function prepareOutputLines(
	rawText: string,
	options: ToolRenderResultOptionsLike,
): string[] {
	return compactOutputLines(splitLines(rawText), {
		expanded: options.expanded,
		maxCollapsedConsecutiveEmptyLines: 1,
	});
}

export function formatExpandHint(theme: RenderThemeLike): string {
	return theme.fg("muted", " • Ctrl+O to expand");
}

function formatTruncationHint(remaining: number, expanded: boolean, theme: RenderThemeLike): string {
	if (remaining <= 0) {
		return "";
	}
	const hint = expanded ? "" : " • Ctrl+O to expand";
	return `\n${theme.fg("muted", `... (${remaining} more ${pluralize(remaining, "line")}${hint})`)}`;
}

function buildPreviewText(
	lines: string[],
	maxLines: number,
	theme: RenderThemeLike,
	expanded: boolean,
): string {
	if (lines.length === 0) {
		return theme.fg("muted", "↳ (no output)");
	}
	const { shown, remaining } = previewLines(lines, maxLines);
	let text = shown
		.map((line) => theme.fg("toolOutput", stripAllEscapes(line)))
		.join("\n");
	text += formatTruncationHint(remaining, expanded, theme);
	return text;
}

function getExpandedPreviewLineLimit(lines: string[], config: ToolDisplayConfig): number {
	const limit = Math.max(0, config.expandedPreviewMaxLines);
	if (limit === 0) {
		return lines.length;
	}
	return Math.min(lines.length, limit);
}

function formatExpandedPreviewCapHint(
	lines: string[],
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
): string {
	const cap = Math.max(0, config.expandedPreviewMaxLines);
	if (cap === 0 || lines.length <= cap) {
		return "";
	}
	return `\n${theme.fg("warning", `(display capped at ${cap} lines by tool-display setting)`)}`;
}

function truncationHint(details: { truncation?: { truncated?: boolean } } | undefined): string {
	return details?.truncation?.truncated ? " • truncated" : "";
}

function renderPreviewText(
	lines: string[],
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
	options: ToolRenderResultOptionsLike,
	appendHints: (preview: string) => string,
	expandedOnly = false,
): Text {
	const useExpanded = expandedOnly || options.expanded;
	const maxLines = useExpanded ? getExpandedPreviewLineLimit(lines, config) : config.previewLines;
	const preview = buildPreviewText(lines, maxLines, theme, useExpanded);
	return textResult(appendHints(preview));
}

interface PreviewHintContext {
	lines: string[];
	config: ToolDisplayConfig;
	theme: RenderThemeLike;
	options: ToolRenderResultOptionsLike;
	details: unknown;
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
	const { config, theme, details, lines, options } = ctx;
	let next = preview;
	if (config.showTruncationHints && toRecord(toRecord(details).truncation).truncated) {
		next += `\n${theme.fg("warning", "(truncated by backend limits)")}`;
	}
	if (options.expanded) {
		next += formatExpandedPreviewCapHint(lines, config, theme);
	}
	return next;
}

function renderContentPreview(ctx: PreviewHintContext, expandedOnly = false): Text {
	return renderPreviewText(ctx.lines, ctx.config, ctx.theme, ctx.options, (p) => appendPreviewHints(p, ctx), expandedOnly);
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function formatBashNoOutputLine(command: string | undefined, theme: RenderThemeLike): string {
	if (isLikelyQuietCommand(command)) {
		return theme.fg("muted", "↳ command completed (no output)");
	}
	return theme.fg("muted", "↳ (no output)");
}

function formatBashSummary(lines: string[], theme: RenderThemeLike): string {
	const lineCount = lines.length;
	return theme.fg("muted", `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`);
}

function formatBashTruncationHints(
	details: BashToolDetails | undefined,
	theme: RenderThemeLike,
): string {
	if (!details) {
		return "";
	}
	const hints: string[] = [];
	if (details.truncation?.truncated) {
		hints.push("output truncated");
	}
	if (details.fullOutputPath) {
		hints.push(`full output: ${details.fullOutputPath}`);
	}
	if (hints.length === 0) {
		return "";
	}
	return `\n${theme.fg("warning", `(${hints.join(" • ")})`)}`;
}

/** Configured bash output mode: live/expanded previews use previewLines. */
function getBashPreviewLineLimit(
	lines: string[],
	options: ToolRenderResultOptionsLike,
	config: ToolDisplayConfig,
): number {
	if (options.expanded) {
		return getExpandedPreviewLineLimit(lines, config);
	}
	return config.previewLines;
}

function renderBashPreviewWithHints(
	lines: string[],
	maxLines: number,
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
	options: ToolRenderResultOptionsLike,
	details: BashToolDetails | undefined,
): Text {
	let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
	if (config.showTruncationHints) {
		preview += formatBashTruncationHints(details, theme);
	}
	if (options.expanded) {
		preview += formatExpandedPreviewCapHint(lines, config, theme);
	}
	return textResult(preview);
}

function renderBashLivePreview(
	rawOutput: string,
	options: ToolRenderResultOptionsLike,
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
	details: BashToolDetails | undefined,
): Text {
	const lines = prepareOutputLines(rawOutput, options);
	if (lines.length === 0) {
		return textResult("");
	}
	const maxLines = getBashPreviewLineLimit(lines, options, config);
	if (!options.expanded && maxLines === 0) {
		return textResult("");
	}
	return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
}

function renderBashErrorResult(
	rawOutput: string,
	options: ToolRenderResultOptionsLike,
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
	details: BashToolDetails | undefined,
): Text {
	const lines = prepareOutputLines(rawOutput, options);
	let text = theme.fg("error", "↳ command failed");

	if (lines.length > 0) {
		const maxLines = getBashPreviewLineLimit(lines, options, config);
		if (options.expanded || maxLines > 0) {
			const { shown, remaining } = previewLines(lines, maxLines);
			text += `\n${shown
				.map((line) => theme.fg("error", stripAllEscapes(line)))
				.join("\n")}`;
			text += formatTruncationHint(remaining, options.expanded, theme);
		}
	}

	if (config.showTruncationHints) {
		text += formatBashTruncationHints(details, theme);
	}
	if (options.expanded && lines.length > 0) {
		text += formatExpandedPreviewCapHint(lines, config, theme);
	}
	return textResult(text);
}

/** Bash result renderer with the output mode frozen to "summary". */
export function renderBashDisplayResult(
	result: ToolRenderInputLike,
	options: ToolRenderResultOptionsLike,
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
	context: { args?: unknown; isError?: boolean } | undefined,
): Text {
	const details = result.details as BashToolDetails | undefined;
	const rawOutput = extractTextOutput(result);

	if (options.isPartial) {
		return renderBashLivePreview(rawOutput, options, config, theme, details);
	}
	if (isToolError(result, context)) {
		return renderBashErrorResult(rawOutput, options, config, theme, details);
	}

	const lines = prepareOutputLines(rawOutput, options);
	if (lines.length === 0) {
		let text = formatBashNoOutputLine(getStringField(context?.args, "command"), theme);
		if (config.showTruncationHints) {
			text += formatBashTruncationHints(details, theme);
		}
		return textResult(text);
	}

	if (options.expanded) {
		const maxLines = getExpandedPreviewLineLimit(lines, config);
		return renderBashPreviewWithHints(lines, maxLines, config, theme, options, details);
	}

	let summary = formatBashSummary(lines, theme);
	summary += formatExpandHint(theme);
	if (config.showTruncationHints) {
		summary += formatBashTruncationHints(details, theme);
	}
	return textResult(summary);
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function renderReadDisplayCall(args: unknown, theme: RenderThemeLike): Text {
	const path = shortenPath(getToolPathArg(args));
	const offset = getNumericField(args, "offset");
	const limit = getNumericField(args, "limit");
	let suffix = "";
	if (offset !== undefined || limit !== undefined) {
		const from = offset ?? 1;
		const to = limit !== undefined ? from + limit - 1 : undefined;
		suffix = to ? `:${from}-${to}` : `:${from}`;
	}
	const line = `${theme.fg("toolTitle", theme.bold("read"))} ${theme.fg("accent", path || "...")}${theme.fg("warning", suffix)}`;
	return textResult(line);
}

function formatReadSummary(
	lines: string[],
	details: ReadToolDetails | undefined,
	theme: RenderThemeLike,
	showTruncationHints: boolean,
): string {
	const lineCount = lines.length;
	let summary = theme.fg("muted", `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`);
	summary += theme.fg("warning", showTruncationHints ? truncationHint(details) : "");
	return summary;
}

/** Read result renderer with the output mode frozen to "summary". */
export function renderReadDisplayResult(
	result: ToolRenderInputLike,
	options: ToolRenderResultOptionsLike,
	config: ToolDisplayConfig,
	theme: RenderThemeLike,
): Text {
	if (options.isPartial) {
		return partialResultText(theme, "reading...");
	}

	const details = result.details as ReadToolDetails | undefined;
	const rawOutput = extractTextOutput(result);
	const lines = prepareOutputLines(rawOutput, options);
	const hintCtx: PreviewHintContext = { lines, config, theme, options, details };

	if (options.expanded) {
		return renderContentPreview(hintCtx, true);
	}

	const summaryLines = compactOutputLines(splitLines(rawOutput), { expanded: true });
	let summary = formatReadSummary(summaryLines, details, theme, config.showTruncationHints);
	summary += formatExpandHint(theme);
	return textResult(summary);
}

// ---------------------------------------------------------------------------
// edit / write summaries
// ---------------------------------------------------------------------------

export function formatLineCountSuffix(lineCount: number, theme: RenderThemeLike): string {
	return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

export function formatWriteCallSuffix(
	lineCount: number,
	sizeBytes: number,
	theme: RenderThemeLike,
	formatSize: (bytes: number) => string,
): string {
	return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`);
}

export function formatInProgressLineCount(
	action: string,
	lineCount: number,
	theme: RenderThemeLike,
): string {
	return theme.fg("warning", `${action}...`) + formatLineCountSuffix(lineCount, theme);
}

export function buildEditCallSummaryText(args: unknown, theme: RenderThemeLike): string {
	const path = shortenPath(getToolPathArg(args));
	const lineCount = getEditLineCount(args);
	return `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path || "...")}${formatLineCountSuffix(lineCount, theme)}`;
}

export function buildWriteCallSummaryText(
	args: unknown,
	theme: RenderThemeLike,
	formatSize: (bytes: number) => string,
): string {
	const content = getToolContentArg(args);
	const lineCount = countWriteContentLines(content);
	const sizeBytes = getWriteContentSizeBytes(content);
	const path = shortenPath(getToolPathArg(args));
	const suffix = content !== undefined
		? formatWriteCallSuffix(lineCount, sizeBytes, theme, formatSize)
		: "";
	return `${theme.fg("toolTitle", theme.bold("write"))} ${theme.fg("accent", path || "...")}${suffix}`;
}

/** Shared edit/write result gate: progress line while partial, error line on failure. */
export function handleEditOrWriteResult(
	result: ToolRenderInputLike,
	options: ToolRenderResultOptionsLike,
	context: { isError?: boolean } | undefined,
	theme: RenderThemeLike,
	lineCount: number,
	progressLabel: string,
	errorMessage: string,
): { fallbackText: string; earlyResult: Text | undefined } {
	if (options.isPartial) {
		return {
			fallbackText: "",
			earlyResult: new Text(formatInProgressLineCount(progressLabel, lineCount, theme), 0, 0),
		};
	}
	const fallbackText = stripAllEscapes(extractTextOutput(result));
	if (isToolError(result, context)) {
		return { fallbackText, earlyResult: textResult(theme.fg("error", fallbackText || errorMessage)) };
	}
	return { fallbackText, earlyResult: undefined };
}
