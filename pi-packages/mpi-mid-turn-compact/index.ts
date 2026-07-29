/**
 * mpi-mid-turn-compact — compact mid tool-loop when context nears the window.
 *
 * Policy:
 * - Trigger only on a complete assistant + tool_result batch (`context` event).
 * - Threshold from disk/settings reserve (fitted when reserve ≥ window).
 * - Precheck prepareCompaction with disk keep (not fitted): abort only when
 *   preparation is non-empty. Empty prep → suppress mid-turn, do not abort.
 * - Loader failure (prepare unavailable): still attempt compact (no silent disable).
 * - Compact race empty prep: benign resume via EMPTY_COMPACT_RESUME_PROMPT.
 * - Compact is never awaited inside the context handler (waitForIdle deadlock).
 * - Resume via hidden custom message (display: false → still user-role for the LLM).
 * No custom ledger synthesis and no slash-command UI.
 * Host-agnostic: works under plain Pi or any shell that loads this extension.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  calculateContextTokens,
  estimateTokens,
  shouldCompact,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Usage } from "@earendil-works/pi-ai";

export const RESUME_PROMPT =
  "Continue the same task after automatic context compaction. Use the compaction summary and recent messages; do not restart the whole task from scratch.";

/** Used when compact did not free enough room for another tool loop. */
export const TIGHT_RESUME_PROMPT =
  "Context is still near the limit after compaction. Using only the compaction summary and recent messages, produce the best final answer now. Do not read large files or run broad searches; prefer synthesizing what you already have.";

/** Used when compact reported nothing to remove (no summary was produced). */
export const EMPTY_COMPACT_RESUME_PROMPT =
  "Automatic compaction found nothing to remove. Continue the same task from the recent messages; do not restart from scratch.";

/** Custom message type: participates in LLM context, hidden in TUI (display: false). */
export const RESUME_CUSTOM_TYPE = "mpi-mid-turn-resume";

/** Mirrors Pi core DEFAULT_COMPACTION_SETTINGS (absolute token counts). */
const DEFAULT_RESERVE_TOKENS = 16_384;
const DEFAULT_KEEP_RECENT_TOKENS = 20_000;

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
};

export type ToolResultLike = {
  role?: string;
  toolCallId?: string;
  content?: unknown;
};

export type CompactResultLike = {
  estimatedTokensAfter?: number;
  tokensBefore?: number;
};

export type CompactionBudgets = {
  enabled: boolean;
  reserveTokens: number;
  keepRecentTokens: number;
};

type PrepareCompactionFn = (
  pathEntries: unknown[],
  settings: CompactionBudgets,
) => { messagesToSummarize?: unknown[]; turnPrefixMessages?: unknown[] } | undefined | null;

/** True when messages end with a complete assistant tool-call batch + matching results. */
export function endsWithCompleteToolResultBatch(messages: readonly unknown[]): boolean {
  if (messages.length === 0) return false;
  let i = messages.length - 1;
  const resultIds: string[] = [];
  while (i >= 0 && isToolResult(messages[i])) {
    const id = (messages[i] as ToolResultLike).toolCallId;
    if (typeof id !== "string" || !id) return false;
    resultIds.push(id);
    i -= 1;
  }
  if (resultIds.length === 0) return false;
  const assistant = messages[i];
  if (!isAssistant(assistant)) return false;
  const callIds = assistantToolCallIds(assistant);
  if (callIds.length === 0 || callIds.length !== resultIds.length) return false;
  const remaining = new Set(resultIds);
  for (const id of callIds) {
    if (!remaining.delete(id)) return false;
  }
  return remaining.size === 0;
}

/** Skip aborted/error/zero-usage assistants (same validity rules as Pi usage scan). */
function isValidAssistantUsage(message: AssistantUsageLike): boolean {
  if (message.stopReason === "aborted" || message.stopReason === "error") return false;
  if (!message.usage) return false;
  return calculateContextTokens(message.usage as Usage) > 0;
}

