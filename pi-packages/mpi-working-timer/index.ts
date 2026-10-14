import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import type {
  AgentSettledEvent,
  AgentStartEvent,
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
  MessageUpdateEvent,
  SessionEntry,
  SessionShutdownEvent,
  SessionStartEvent,
  SessionTreeEvent,
  ToolExecutionEndEvent,
  ToolExecutionStartEvent,
  TurnStartEvent,
} from "@earendil-works/pi-coding-agent";

/** Footer status key. Both hosts sort extension statuses by key. */
export const WORKING_TIMER_STATUS_KEY = "mpi-working-timer";

/** Active-run refresh cadence. Events already refresh during streaming; the
 *  interval keeps the seconds moving through long silent tool calls. */
const TICK_INTERVAL_MS = 1000;

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

/** Render an epoch timestamp as local `YYYY-MM-DD HH:MM:SS`. */
export function formatClockTime(finishedAtMs: number): string {
  const finishedAt = new Date(finishedAtMs);
  return `${finishedAt.getFullYear()}-${padTwoDigits(finishedAt.getMonth() + 1)}-${padTwoDigits(finishedAt.getDate())} ${padTwoDigits(finishedAt.getHours())}:${padTwoDigits(finishedAt.getMinutes())}:${padTwoDigits(finishedAt.getSeconds())}`;
}

/** Whether a message has visible content or a visible transcript container. */
function isVisibleMessage(message: AgentMessage, isMixCode: boolean): boolean {
  switch (message.role) {
    case "system":
      return false;
    case "custom":
      return message.display;
    case "user":
      if (typeof message.content === "string") return message.content.trim().length > 0;
      return message.content.some(
        (block) =>
          (isMixCode && block.type === "image") ||
          (block.type === "text" && block.text.trim().length > 0),
      );
    case "assistant": {
      const hasVisibleContent = message.content.some(
        (block) =>
          block.type === "toolCall" ||
          (block.type === "text" && block.text.trim().length > 0) ||
          (block.type === "thinking" &&
            ((isMixCode && block.redacted === true) || block.thinking.trim().length > 0)),
      );
      if (hasVisibleContent) return true;
      if (isMixCode) return false;

      // Pi restores failure/truncation notices even when the assistant has no content.
      return (
        message.stopReason === "error" ||
        message.stopReason === "aborted" ||
        message.stopReason === "length"
      );
    }
    case "toolResult":
    case "bashExecution":
    case "compactionSummary":
    case "branchSummary":
      return true;
    default:
      return false;
  }
}

/** Read the last visible message time in display order, without applying model-only context edits. */
function lastVisibleMessageTimestamp(
  entries: readonly SessionEntry[],
  isMixCode: boolean,
): number | undefined {
  let timestamp: number | undefined;
  const visibleToolCalls = new Set<string>();
  for (const entry of entries) {
    for (const message of sessionEntryToContextMessages(entry)) {
      if (
        message.role === "assistant" &&
        (isMixCode || (message.stopReason !== "aborted" && message.stopReason !== "error"))
      ) {
        for (const block of message.content) {
          if (block.type === "toolCall") visibleToolCalls.add(block.id);
        }
      }
      // Pi consumes a pending call once; MixCode keeps the row available for later result updates.
      if (message.role === "toolResult") {
        if (!visibleToolCalls.has(message.toolCallId)) continue;
        if (!isMixCode) visibleToolCalls.delete(message.toolCallId);
      }
      if (!isVisibleMessage(message, isMixCode) || !Number.isFinite(message.timestamp)) continue;
      timestamp = message.timestamp;
    }
  }
  return timestamp;
}

interface WorkingTimerState {
  /** Epoch ms the current run started, absent when no run is in flight. */
  workingSince?: number;
  /** Epoch ms the last streaming activity occurred in the current run (message_update, tool events). */
  lastActivityAt?: number;
  /** Last completed run or restored visible message, absent when neither exists. */
  settled?: {
    /** Wall-clock run duration, unavailable when restoring message history. */
    durationMs?: number;
    /** Epoch ms the run settled, or the restored visible message's own timestamp. */
    finishedAtMs: number;
  };
}

/** Return the status text, or undefined to clear the footer entry. */
function workingTimerText(state: WorkingTimerState, now: number): string | undefined {
  const { workingSince, lastActivityAt, settled } = state;
  if (workingSince !== undefined) {
    const elapsed = `⏱ ${formatElapsed(now - workingSince)}`;
    if (lastActivityAt !== undefined) {
      return `${elapsed} · ${formatElapsed(now - lastActivityAt)} idle`;
    }
    return elapsed;
  }
  if (settled === undefined) return undefined;
  const duration = settled.durationMs === undefined ? "" : ` ${formatElapsed(settled.durationMs)}`;
  return `✔ done${duration} at ${formatClockTime(settled.finishedAtMs)}`;
}

const extension: ExtensionFactory = (pi: ExtensionAPI) => {
  const hostFlag = process.env.MIXCODE?.trim().toLowerCase();
  const isMixCode = Boolean(
    hostFlag && hostFlag !== "0" && hostFlag !== "false" && hostFlag !== "off",
  );
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
    // Cosmetic status updates must not keep the process alive.
    ticker.unref?.();
  };

  /** Drop the run in flight and the last settled run together. */
  const resetState = (): void => {
    state.workingSince = undefined;
    state.lastActivityAt = undefined;
    state.settled = undefined;
  };

  /** Restore the visible message time with no measured duration or active ticker. */
  const restoreState = (ctx: ExtensionContext): void => {
    stopTicker();
    resetState();
    // Context edits affect model input, so restore from each host's unedited display history.
    const entries = isMixCode
      ? ctx.sessionManager.getBranch()
      : ctx.sessionManager.buildContextEntries();
    const finishedAtMs = lastVisibleMessageTimestamp(entries, isMixCode);
    if (finishedAtMs !== undefined) state.settled = { finishedAtMs };
    render(ctx);
  };

  pi.on("session_start", (_event: SessionStartEvent, ctx) => restoreState(ctx));
  pi.on("session_tree", (_event: SessionTreeEvent, ctx) => restoreState(ctx));

  pi.on("agent_start", (_event: AgentStartEvent, ctx) => {
    // Retry, compaction, and queued continuations share one clock until agent_settled.
    state.workingSince ??= Date.now();
    state.lastActivityAt = Date.now();
    state.settled = undefined;
    render(ctx);
    startTicker(ctx);
  });

  /** Mark activity and re-render; no-op when no run is in flight. */
  const recordActivity = (ctx: ExtensionContext): void => {
    if (state.workingSince === undefined) return;
    state.lastActivityAt = Date.now();
    render(ctx);
  };

  pi.on("turn_start", (_event: TurnStartEvent, ctx) => recordActivity(ctx));
  pi.on("message_update", (_event: MessageUpdateEvent, ctx) => recordActivity(ctx));
  pi.on("tool_execution_start", (_event: ToolExecutionStartEvent, ctx) => recordActivity(ctx));
  pi.on("tool_execution_end", (_event: ToolExecutionEndEvent, ctx) => recordActivity(ctx));

  pi.on("agent_settled", (_event: AgentSettledEvent, ctx) => {
    stopTicker();
    if (state.workingSince !== undefined) {
      const finishedAtMs = Date.now();
      state.settled = { durationMs: Math.max(0, finishedAtMs - state.workingSince), finishedAtMs };
      state.workingSince = undefined;
      state.lastActivityAt = undefined;
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
