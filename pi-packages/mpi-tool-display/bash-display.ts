// License notices: ./THIRD_PARTY_NOTICES.md.
import { Text, type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { registerCleanup, registerTimer } from "./disposable.js";
import { stripAllEscapes } from "./render-utils.js";
import { BASH_CALL_OUTCOME_STATE_KEY, type BashCallOutcome } from "./types.js";

const BASH_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const BASH_SPINNER_INTERVAL_MS = 200;
const BASH_SPINNER_TOOL_CALL_ID_KEY = "__mpiToolDisplayBashSpinnerToolCallId";
/** Narrowest label worth showing next to the status meta before the meta is dropped. */
const BASH_LABEL_MIN_WIDTH = 8;
/** Characters of a command inspected when a call carries no `description` to show instead. */
const BASH_LABEL_FALLBACK_CHARS = 512;

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

/** Right-aligned status parts for the collapsed row, most informative first. */
function buildBashCallMetaParts(
  args: BashCallArgs,
  outcome: BashCallOutcome | undefined,
  options: { spinnerFrame?: string; elapsedMs?: number },
): string[][] {
  const required: string[] = [];
  const optional: string[] = [];

  if (options.spinnerFrame !== undefined) {
    required.push(`~ ${options.elapsedMs === undefined ? "0s" : formatElapsed(options.elapsedMs)}`);
  } else if (outcome) {
    if (outcome.failed) {
      const status =
        outcome.exitCode !== undefined
          ? `!! exit ${outcome.exitCode}`
          : outcome.timedOut
            ? "!! timed out"
            : outcome.aborted
              ? "!! aborted"
              : "!! failed";
      required.push(status);
    } else {
      required.push("ok");
    }
    required.push(`${outcome.lineCount} ${outcome.lineCount === 1 ? "line" : "lines"}`);
    if (options.elapsedMs !== undefined) {
      required.push(formatElapsed(options.elapsedMs));
    }
  }

  if (args.timeout) {
    optional.push(`timeout ${args.timeout}s`);
  }
  if (
    typeof args.shellPath === "string" &&
    args.shellPath.trim().length > 0 &&
    !isDefaultShellPath(args.shellPath)
  ) {
    optional.push(`shell ${stripAllEscapes(args.shellPath)}`);
  }
  optional.push("ctrl+o");

  return [[...required, ...optional], [...required, "ctrl+o"], [...required], []];
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
  return stripAllEscapes(args.command ?? "")
    .slice(0, BASH_LABEL_FALLBACK_CHARS)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Collapsed bash call row: exactly one line with `bash <label>` on the left and status meta on the
 * right. The label is elided and optional meta parts are dropped, so the row never wraps.
 */
function buildCollapsedBashCallRow(
  args: BashCallArgs,
  theme: BashCallRenderTheme,
  width: number,
  outcome: BashCallOutcome | undefined,
  options: { spinnerFrame?: string; elapsedMs?: number; finalElapsedMs?: number },
): string {
  const label = bashCallLabel(args) || "...";
  const spinnerPrefix = options.spinnerFrame ? `${options.spinnerFrame} ` : "";
  const prefixPlain = `${spinnerPrefix}bash `;
  const elapsedMs = options.elapsedMs ?? options.finalElapsedMs;
  const metaParts = buildBashCallMetaParts(args, outcome, {
    spinnerFrame: options.spinnerFrame,
    elapsedMs,
  });

  for (const parts of metaParts) {
    const metaPlain = parts.join(" · ");
    const reserved = visibleWidth(prefixPlain) + (metaPlain ? visibleWidth(` ${metaPlain}`) : 0);
    const labelBudget = width - reserved;
    if (labelBudget < BASH_LABEL_MIN_WIDTH) {
      continue;
    }
    const shownLabel = truncateToWidth(label, labelBudget, "…");
    const gap = " ".repeat(
      Math.max(
        1,
        width - visibleWidth(prefixPlain) - visibleWidth(shownLabel) - visibleWidth(metaPlain),
      ),
    );
    const spinnerText = options.spinnerFrame ? theme.fg("warning", spinnerPrefix) : "";
    const metaText = metaPlain ? theme.fg("muted", metaPlain) : "";
    return `${spinnerText}${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", shownLabel)}${gap}${metaText}`;
  }

  const cleanedPrefix = options.spinnerFrame ? theme.fg("warning", spinnerPrefix) : "";
  const widthLeft = width - visibleWidth(prefixPlain);
  if (widthLeft < 1) {
    return truncateToWidth(
      `${cleanedPrefix}${theme.fg("toolTitle", theme.bold("bash"))}`,
      width,
      "",
    );
  }
  return `${cleanedPrefix}${theme.fg("toolTitle", theme.bold("bash"))} ${theme.fg("accent", truncateToWidth(label, widthLeft, "…"))}`;
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
