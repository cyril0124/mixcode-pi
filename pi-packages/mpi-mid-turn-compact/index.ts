/**
 * mpi-mid-turn-compact — auto-continue after length-truncated answers.
 *
 * Pi core compacts on threshold between tool execution and the next
 * assistant response (mid-run auto-compaction) but never restarts a turn
 * whose answer was cut off by the output token limit. This extension
 * resumes those turns:
 * - After a native automatic compact (threshold/overflow, willRetry=false)
 *   whose last assistant message stopped on "length", queue a resume so the
 *   agent finishes the truncated answer.
 * - After a run settles on a "length" stop near the context ceiling without
 *   any compact, queue the same resume.
 * - Tiny-output length stalls near the window switch to a tight prompt that
 *   asks for a final answer from the summary; repeated stalls stop
 *   auto-continue instead of looping.
 * - Resume is a hidden custom message (display: false → still user-role for
 *   the LLM; TUI shows no chat bubble).
 * Host-agnostic: works under plain Pi or any shell that loads this extension.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_COMPACTION_SETTINGS,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

export const RESUME_PROMPT =
  "Continue the same task after automatic context compaction. Use the compaction summary and recent messages; do not restart the whole task from scratch.";

/** Used when compact did not free enough room for another tool loop. */
export const TIGHT_RESUME_PROMPT =
  "Context is still near the limit after compaction. Using only the compaction summary and recent messages, produce the best final answer now. Do not read large files or run broad searches; prefer synthesizing what you already have.";

/** Custom message type: participates in LLM context, hidden in TUI (display: false). */
export const RESUME_CUSTOM_TYPE = "mpi-mid-turn-resume";

const DEFAULT_RESERVE_TOKENS = DEFAULT_COMPACTION_SETTINGS.reserveTokens;

/** Tiny length output near the ceiling ≈ no generation room left. */
const TINY_LENGTH_OUTPUT_TOKENS = 256;

