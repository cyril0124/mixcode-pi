// License notices: ./THIRD_PARTY_NOTICES.md.
import { Text, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerCleanup, registerTimer } from "./disposable.js";
import { stripAllEscapes } from "./render-utils.js";
import { BASH_CALL_OUTCOME_STATE_KEY, type BashCallOutcome } from "./types.js";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__mpiToolDisplayBashSpinnerToolCallId";
/** Narrowest label the row keeps before it falls back to the bare tool name. */
const BASH_LABEL_MIN_WIDTH = 8;
/** Characters of a command read when a row needs its text, as a label fallback or as the excerpt. */
const BASH_COMMAND_INSPECT_CHARS = 512;
/** Columns the command excerpt needs before it is dropped from the row. */
const BASH_HINT_MIN_WIDTH = 12;
/** Spaces between the label and the command excerpt. */
const BASH_LABEL_HINT_GAP = 2;
/** Space between the label (or its excerpt) and the right-aligned meta. */
const BASH_META_GAP = 1;

interface BashCallArgs {
  command?: string;
  /** Required by the tool schema; the collapsed row shows it as the call's label. */
  description?: string;
  commandPrefix?: string;
  shellPath?: string;
  timeout?: number;
}

interface BashCallRenderTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

interface BashSpinnerState {
  frameIndex: number;
  startedAt?: number;
  timer?: ReturnType<typeof setInterval>;
  /** Drops this spinner's disposable-registry entries; set once both are registered. */
  unregisterCleanup?: () => void;
}

interface BashSpinnerStateCarrier {
  [BASH_SPINNER_TOOL_CALL_ID_KEY]?: string;
}

interface BashCallRenderContextLike {
  executionStarted: boolean;
  isPartial: boolean;
  expanded?: boolean;
  invalidate?: () => void;
  lastComponent?: unknown;
  state?: unknown;
  toolCallId?: string;
}

const spinnerStatesByToolCallId = new Map<string, BashSpinnerState>();
let nextSyntheticToolCallId = 0;

function toStateCarrier(value: unknown): BashSpinnerStateCarrier | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  return value as BashSpinnerStateCarrier;
}

function getSyntheticToolCallId(carrier: BashSpinnerStateCarrier | undefined): string | undefined {
  if (!carrier) {
    return undefined;
  }

  if (!carrier[BASH_SPINNER_TOOL_CALL_ID_KEY]) {
    carrier[BASH_SPINNER_TOOL_CALL_ID_KEY] = `state:${++nextSyntheticToolCallId}`;
  }
  return carrier[BASH_SPINNER_TOOL_CALL_ID_KEY];
}

function getToolCallId(context: BashCallRenderContextLike): string | undefined {
  if (typeof context.toolCallId === "string" && context.toolCallId.trim().length > 0) {
    return context.toolCallId;
  }
  return getSyntheticToolCallId(toStateCarrier(context.state));
}

function getOrCreateSpinnerState(toolCallId: string | undefined): BashSpinnerState | undefined {
  if (!toolCallId) {
    return undefined;
  }

  let state = spinnerStatesByToolCallId.get(toolCallId);
  if (!state) {
    state = { frameIndex: 0 };
    spinnerStatesByToolCallId.set(toolCallId, state);
  }
  return state;
}

function stopSpinner(toolCallId: string | undefined, state: BashSpinnerState | undefined): void {
  if (!state) {
    return;
  }

  if (state.timer) {
    clearInterval(state.timer);
    state.timer = undefined;
  }
  state.frameIndex = 0;
  state.startedAt = undefined;
  if (toolCallId) {
    spinnerStatesByToolCallId.delete(toolCallId);
  }
  // Covers normal completion and the reload guard path: both funnel here.
  state.unregisterCleanup?.();
  state.unregisterCleanup = undefined;
}