function safeEstimateTokens(message: unknown): number {
  try {
    const n = estimateTokens(message as AgentMessage);
    return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function lastAssistantUsageTokens(messages: readonly unknown[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!isAssistant(msg) || !isValidAssistantUsage(msg)) continue;
    const tokens = calculateContextTokens(msg.usage as Usage);
    return tokens > 0 ? tokens : undefined;
  }
  return undefined;
}

export type ContextUsageEstimate = {
  tokens: number;
  usageTokens: number;
  trailingTokens: number;
  lastUsageIndex: number | null;
};

/**
 * Message-based context estimate matching Pi core estimateContextTokens:
 * last valid assistant usage + estimateTokens for every trailing message.
 */
export function estimateContextTokensFromMessages(
  messages: readonly unknown[],
): ContextUsageEstimate {
  let lastUsageIndex: number | null = null;
  let usageTokens = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (!isAssistant(msg) || !isValidAssistantUsage(msg)) continue;
    usageTokens = calculateContextTokens(msg.usage as Usage);
    lastUsageIndex = i;
    break;
  }
  if (lastUsageIndex === null) {
    let estimated = 0;
    for (const message of messages) estimated += safeEstimateTokens(message);
    return {
      tokens: estimated,
      usageTokens: 0,
      trailingTokens: estimated,
      lastUsageIndex: null,
    };
  }
  let trailingTokens = 0;
  for (let i = lastUsageIndex + 1; i < messages.length; i += 1) {
    trailingTokens += safeEstimateTokens(messages[i]);
  }
  return {
    tokens: usageTokens + trailingTokens,
    usageTokens,
    trailingTokens,
    lastUsageIndex,
  };
}

/** Total tokens for threshold checks (Pi estimateContextTokens.tokens). */
export function estimateTokensForNextCall(messages: readonly unknown[]): number | undefined {
  const tokens = estimateContextTokensFromMessages(messages).tokens;
  return tokens > 0 ? tokens : undefined;
}

/**
 * When disk/default reserve covers the whole window, scale like a small-window
 * session (10% reserve / 25% keep). Leaves absolute budgets alone when they fit.
 * ExtensionContext has no live SettingsManager; this is the portable substitute
 * so mid-turn does not hard-disable on small contextWindow values.
 */
export function fitCompactionBudgetsToWindow(
  budgets: CompactionBudgets,
  contextWindow: number,
): CompactionBudgets {
  if (!(contextWindow > 0)) return budgets;
  let reserveTokens = budgets.reserveTokens;
  let keepRecentTokens = budgets.keepRecentTokens;
  if (!(reserveTokens >= 0)) reserveTokens = DEFAULT_RESERVE_TOKENS;
  if (!(keepRecentTokens >= 0)) keepRecentTokens = DEFAULT_KEEP_RECENT_TOKENS;
  if (reserveTokens >= contextWindow) {
    reserveTokens = Math.max(1, Math.round(contextWindow * 0.1));
  }
  if (keepRecentTokens >= contextWindow) {
    keepRecentTokens = Math.max(1, Math.round(contextWindow * 0.25));
  }
  if (
    reserveTokens === budgets.reserveTokens &&
    keepRecentTokens === budgets.keepRecentTokens
  ) {
    return budgets;
  }
  return { ...budgets, reserveTokens, keepRecentTokens };
}

/** Fit a single reserve value the same way as fitCompactionBudgetsToWindow. */
export function fitReserveToWindow(contextWindow: number, reserveTokens: number): number {
  return fitCompactionBudgetsToWindow(
    {
      enabled: true,
      reserveTokens,
      keepRecentTokens: 0,
    },
    contextWindow,
  ).reserveTokens;
}

/**
 * Pi compaction threshold after fitting reserve to the window:
 *   fire when: tokens > contextWindow - effectiveReserve
 */
export function shouldCompactForWindow(
  tokens: number,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  if (!(tokens > 0) || !(contextWindow > 0) || !(reserveTokens >= 0)) return false;
  const reserve = fitReserveToWindow(contextWindow, reserveTokens);
  return shouldCompact(tokens, contextWindow, {
    enabled: true,
    reserveTokens: reserve,
    keepRecentTokens: 0,
  });
}

/**
 * Compaction settings from global then project settings.json (absolute token counts).
 * Threshold uses reserve (after fit-to-window). Precheck uses disk keep as-is;
 * ctx.compact() may still apply live SettingsManager overrides.
 */
