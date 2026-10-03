/**
 * Footer entry with the duration of the current agent run:
 *
 *   running  `⏱ 12s`
 *   settled  `✔ done 12s at 2026-10-03 15:39:00`
 *
 * `setStatus` adds this entry beside sibling extensions' entries, so Pi's retry
 * and compaction indicators and any `setWorkingMessage` text keep their own
 * display. A run ends at `agent_settled` rather than `agent_end`, because retry,
 * recovery, compaction, and queued continuations can continue after `agent_end`,
 * and their time belongs to the same run.
 */

import type {
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  MessageUpdateEvent,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

/** Footer status key. Both hosts sort extension statuses by key. */
export const WORKING_TIMER_STATUS_KEY = "mpi-working-timer";

/** Active-run refresh cadence. Events already refresh during streaming; the
 *  interval keeps the seconds moving through long silent tool calls. */
const TICK_INTERVAL_MS = 1000;

/** Zero-pad a clock or duration field to two digits. */
function padTwoDigits(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Render a duration as `7s` / `2m 05s` / `1h 02m 03s`. Sub-second remainders are
 * floored, so the label never rounds up past the real elapsed time.
 */
export function formatElapsed(elapsedMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${padTwoDigits(minutes)}m ${padTwoDigits(seconds)}s`;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${padTwoDigits(seconds)}s`;
}

/** Render the moment a run settled as local `YYYY-MM-DD HH:MM:SS`. */
export function formatClockTime(finishedAtMs: number): string {
  const finishedAt = new Date(finishedAtMs);
  return `${finishedAt.getFullYear()}-${padTwoDigits(finishedAt.getMonth() + 1)}-${padTwoDigits(finishedAt.getDate())} ${padTwoDigits(finishedAt.getHours())}:${padTwoDigits(finishedAt.getMinutes())}:${padTwoDigits(finishedAt.getSeconds())}`;
}

/** Timer state published to the footer. */
interface WorkingTimerState {
  /** Epoch ms the current run started, absent when no run is in flight. */
  workingSince?: number;
  /** Last settled run, absent until one settles. */
  settled?: {
    /** Wall-clock duration of the run. */
    durationMs: number;
    /** Epoch ms the run settled. */
    finishedAtMs: number;
  };
}

/**
 * Status text for the current timer state, or undefined when there is nothing
 * to show (callers pass undefined through to clear the footer entry).
 */
function workingTimerText(state: WorkingTimerState, now: number): string | undefined {
  const { workingSince, settled } = state;
  if (workingSince !== undefined) return `⏱ ${formatElapsed(now - workingSince)}`;
  if (settled === undefined) return undefined;
  return `✔ done ${formatElapsed(settled.durationMs)} at ${formatClockTime(settled.finishedAtMs)}`;
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  const state: WorkingTimerState = {};
  let ticker: ReturnType<typeof setInterval> | undefined;

  const stopTicker = (): void => {
    if (ticker === undefined) return;
    clearInterval(ticker);
    ticker = undefined;
  };

  const render = (ctx: ExtensionContext): void => {
    ctx.ui.setStatus(WORKING_TIMER_STATUS_KEY, workingTimerText(state, Date.now()));
  };

  const startTicker = (ctx: ExtensionContext): void => {
    stopTicker();
    ticker = setInterval(() => render(ctx), TICK_INTERVAL_MS);
    // Never keep a Pi process alive for a cosmetic footer entry.
    ticker.unref?.();
  };

  /** Refresh without starting anything: only an in-flight run has a timer. */
  const refreshIfWorking = (ctx: ExtensionContext): void => {
    if (state.workingSince === undefined) return;
    render(ctx);
  };

  /** Drop the run in flight and the last settled run together. */
  const resetState = (): void => {
    state.workingSince = undefined;
    state.settled = undefined;
  };

  pi.on("session_start", (_event: SessionStartEvent, ctx) => {
    // A fresh or restored session starts with no run in flight.
    stopTicker();
    resetState();
    render(ctx);
  });

  pi.on("agent_start", (_event: AgentStartEvent, ctx) => {
    // ??= keeps the clock across the agent loops that belong to one run
    // (auto-retry, compaction, queued continuation); only agent_settled ends a run.
    state.workingSince ??= Date.now();
    state.settled = undefined;
    render(ctx);
    startTicker(ctx);
  });

  pi.on("turn_start", (_event: TurnStartEvent, ctx) => refreshIfWorking(ctx));
  pi.on("message_update", (_event: MessageUpdateEvent, ctx) => refreshIfWorking(ctx));
  pi.on("tool_execution_start", (_event: ToolExecutionStartEvent, ctx) => refreshIfWorking(ctx));
  pi.on("tool_execution_end", (_event: ToolExecutionEndEvent, ctx) => refreshIfWorking(ctx));

  pi.on("agent_settled", (_event: AgentSettledEvent, ctx) => {
    stopTicker();
    if (state.workingSince !== undefined) {
      const finishedAtMs = Date.now();
      state.settled = { durationMs: Math.max(0, finishedAtMs - state.workingSince), finishedAtMs };
      state.workingSince = undefined;
    }
    render(ctx);
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent, ctx) => {
    stopTicker();
    resetState();
    ctx.ui.setStatus(WORKING_TIMER_STATUS_KEY, undefined);
  });
};

export default extension;