export type AssistantUsageLike = {
  role?: string;
  usage?: {
    totalTokens?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
};

/**
 * When the configured reserve covers the whole window, scale like a
 * small-window session (10% reserve) instead of treating every context as
 * over-threshold. Absolute reserves that fit the window pass through.
 */
export function fitReserveToWindow(contextWindow: number, reserveTokens: number): number {
  if (!(contextWindow > 0)) return reserveTokens;
  const reserve = reserveTokens >= 0 ? reserveTokens : DEFAULT_RESERVE_TOKENS;
  if (reserve >= contextWindow) {
    return Math.max(1, Math.round(contextWindow * 0.1));
  }
  return reserve;
}

/**
 * Reserve tokens from global then project settings.json (absolute token
 * counts, project wins). ExtensionContext exposes no live SettingsManager;
 * this is the portable substitute.
 */
export function resolveReserveTokens(cwd: string, agentDir?: string): number {
  const globalDir =
    agentDir ??
    process.env.PI_CODING_AGENT_DIR ??
    path.join(process.env.HOME || os.homedir(), ".pi", "agent");
  const global = readReserveTokens(path.join(globalDir, "settings.json"));
  const project = readReserveTokens(path.join(cwd, ".pi", "settings.json"));
  return project ?? global ?? DEFAULT_RESERVE_TOKENS;
}

/** Whether a native compact without retry should auto-resume (length-truncated answer). */
export function shouldResumeAfterNativeCompact(options: {
  reason: string;
  willRetry: boolean;
  lastAssistantStopReason: string | undefined;
}): boolean {
  if (options.willRetry) return false;
  if (options.reason === "manual") return false;
  return options.lastAssistantStopReason === "length";
}

/** Length-stop with almost no output while near the ceiling → no generation room. */
export function isTinyLengthStall(
  outputTokens: number | undefined,
  totalTokens: number | undefined,
  contextWindow: number,
): boolean {
  if (!(contextWindow > 0)) return false;
  if (typeof outputTokens !== "number" || !(outputTokens >= 0)) return false;
  if (typeof totalTokens !== "number" || !(totalTokens > 0)) return false;
  if (outputTokens > TINY_LENGTH_OUTPUT_TOKENS) return false;
  return totalTokens >= contextWindow * 0.85;
}

function readReserveTokens(settingsPath: string): number | undefined {
  // Sync API callers; try/catch ENOENT instead of exists+read race.
  try {
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as {
      compaction?: { reserveTokens?: number };
    };
    const reserve = raw.compaction?.reserveTokens;
    if (typeof reserve === "number" && Number.isFinite(reserve) && reserve > 0) {
      return Math.round(reserve);
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Run after the current event dispatch stack unwinds. */
function scheduleDetached(task: () => void | Promise<void>): void {
  setImmediate(() => {
    void Promise.resolve().then(task);
  });
}

/**
 * Inject resume as a hidden custom message (display: false). Pi converts custom
 * messages to user role for the LLM; TUI does not show them as chat bubbles.
 */
function queueResume(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  prompt: string,
  notice: string,
): void {
  pi.sendMessage(
    {
      customType: RESUME_CUSTOM_TYPE,
      content: prompt,
      display: false,
    },
    { deliverAs: "followUp", triggerTurn: true },
  );
  if (ctx.hasUI) {
    ctx.ui.notify(notice, "info");
  }
}

export function createMidTurnCompactExtension(options?: {
  agentDir?: string;
  enabled?: boolean;
}): ExtensionFactory {
  const enabled =
    options?.enabled ??
    (process.env.MPI_MID_TURN_COMPACT === undefined || process.env.MPI_MID_TURN_COMPACT !== "0");

  return (pi: ExtensionAPI) => {
    let lastAssistantStopReason: string | undefined;
    let lastAssistantOutputTokens: number | undefined;
    let lastAssistantTotalTokens: number | undefined;
    let lengthResumePending = false;
    let consecutiveLengthResumes = 0;
    const MAX_LENGTH_RESUMES = 2;
    /** Once true, later resumes use the tight prompt (answer from summary). */
    let contextTight = false;

    // Track the last assistant stop for the resume decisions below.
    pi.on("message_end", (event) => {
      const message = event.message as AssistantUsageLike | undefined;
      if (message?.role === "assistant" && typeof message.stopReason === "string") {
        lastAssistantStopReason = message.stopReason;
        lastAssistantOutputTokens =
          typeof message.usage?.output === "number" ? message.usage.output : undefined;
        lastAssistantTotalTokens =
          typeof message.usage?.totalTokens === "number" ? message.usage.totalTokens : undefined;
        if (message.stopReason !== "length") consecutiveLengthResumes = 0;
      }
    });

    // Native automatic compact finished without retry: continue a truncated answer.
    pi.on("session_compact", (event, ctx) => {
      if (!enabled) return;
      if (
        !shouldResumeAfterNativeCompact({
          reason: event.reason,
          willRetry: event.willRetry,
          lastAssistantStopReason,
        })
      ) {
        return;
      }

      const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
      if (
        isTinyLengthStall(lastAssistantOutputTokens, lastAssistantTotalTokens, contextWindow) &&
        consecutiveLengthResumes >= 1
      ) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Stopped auto-continue: context stayed full after compact (model had almost no output room). Raise the context window or start a fresh turn.",
            "warning",
          );
        }
        contextTight = true;
        return;
      }

      if (consecutiveLengthResumes >= MAX_LENGTH_RESUMES) {
        if (ctx.hasUI) {
          ctx.ui.notify(
            "Stopped auto-continue after repeated length truncations near the context limit.",
            "warning",
          );
        }
        return;
      }
      lengthResumePending = true;
      consecutiveLengthResumes += 1;
      const tight = isTinyLengthStall(
        lastAssistantOutputTokens,
        lastAssistantTotalTokens,
        contextWindow,
      );
      if (tight) contextTight = true;
      scheduleDetached(() => {
        lengthResumePending = false;
        queueResume(
          pi,
          ctx,
          tight ? TIGHT_RESUME_PROMPT : RESUME_PROMPT,
          tight
            ? "Continued after compact (context still tight — answer from summary)."
            : "Continued after compact (answer was truncated).",
        );
      });
    });

    // Run settled on a length stop near the ceiling without a compact: continue it.
    pi.on("agent_settled", (_event, ctx) => {
      if (!enabled) return;
      if (lastAssistantStopReason !== "length") return;
      if (lengthResumePending) return;
      if (consecutiveLengthResumes >= MAX_LENGTH_RESUMES) return;

      const contextWindow = ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
      const tokens = ctx.getContextUsage()?.tokens ?? lastAssistantTotalTokens;
      if (!(contextWindow > 0) || typeof tokens !== "number" || !(tokens > 0)) return;
      const reserve = fitReserveToWindow(
        contextWindow,
        resolveReserveTokens(ctx.cwd, options?.agentDir),
      );
      if (tokens <= contextWindow - reserve * 1.5 && tokens <= contextWindow * 0.85) return;

      if (isTinyLengthStall(lastAssistantOutputTokens, lastAssistantTotalTokens, contextWindow)) {
        contextTight = true;
      }

      consecutiveLengthResumes += 1;
      scheduleDetached(() => {
        if (lastAssistantStopReason !== "length") return;
        queueResume(
          pi,
          ctx,
          contextTight ? TIGHT_RESUME_PROMPT : RESUME_PROMPT,
          "Continued after truncated response.",
        );
      });
    });
  };
}

const midTurnCompactExtension: ExtensionFactory = createMidTurnCompactExtension();

export default midTurnCompactExtension;