export function resolveCompactionBudgets(cwd: string, agentDir?: string): CompactionBudgets {
  const globalDir =
    agentDir ??
    process.env.MIXCODE_CODING_AGENT_DIR ??
    process.env.PI_CODING_AGENT_DIR ??
    join(homedir(), ".pi", "agent");
  const global = readCompactionSettings(join(globalDir, "settings.json"));
  const project = readCompactionSettings(join(cwd, ".pi", "settings.json"));
  return {
    enabled: project.enabled ?? global.enabled ?? true,
    reserveTokens: project.reserveTokens ?? global.reserveTokens ?? DEFAULT_RESERVE_TOKENS,
    keepRecentTokens: project.keepRecentTokens ?? global.keepRecentTokens ?? DEFAULT_KEEP_RECENT_TOKENS,
  };
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

/** True when compact left too little free room for another full tool loop. */
export function stillOverThresholdAfterCompact(
  estimatedTokensAfter: number | undefined,
  contextWindow: number,
  reserveTokens: number,
): boolean {
  if (estimatedTokensAfter === undefined) return false;
  return shouldCompactForWindow(estimatedTokensAfter, contextWindow, reserveTokens);
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

/** Stable key for "over threshold but nothing to compact" (dedupe notify / suppress). */
export function buildNoCompactableGuardKey(input: {
  contextWindow: number;
  reserveTokens: number;
  keepRecentTokens: number;
}): string {
  return [input.contextWindow, input.reserveTokens, input.keepRecentTokens].join(":");
}

/**
 * Whether Pi preparation has anything to summarize (native compact can shrink history).
 * Empty messagesToSummarize + empty turnPrefixMessages → not compactable; skip mid-turn.
 * Call with disk keep (not fitted) so the gate matches Pi prepareCompaction defaults.
 */
export function isBranchCompactable(
  branchEntries: unknown[],
  budgets: CompactionBudgets,
  prepare: PrepareCompactionFn,
): boolean {
  if (!budgets.enabled) return false;
  if (!Array.isArray(branchEntries) || branchEntries.length === 0) return false;
  const prep = prepare(branchEntries, {
    enabled: budgets.enabled,
    reserveTokens: budgets.reserveTokens,
    keepRecentTokens: budgets.keepRecentTokens,
  });
  if (!prep) return false;
  const summarize = prep.messagesToSummarize?.length ?? 0;
  const prefix = prep.turnPrefixMessages?.length ?? 0;
  return summarize > 0 || prefix > 0;
}

function readCompactionSettings(path: string): Partial<CompactionBudgets> {
  if (!existsSync(path)) return {};
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      compaction?: {
        enabled?: boolean;
        reserveTokens?: number;
        keepRecentTokens?: number;
      };
    };
    const c = raw.compaction;
    if (!c || typeof c !== "object") return {};
    const out: Partial<CompactionBudgets> = {};
    if (typeof c.enabled === "boolean") out.enabled = c.enabled;
    if (typeof c.reserveTokens === "number" && Number.isFinite(c.reserveTokens) && c.reserveTokens > 0) {
      out.reserveTokens = Math.round(c.reserveTokens);
    }
    if (
      typeof c.keepRecentTokens === "number" &&
      Number.isFinite(c.keepRecentTokens) &&
      c.keepRecentTokens > 0
    ) {
      out.keepRecentTokens = Math.round(c.keepRecentTokens);
    }
    return out;
  } catch {
    return {};
  }
}

function isAssistant(message: unknown): message is AssistantUsageLike {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as AssistantUsageLike).role === "assistant"
  );
}

function isToolResult(message: unknown): message is ToolResultLike {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as ToolResultLike).role === "toolResult"
  );
}

function assistantToolCallIds(message: AssistantUsageLike): string[] {
  if (!Array.isArray(message.content)) return [];
  const ids: string[] = [];
  for (const block of message.content) {
    if (
      typeof block === "object" &&
      block !== null &&
      (block as { type?: string }).type === "toolCall" &&
      typeof (block as { id?: string }).id === "string"
    ) {
      ids.push((block as { id: string }).id);
    }
  }
  return ids;
}

/** Run after the current emitContext stack unwinds (avoids waitForIdle deadlock). */
function scheduleDetached(task: () => void | Promise<void>): void {
  setImmediate(() => {
    void Promise.resolve().then(task);
  });
}

function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (error instanceof Error) {
    if (error.name === "AbortError") return true;
    if (/cancel|aborted/i.test(error.message)) return true;
  }
  return false;
}

