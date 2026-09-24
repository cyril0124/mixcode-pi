// Display summary helpers; license notices: ./THIRD_PARTY_NOTICES.md.
// Scope excludes optional optimizer-specific hints and alternative output modes.
// collapsed to the frozen "summary" output modes.
import { Text } from "@earendil-works/pi-tui";
import {
  compactOutputLines,
  extractTextOutput,
  pluralize,
  previewLines,
  shortenPath,
  splitLines,
  stripAllEscapes,
  toRecord,
} from "./render-utils.js";
import {
  BASH_CALL_OUTCOME_STATE_KEY,
  type BashCallOutcome,
  type ToolDisplayConfig,
} from "./types.js";
import { countWriteContentLines, getWriteContentSizeBytes } from "./write-display-utils.js";

export { countWriteContentLines };

interface RenderThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface ToolRenderResultOptionsLike {
  expanded: boolean;
  isPartial: boolean;
}

type ToolRenderInputLike = {
  content?: Array<{ type: string; text?: string }>;
  details?: unknown;
};

export function textResult(text: string): Text {
  return new Text(text, 0, 0);
}

function partialResultText(theme: RenderThemeLike, label: string): Text {
  return textResult(theme.fg("warning", label));
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

function isToolError(result: unknown, context?: { isError?: boolean }): boolean {
  return context?.isError === true || toRecord(result).isError === true;
}

function prepareOutputLines(rawText: string, options: ToolRenderResultOptionsLike): string[] {
  return compactOutputLines(splitLines(rawText), {
    expanded: options.expanded,
    maxCollapsedConsecutiveEmptyLines: 1,
  });
}

function formatExpandHint(theme: RenderThemeLike): string {
  return theme.fg("muted", " • Ctrl+O to expand");
}

function formatTruncationHint(
  remaining: number,
  expanded: boolean,
  theme: RenderThemeLike,
): string {
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
  let text = shown.map((line) => theme.fg("toolOutput", stripAllEscapes(line))).join("\n");
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
}

function appendPreviewHints(preview: string, ctx: PreviewHintContext): string {
  const { config, theme, lines, options } = ctx;
  if (!options.expanded) return preview;
  return preview + formatExpandedPreviewCapHint(lines, config, theme);
}

function renderContentPreview(ctx: PreviewHintContext, expandedOnly = false): Text {
  return renderPreviewText(
    ctx.lines,
    ctx.config,
    ctx.theme,
    ctx.options,
    (p) => appendPreviewHints(p, ctx),
    expandedOnly,
  );
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

function formatBashSummary(lines: string[], theme: RenderThemeLike): string {
  const lineCount = lines.length;
  return theme.fg("muted", `↳ ${lineCount} ${pluralize(lineCount, "line")} returned`);
}

/** Live/expanded bash preview budget for the partial and expanded states. */
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
): Text {
  let preview = buildPreviewText(lines, maxLines, theme, options.expanded);
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
): Text {
  const lines = prepareOutputLines(rawOutput, options);
  if (lines.length === 0) {
    return textResult("");
  }
  const maxLines = getBashPreviewLineLimit(lines, options, config);
  if (!options.expanded && maxLines === 0) {
    return textResult("");
  }
  return renderBashPreviewWithHints(lines, maxLines, config, theme, options);
}

function renderBashErrorResult(
  lines: string[],
  options: ToolRenderResultOptionsLike,
  config: ToolDisplayConfig,
  theme: RenderThemeLike,
  compact: boolean,
  /** Pi's own status line is missing, so the message sits at the head of the output. */
  headFirst: boolean,
): Text {
  if (lines.length === 0) {
    return textResult("");
  }
  if (options.expanded) {
    const maxLines = getExpandedPreviewLineLimit(lines, config);
    const preview = lines
      .slice(0, maxLines)
      .map((line) => theme.fg("error", stripAllEscapes(line)))
      .join("\n");
    return textResult(preview + formatExpandedPreviewCapHint(lines, config, theme));
  }
  if (!compact) {
    // Non-compact presentation: a header plus a head preview of the failure output.
    if (config.previewLines === 0) {
      return textResult(theme.fg("error", "↳ command failed"));
    }
    const { shown, remaining } = previewLines(lines, config.previewLines);
    const body = shown.map((line) => theme.fg("error", stripAllEscapes(line))).join("\n");
    return textResult(
      `${theme.fg("error", "↳ command failed")}\n${body}${formatTruncationHint(remaining, false, theme)}`,
    );
  }
  const maxLines = Math.max(0, config.bashFailureTailLines);
  if (maxLines === 0) {
    return textResult("");
  }
  // Pi appends its failure status to the end of the output (`Command exited with code N`), so that
  // case keeps the tail. A validation or spawn failure has its message first instead, and the
  // arguments dump last, so that case keeps the head. The call row reports code and line count.
  const content = lines.filter((line) => line.trim().length > 0);
  const shown = headFirst ? content.slice(0, maxLines) : content.slice(-maxLines);
  return textResult(shown.map((line) => theme.fg("error", stripAllEscapes(line))).join("\n"));
}

/**
 * Pi appends its failure status as the last output line, so only that line is trusted: a
 * command that merely prints the same sentence must not choose the row's status.
 */
function parseBashFailure(
  rawOutput: string,
): Pick<BashCallOutcome, "exitCode" | "timedOut" | "aborted"> {
  const lastLine =
    rawOutput
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .pop() ?? "";
  const exitMatch = /^Command exited with code (-?\d+)$/.exec(lastLine);
  return {
    exitCode: exitMatch ? Number(exitMatch[1]) : undefined,
    timedOut: /^Command timed out after [\d.]+ seconds$/.test(lastLine),
    aborted: lastLine === "Command aborted",
  };
}

/** Publishes the compact outcome the call renderer reads on its next render. */
function recordBashOutcome(state: unknown, outcome: BashCallOutcome): void {
  toRecord(state)[BASH_CALL_OUTCOME_STATE_KEY] = outcome;
}

/** Bash result renderer; `compact` selects the one-row presentation of a finished call. */
export function renderBashDisplayResult(
  result: ToolRenderInputLike,
  options: ToolRenderResultOptionsLike,
  config: ToolDisplayConfig,
  theme: RenderThemeLike,
  context: { state?: unknown; isError?: boolean } | undefined,
  compact = true,
): Text {
  const rawOutput = extractTextOutput(result);

  if (options.isPartial) {
    return renderBashLivePreview(rawOutput, options, config, theme);
  }

  const lines = prepareOutputLines(rawOutput, options);
  const failed = isToolError(result, context);
  const failure = parseBashFailure(rawOutput);
  recordBashOutcome(context?.state, {
    lineCount: lines.length,
    failed,
    ...failure,
  });

  if (failed) {
    const hasStatusLine = failure.exitCode !== undefined || failure.timedOut || failure.aborted;
    return renderBashErrorResult(lines, options, config, theme, compact, !hasStatusLine);
  }

  if (options.expanded) {
    const maxLines = getExpandedPreviewLineLimit(lines, config);
    return renderBashPreviewWithHints(lines, maxLines, config, theme, options);
  }

  if (!compact) {
    if (lines.length === 0) {
      return textResult(theme.fg("muted", "↳ (no output)"));
    }
    return textResult(formatBashSummary(lines, theme) + formatExpandHint(theme));
  }

  // Collapsed success in compact mode: the call row carries the `<N> lines` meta, so this
  // region is empty.
  return textResult("");
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

function formatReadSummary(lines: string[], theme: RenderThemeLike): string {
  const lineCount = lines.length;
  return theme.fg("muted", `↳ loaded ${lineCount} ${pluralize(lineCount, "line")}`);
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

  const rawOutput = extractTextOutput(result);
  const lines = prepareOutputLines(rawOutput, options);
  const hintCtx: PreviewHintContext = { lines, config, theme, options };

  if (options.expanded) {
    return renderContentPreview(hintCtx, true);
  }

  const summaryLines = compactOutputLines(splitLines(rawOutput), { expanded: true });
  return textResult(formatReadSummary(summaryLines, theme) + formatExpandHint(theme));
}

// ---------------------------------------------------------------------------
// edit / write summaries
// ---------------------------------------------------------------------------

function formatLineCountSuffix(lineCount: number, theme: RenderThemeLike): string {
  return theme.fg("muted", ` (${lineCount} ${pluralize(lineCount, "line")})`);
}

function formatWriteCallSuffix(
  lineCount: number,
  sizeBytes: number,
  theme: RenderThemeLike,
  formatSize: (bytes: number) => string,
): string {
  return theme.fg(
    "muted",
    ` (${lineCount} ${pluralize(lineCount, "line")} • ${formatSize(sizeBytes)})`,
  );
}

function formatInProgressLineCount(
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
  const suffix =
    content !== undefined ? formatWriteCallSuffix(lineCount, sizeBytes, theme, formatSize) : "";
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
    return {
      fallbackText,
      earlyResult: textResult(theme.fg("error", fallbackText || errorMessage)),
    };
  }
  return { fallbackText, earlyResult: undefined };
}