function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return `${totalMinutes}m ${seconds}s`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h ${minutes}m`;
}

function isDefaultShellPath(shellPath: string): boolean {
  const normalized = shellPath.trim().replace(/\\/g, "/").toLowerCase();
  const basename = normalized.split("/").pop() || normalized;
  return basename === "bash" || basename === "cmd.exe";
}

function buildCommandDisplay(args: BashCallArgs): string {
  const command =
    typeof args.command === "string" && args.command.trim().length > 0
      ? stripAllEscapes(args.command)
      : "...";
  const prefix =
    typeof args.commandPrefix === "string" && args.commandPrefix.trim().length > 0
      ? stripAllEscapes(args.commandPrefix.trim())
      : "";
  return prefix ? `${prefix} ${command}` : command;
}

function buildBashCallText(
  args: BashCallArgs,
  theme: BashCallRenderTheme,
  spinnerFrame?: string,
  elapsedMs?: number,
): string {
  const commandDisplay = buildCommandDisplay(args);
  const shellSuffix =
    typeof args.shellPath === "string" &&
    args.shellPath.trim().length > 0 &&
    !isDefaultShellPath(args.shellPath)
      ? theme.fg("muted", ` [shell: ${stripAllEscapes(args.shellPath)}]`)
      : "";
  const timeoutSuffix = args.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
  const spinnerPrefix = spinnerFrame ? `${theme.fg("warning", `${spinnerFrame} `)}` : "";
  const elapsedSuffix =
    spinnerFrame && elapsedMs !== undefined
      ? theme.fg("muted", ` · ${formatElapsed(elapsedMs)}`)
      : "";

  return `${spinnerPrefix}${theme.fg("toolTitle", theme.bold("$"))} ${theme.fg("accent", commandDisplay)}${shellSuffix}${timeoutSuffix}${elapsedSuffix}`;
}

/** Status of a finished call: the one meta part the row keeps longest. */
function bashStatusText(outcome: BashCallOutcome): string {
  if (!outcome.failed) {
    return "ok";
  }
  if (outcome.exitCode !== undefined) {
    return `!! exit ${outcome.exitCode}`;
  }
  if (outcome.timedOut) {
    return "!! timed out";
  }
  if (outcome.aborted) {
    return "!! aborted";
  }
  return "!! failed";
}

/**
 * Right-aligned meta parts for the collapsed row, grouped by priority, highest first. Each group
 * drops as one unit, so a narrowing row sheds `ctrl+o`, then `timeout`/`shell`, then the output line
 * count, then the duration, and only then the status.
 */
function buildBashCallMetaGroups(
  args: BashCallArgs,
  outcome: BashCallOutcome | undefined,
  options: { spinnerFrame?: string; elapsedMs?: number },
): string[][] {
  const groups: string[][] = [];

  if (options.spinnerFrame !== undefined) {
    groups.push([`~ ${options.elapsedMs === undefined ? "0s" : formatElapsed(options.elapsedMs)}`]);
  } else if (outcome) {
    groups.push([bashStatusText(outcome)]);
    if (options.elapsedMs !== undefined) {
      groups.push([formatElapsed(options.elapsedMs)]);
    }
    groups.push([`${outcome.lineCount} ${outcome.lineCount === 1 ? "line" : "lines"}`]);
  }

  const callArguments: string[] = [];
  if (args.timeout) {
    callArguments.push(`timeout ${args.timeout}s`);
  }
  if (
    typeof args.shellPath === "string" &&
    args.shellPath.trim().length > 0 &&
    !isDefaultShellPath(args.shellPath)
  ) {
    callArguments.push(`shell ${stripAllEscapes(args.shellPath)}`);
  }
  if (callArguments.length > 0) {
    groups.push(callArguments);
  }

  groups.push(["ctrl+o"]);
  return groups;
}

/** Meta text for the row, richest first and empty last: one tier per dropped priority group. */
function buildBashCallMetaTiers(
  args: BashCallArgs,
  outcome: BashCallOutcome | undefined,
  options: { spinnerFrame?: string; elapsedMs?: number },
): string[] {
  const groups = buildBashCallMetaGroups(args, outcome, options);
  const tiers: string[] = [];
  for (let kept = groups.length; kept >= 0; kept -= 1) {
    tiers.push(groups.slice(0, kept).flat().join(" · "));
  }
  return tiers;
}

/**
 * Label for the collapsed row: the call's own `description` argument, or the bounded command text
 * when the call carries none.
 */
function bashCallLabel(args: BashCallArgs): string {
  const description = stripAllEscapes(args.description ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (description) {
    return description;
  }
  return collapsedCommand(args);
}

/** The call's command as one bounded line, or an empty string when it carries none. */
function collapsedCommand(args: BashCallArgs): string {
  return stripAllEscapes(args.command ?? "")
    .slice(0, BASH_COMMAND_INSPECT_CHARS)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * One-line excerpt of the command, shown beside the label. A command the label already carries
 * returns nothing, so a row never prints the same text twice.
 */
function bashCommandHint(args: BashCallArgs, label: string): string | undefined {
  const command = collapsedCommand(args);
  return command && command !== label ? command : undefined;
}

/**
 * Collapsed bash call row: exactly one line with `bash <label>`, a dim excerpt of the command, and
 * the status meta on the right. The label keeps its columns first, the meta then keeps the parts
 * that still fit, and the excerpt lives on what is left, so the row never wraps.
 */
function buildCollapsedBashCallRow(
  args: BashCallArgs,
  theme: BashCallRenderTheme,
  width: number,
  outcome: BashCallOutcome | undefined,
  options: {
    spinnerFrame?: string;
    elapsedMs?: number;
    finalElapsedMs?: number;
  },
): string {
  const label = bashCallLabel(args) || "...";
  const hint = bashCommandHint(args, label);
  const spinnerPrefix = options.spinnerFrame ? `${options.spinnerFrame} ` : "";
  const prefixPlain = `${spinnerPrefix}bash `;
  const prefixWidth = visibleWidth(prefixPlain);
  const title = theme.fg("toolTitle", theme.bold("bash"));
  const spinnerText = options.spinnerFrame ? theme.fg("warning", spinnerPrefix) : "";
  const elapsedMs = options.elapsedMs ?? options.finalElapsedMs;
  const widthLeft = width - prefixWidth;
  if (widthLeft < BASH_LABEL_MIN_WIDTH) {
    return truncateToWidth(`${spinnerText}${title}`, width, "");
  }

  // The label is measured first, so the first tier that fits is the richest meta the label can
  // share the row with; only a label that overflows on its own elides, and it then drops the meta.
  const labelWidth = visibleWidth(label);
  const tiers = buildBashCallMetaTiers(args, outcome, {
    spinnerFrame: options.spinnerFrame,
    elapsedMs,
  });
  const meta = tiers.find((tier) => labelWidth + metaTierWidth(tier) <= widthLeft);
  // Both parts are plain text here, so the escape `truncateToWidth` inserts around its ellipsis
  // would end the color of whatever wraps them. Strip it before the caller styles the parts.
  const shownLabel =
    meta === undefined ? stripAllEscapes(truncateToWidth(label, widthLeft, "…")) : label;
  const shownMeta = meta ?? "";
  const metaWidth = visibleWidth(shownMeta);
  const metaGap = metaWidth > 0 ? BASH_META_GAP : 0;

  // The excerpt is the lowest priority, so it takes only the columns the label and its meta leave
  // over, and needs its gap plus its own floor before the row shows it at all.
  const free = width - prefixWidth - visibleWidth(shownLabel) - metaWidth;
  const hintText = hint ?? "";
  const hintFits = hintText !== "" && free - metaGap >= BASH_LABEL_HINT_GAP + BASH_HINT_MIN_WIDTH;
  const hintBudget = hintFits
    ? Math.min(visibleWidth(hintText), free - metaGap - BASH_LABEL_HINT_GAP)
    : 0;
  const shownHint =
    hintBudget > 0 ? stripAllEscapes(truncateToWidth(hintText, hintBudget, "…")) : "";

  const hintBlockWidth = shownHint ? BASH_LABEL_HINT_GAP + visibleWidth(shownHint) : 0;
  const hintBlock = shownHint
    ? `${" ".repeat(BASH_LABEL_HINT_GAP)}${theme.fg("dim", shownHint)}`
    : "";
  const body = `${theme.fg("accent", shownLabel)}${hintBlock}`;
  const gapWidth = width - prefixWidth - visibleWidth(shownLabel) - hintBlockWidth - metaWidth;
  const gap = " ".repeat(Math.max(metaGap, gapWidth));
  const metaText = metaWidth > 0 ? theme.fg("muted", shownMeta) : "";
  return `${spinnerText}${title} ${body}${gap}${metaText}`;
}

/** Columns a meta tier occupies on the row, including its gap; an empty tier occupies none. */
function metaTierWidth(tier: string): number {
  const tierWidth = visibleWidth(tier);
  return tierWidth > 0 ? BASH_META_GAP + tierWidth : 0;
}

/** Outcome the result renderer published for this row, if the run already finished. */
function readBashCallOutcome(state: unknown): BashCallOutcome | undefined {
  const value = toOutcomeRecord(state)[BASH_CALL_OUTCOME_STATE_KEY];
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  return {
    lineCount: typeof record.lineCount === "number" ? record.lineCount : 0,
    failed: record.failed === true,
    exitCode: typeof record.exitCode === "number" ? record.exitCode : undefined,
    timedOut: record.timedOut === true,
    aborted: record.aborted === true,
  };
}

function toOutcomeRecord(state: unknown): Record<string, unknown> {
  return state && typeof state === "object" && !Array.isArray(state)
    ? (state as Record<string, unknown>)
    : {};
}

/**
 * Bash call row component. Collapsed it is one line, which needs the real render width,
 * so the row cannot be a pre-built string. Expanded it renders the full command line.
 */
class BashCallRow implements Component {
  private args: BashCallArgs;
  private theme: BashCallRenderTheme;
  private context: BashCallRenderContextLike;
  private compact: boolean;
  private spinnerFrame?: string;
  private elapsedMs?: number;
  /** Duration kept after the spinner stops, so the finished row does not keep counting. */
  private finalElapsedMs?: number;

  constructor(
    args: BashCallArgs,
    theme: BashCallRenderTheme,
    context: BashCallRenderContextLike,
    compact: boolean,
  ) {
    this.args = args;
    this.theme = theme;
    this.context = context;
    this.compact = compact;
  }

  /** Pi reuses the component, so args, theme, render context and mode must follow every update. */
  update(
    args: BashCallArgs,
    theme: BashCallRenderTheme,
    context: BashCallRenderContextLike,
    compact: boolean,
  ): void {
    this.args = args;
    this.theme = theme;
    this.context = context;
    this.compact = compact;
  }

  setSpinner(spinnerFrame?: string, elapsedMs?: number, finalElapsedMs?: number): void {
    if (spinnerFrame !== undefined) {
      this.spinnerFrame = spinnerFrame;
      this.elapsedMs = elapsedMs;
      return;
    }
    this.spinnerFrame = undefined;
    if (this.finalElapsedMs === undefined) {
      this.finalElapsedMs = finalElapsedMs ?? this.elapsedMs;
    }
    this.elapsedMs = undefined;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (!this.compact || this.context.expanded) {
      const expanded = buildBashCallText(this.args, this.theme, this.spinnerFrame, this.elapsedMs);
      return new Text(expanded, 0, 0).render(width);
    }
    return [
      buildCollapsedBashCallRow(
        this.args,
        this.theme,
        width,
        readBashCallOutcome(this.context.state),
        {
          spinnerFrame: this.spinnerFrame,
          elapsedMs: this.elapsedMs,
          finalElapsedMs: this.finalElapsedMs,
        },
      ),
    ];
  }
}

export function renderBashCall(
  args: BashCallArgs,
  theme: BashCallRenderTheme,
  context: BashCallRenderContextLike,
  compact = true,
): Component {
  const row =
    context.lastComponent instanceof BashCallRow
      ? context.lastComponent
      : new BashCallRow(args, theme, context, compact);
  row.update(args, theme, context, compact);
  const toolCallId = getToolCallId(context);
  const spinnerState = getOrCreateSpinnerState(toolCallId);
  const shouldSpin = context.executionStarted && context.isPartial;

  if (!shouldSpin) {
    // Read the runtime before stopping the spinner: stopSpinner clears startedAt.
    const finalElapsedMs =
      spinnerState?.startedAt !== undefined ? Date.now() - spinnerState.startedAt : undefined;
    stopSpinner(toolCallId, spinnerState);
    row.setSpinner(undefined, undefined, finalElapsedMs);
    return row;
  }

  if (spinnerState) {
    spinnerState.startedAt ??= Date.now();
    if (!spinnerState.timer && typeof context.invalidate === "function") {
      const timer = setInterval(() => {
        spinnerState.frameIndex = (spinnerState.frameIndex + 1) % BASH_SPINNER_FRAMES.length;
        row.setSpinner(
          BASH_SPINNER_FRAMES[spinnerState.frameIndex],
          Date.now() - (spinnerState.startedAt ?? Date.now()),
        );
        context.invalidate?.();
      }, BASH_SPINNER_INTERVAL_MS);
      spinnerState.timer = timer;
      const unregisterTimer = registerTimer(timer);
      const unregisterGuard = registerCleanup(() => {
        if (spinnerStatesByToolCallId.get(toolCallId || "") === spinnerState) {
          stopSpinner(toolCallId, spinnerState);
        }
      });
      spinnerState.unregisterCleanup = () => {
        unregisterTimer();
        unregisterGuard();
      };
    }
  }

  const spinnerFrame = spinnerState ? BASH_SPINNER_FRAMES[spinnerState.frameIndex] : undefined;
  const elapsedMs =
    spinnerState?.startedAt !== undefined ? Date.now() - spinnerState.startedAt : undefined;
  row.setSpinner(spinnerFrame, elapsedMs);
  return row;
}