function isBenignCompactError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /nothing to compact|already compacted|session too small/i.test(message);
}

/**
 * Inject resume as a hidden custom message (display: false). Pi converts custom
 * messages to user role for the LLM; TUI does not show them as chat bubbles.
 */
function queueResume(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, notice: string): void {
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

let prepareCompactionLoader: Promise<PrepareCompactionFn | null> | undefined;

/**
 * Load Pi's prepareCompaction from package dist (not on the public export surface).
 * Resolve via the package entry (`import.meta.resolve`), not `package.json` —
 * `@earendil-works/pi-coding-agent` exports only `.` and `./rpc-entry`, so
 * `require.resolve(.../package.json)` throws ERR_PACKAGE_PATH_NOT_EXPORTED.
 */
export async function loadPrepareCompaction(): Promise<PrepareCompactionFn | null> {
  if (!prepareCompactionLoader) {
    prepareCompactionLoader = (async () => {
      try {
        const entry = import.meta.resolve("@earendil-works/pi-coding-agent");
        const href = pathToFileURL(
          join(dirname(fileURLToPath(entry)), "core/compaction/compaction.js"),
        ).href;
        const mod = (await import(href)) as { prepareCompaction?: PrepareCompactionFn };
        return typeof mod.prepareCompaction === "function" ? mod.prepareCompaction : null;
      } catch {
        return null;
      }
    })();
  }
  return prepareCompactionLoader;
}

/** Test helper: reset prepareCompaction cache. */
export function resetPrepareCompactionLoaderForTests(): void {
  prepareCompactionLoader = undefined;
}

export function createMidTurnCompactExtension(options?: {
  agentDir?: string;
  enabled?: boolean;
  /** Inject prepareCompaction for tests. */
  prepareCompaction?: PrepareCompactionFn | null;
}): ExtensionFactory {
  const enabled =
    options?.enabled ??
    (process.env.MPI_MID_TURN_COMPACT === undefined || process.env.MPI_MID_TURN_COMPACT !== "0");

  return (pi: ExtensionAPI) => {
    let inFlight = false;
    let lastAssistantStopReason: string | undefined;
    let lastAssistantOutputTokens: number | undefined;
    let lastAssistantTotalTokens: number | undefined;
    let lengthResumePending = false;
    let consecutiveLengthResumes = 0;
    const MAX_LENGTH_RESUMES = 2;
    let midTurnSuppressed = false;
    let lastNoCompactableKey: string | undefined;

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

    // May await prepareCompaction load only — never await compact/waitForIdle here.
    pi.on("context", async (event, ctx) => {
      if (!enabled || inFlight) return;
      if (!endsWithCompleteToolResultBatch(event.messages)) return;

      // Threshold from message estimate (Pi estimateContextTokens), not UI usage alone.
      const tokens = estimateTokensForNextCall(event.messages);
      if (tokens === undefined) return;

      const contextWindow =
        ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
      if (!(contextWindow > 0)) return;

      const diskBudgets = resolveCompactionBudgets(ctx.cwd, options?.agentDir);
      if (!diskBudgets.enabled) return;
      // Fit only for fire threshold; prepare precheck uses disk keep (matches Pi defaults).
      const budgets = fitCompactionBudgetsToWindow(diskBudgets, contextWindow);
      const over = shouldCompactForWindow(tokens, contextWindow, budgets.reserveTokens);

      if (midTurnSuppressed) {
        if (!over) {
          midTurnSuppressed = false;
          lastNoCompactableKey = undefined;
        } else {
          return;
        }
      }
      if (!over) return;

      const prepare =
        options?.prepareCompaction !== undefined
          ? options.prepareCompaction
          : await loadPrepareCompaction();

      // Precheck when available. Loader failure is not "nothing to compact" — still attempt.
      // Disk keep only: fitted keep can look compactable while Pi compact uses disk keep.
      if (prepare) {
        let branch: unknown[] = [];
        try {
          branch = ctx.sessionManager.getBranch() as unknown[];
        } catch {
          branch = [];
        }
        const compactable = isBranchCompactable(branch, diskBudgets, prepare);
        if (!compactable) {
          midTurnSuppressed = true;
          const key = buildNoCompactableGuardKey({
            contextWindow,
            reserveTokens: diskBudgets.reserveTokens,
            keepRecentTokens: diskBudgets.keepRecentTokens,
          });
          if (lastNoCompactableKey !== key && ctx.hasUI) {
            lastNoCompactableKey = key;
            ctx.ui.notify(
              "Mid-turn skipped: Pi has no compactable session history yet; over-threshold context is still within the recent keep window or static overhead.",
              "warning",
            );
          }
          return;
        }
      }

      inFlight = true;
      if (ctx.hasUI) {
        ctx.ui.notify("Compacting context (mid-turn)…", "info");
      }
      ctx.abort();
      // One compact only: Pi retries summarization inside compact(); outer delay
      // loops open an idle gap where queued turns can race.
      scheduleDetached(() =>
        runCompactCycle(pi, ctx, {
          contextWindow,
          reserve: budgets.reserveTokens,
          onStillTight: () => {
            midTurnSuppressed = true;
          },
          onFreed: () => {
            midTurnSuppressed = false;
            lastNoCompactableKey = undefined;
          },
        }).finally(() => {
          inFlight = false;
        }),
      );
    });

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

      const contextWindow =
        ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
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
        midTurnSuppressed = true;
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
      if (tight) midTurnSuppressed = true;
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

    pi.on("agent_settled", (_event, ctx) => {
      if (!enabled || inFlight) return;
      if (lastAssistantStopReason !== "length") return;
      if (lengthResumePending) return;
      if (consecutiveLengthResumes >= MAX_LENGTH_RESUMES) return;

      const contextWindow =
        ctx.model?.contextWindow ?? ctx.getContextUsage()?.contextWindow ?? 0;
      const tokens = ctx.getContextUsage()?.tokens ?? lastAssistantTotalTokens;
      if (!(contextWindow > 0) || typeof tokens !== "number" || !(tokens > 0)) return;
      const reserve = fitReserveToWindow(
        contextWindow,
        resolveCompactionBudgets(ctx.cwd, options?.agentDir).reserveTokens,
      );
      if (tokens <= contextWindow - reserve * 1.5 && tokens <= contextWindow * 0.85) return;

      if (isTinyLengthStall(lastAssistantOutputTokens, lastAssistantTotalTokens, contextWindow)) {
        midTurnSuppressed = true;
      }

      consecutiveLengthResumes += 1;
      scheduleDetached(() => {
        if (lastAssistantStopReason !== "length") return;
        queueResume(
          pi,
          ctx,
          midTurnSuppressed ? TIGHT_RESUME_PROMPT : RESUME_PROMPT,
          "Continued after truncated response.",
        );
      });
    });
  };
}

async function runCompactCycle(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  opts: {
    contextWindow: number;
    reserve: number;
    onStillTight: () => void;
    onFreed: () => void;
  },
): Promise<void> {
  ctx.abort();

  try {
    const result = await compactOnce(ctx);
    if (
      stillOverThresholdAfterCompact(
        result?.estimatedTokensAfter,
        opts.contextWindow,
        opts.reserve,
      )
    ) {
      opts.onStillTight();
      queueResume(
        pi,
        ctx,
        TIGHT_RESUME_PROMPT,
        "Mid-turn compact done but context still tight; answering from summary (mid-turn paused).",
      );
      return;
    }
    opts.onFreed();
    queueResume(pi, ctx, RESUME_PROMPT, "Mid-turn compact finished; continuing.");
  } catch (error) {
    if (isAbortError(error)) return;
    // Race: preparation became empty after abort. Resume + suppress (do not leave aborted turn).
    if (isBenignCompactError(error)) {
      opts.onStillTight();
      queueResume(
        pi,
        ctx,
        EMPTY_COMPACT_RESUME_PROMPT,
        "Nothing left to compact; continuing from current context (mid-turn paused).",
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error ?? "compact failed");
    if (ctx.hasUI) {
      ctx.ui.notify(`Mid-turn compact failed: ${message}`, "error");
    }
  }
}

function compactOnce(ctx: ExtensionContext): Promise<CompactResultLike | undefined> {
  return new Promise((resolve, reject) => {
    ctx.compact({
      onComplete: (result) => resolve(result as CompactResultLike | undefined),
      onError: (error) => reject(error),
    });
  });
}

const midTurnCompactExtension: ExtensionFactory = createMidTurnCompactExtension();

export default midTurnCompactExtension;
