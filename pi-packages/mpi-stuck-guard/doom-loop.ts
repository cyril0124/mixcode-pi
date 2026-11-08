import {
  isReadToolResult,
  type ExtensionAPI,
  type ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import { CycleDetection } from "./cycle-detection.js";
import { ReadProgress, normalizeReadPath } from "./read-progress.js";
import {
  DEFAULT_STUCK_GUARD_CONFIG,
  type DoomLoopConfig,
  type StuckGuardConfigLoad,
} from "./config.js";

const REPEAT_THRESHOLD = 3;
const SIMILARITY_THRESHOLD = 0.85;
const SIMILAR_COUNT_LIMIT = 64;
const STOP_AFTER_BLOCKS = 3;

/** Canonicalize JSON object keys recursively, preserving array order and literal strings. */
function canonicalizeArgs(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalizeArgs).join(",")}]`;
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalizeArgs(record[key])}`);
  return `{${entries.join(",")}}`;
}

/** Count adjacent character pairs, including multiplicity, in canonical argument JSON. */
function bigramCounts(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (let index = 0; index < text.length - 1; index++) {
    const pair = text.slice(index, index + 2);
    counts.set(pair, (counts.get(pair) ?? 0) + 1);
  }
  return counts;
}

/** Compare one adjacent pair; the rolling window reuses this score on later calls. */
function adjacentSimilarity(
  previous: string,
  current: string,
  previousBigrams: ReadonlyMap<string, number>,
  currentBigrams: ReadonlyMap<string, number>,
): number {
  let sharedBigramCount = 0;
  for (const [pair, count] of previousBigrams) {
    sharedBigramCount += Math.min(count, currentBigrams.get(pair) ?? 0);
  }
  const combinedBigramCount = previous.length + current.length - 2;
  return combinedBigramCount === 0 ? 1 : (2 * sharedBigramCount) / combinedBigramCount;
}

/**
 * Protect tool calls across user turns within a session. Similar and cyclic calls only warn;
 * 3 consecutive identical-call vetoes request batch termination.
 * Session changes, action changes and threshold changes reset all counters.
 * Invalid configuration blocks calls until the next successful reload.
 */
export function wireDoomLoop(pi: ExtensionAPI): (loaded: StuckGuardConfigLoad) => void {
  let config: DoomLoopConfig = DEFAULT_STUCK_GUARD_CONFIG.doomLoop;
  let similarThreshold = DEFAULT_STUCK_GUARD_CONFIG.similarCallThreshold;
  let configError: string | undefined;
  let lastTool: string | undefined;
  let lastInput: string | undefined;
  let identicalCount = 0;
  let inputs: string[] = [];
  let previousBigrams: Map<string, number> | undefined;
  let adjacentScores: number[] = [];
  let targets: (string | undefined)[] = [];
  let similarCount = 0;
  let lastNoticeCount = 0;
  let blockedCount = 0;
  const cycles = new CycleDetection();
  const readProgress = new ReadProgress();
  let similarGeneration = 0;
  const pendingReads = new Map<string, { generation: number; cycleNotified: boolean }>();

  function resetSimilarity(): void {
    inputs = [];
    previousBigrams = undefined;
    adjacentScores = [];
    targets = [];
    similarCount = 0;
    lastNoticeCount = 0;
  }

  function resetAdvisories(): void {
    resetSimilarity();
    similarGeneration++;
    cycles.reset();
    readProgress.reset();
    pendingReads.clear();
  }

  function reset(): void {
    lastTool = undefined;
    lastInput = undefined;
    identicalCount = 0;
    blockedCount = 0;
    resetAdvisories();
  }

  function observeSimilarity(
    tool: string,
    input: string,
    target?: string,
    suppressNotice = false,
  ): void {
    const previous = inputs.at(-1);
    if (previous !== undefined) {
      const currentBigrams = bigramCounts(input);
      adjacentScores.push(
        adjacentSimilarity(
          previous,
          input,
          previousBigrams ?? bigramCounts(previous),
          currentBigrams,
        ),
      );
      previousBigrams = currentBigrams;
    }
    inputs.push(input);
    targets.push(target);
    if (inputs.length > similarThreshold) {
      inputs.shift();
      targets.shift();
      adjacentScores.shift();
    }

    const distinctTargets =
      targets.every((target) => target !== undefined) && new Set(targets).size === targets.length;
    const similarity =
      inputs.length >= similarThreshold
        ? adjacentScores.reduce((sum, score) => sum + score, 0) / adjacentScores.length
        : 0;
    if (!distinctTargets && similarity >= SIMILARITY_THRESHOLD) {
      similarCount =
        similarCount === 0 ? similarThreshold : Math.min(SIMILAR_COUNT_LIMIT, similarCount + 1);
    } else {
      similarCount = 0;
      lastNoticeCount = 0;
    }
    const shouldWarn =
      similarCount > 0 &&
      (lastNoticeCount === 0 ||
        similarCount >= lastNoticeCount * 2 ||
        (similarCount === SIMILAR_COUNT_LIMIT && lastNoticeCount < SIMILAR_COUNT_LIMIT));
    if (shouldWarn && !suppressNotice) {
      lastNoticeCount = similarCount;
      pi.sendMessage(
        {
          customType: "stuck-guard-similar-loop",
          content:
            `stuck-guard: ${tool} repeated with near-identical arguments ` +
            `(${similarCount} calls, ${Math.round(similarity * 100)}% similarity). ` +
            "Check whether these calls produce new evidence. Reuse existing results or change strategy if they do not. " +
            "This is an advisory reminder; different arguments remain allowed.",
          display: true,
        },
        { triggerTurn: false, deliverAs: "steer" },
      );
    }
  }

  pi.on("session_start", reset);
  pi.on("session_shutdown", reset);
  pi.on("input", (event) => {
    if (event.source !== "extension") resetAdvisories();
  });
  pi.on("tool_result", (event, ctx) => {
    if (!isReadToolResult(event)) return;
    const pending = pendingReads.get(event.toolCallId);
    pendingReads.delete(event.toolCallId);
    if (!pending || configError !== undefined || config.action === "allow") return;
    const progressed = readProgress.record(event, ctx.cwd);
    // A late read must not reset or append to a newer tool's similarity window.
    if (pending.generation !== similarGeneration) return;
    if (progressed) {
      resetSimilarity();
      return;
    }
    observeSimilarity(
      "read",
      canonicalizeArgs(event.input),
      normalizeReadPath(event.input.path, ctx.cwd),
      pending.cycleNotified,
    );
  });
  pi.on("tool_call", async (event, ctx) => {
    if (configError !== undefined) {
      return {
        block: true,
        reason: `stuck-guard: config invalid, tool calls blocked: ${configError}`,
      };
    }
    const effect = config;
    if (effect.action === "allow") return undefined;

    const input = canonicalizeArgs(event.input);
    if (event.toolName !== lastTool) {
      resetSimilarity();
      similarGeneration++;
      lastInput = undefined;
    }
    identicalCount = input === lastInput ? identicalCount + 1 : 1;
    lastTool = event.toolName;
    lastInput = input;
    const cycle = cycles.record(event.toolName, input);
    if (cycle) {
      pi.sendMessage(
        {
          customType: "stuck-guard-cycle-loop",
          content:
            `stuck-guard: repeating tool-call cycle (${cycle.count} repetitions, period ${cycle.period}): ` +
            `${cycle.tools.join(" -> ")}. Reuse existing evidence or change strategy if this sequence is not making progress. ` +
            "This is an advisory reminder; calls remain allowed.",
          display: true,
        },
        { triggerTurn: false, deliverAs: "steer" },
      );
    }
    if (event.toolName === "read") {
      pendingReads.set(event.toolCallId, {
        generation: similarGeneration,
        cycleNotified: cycle !== undefined,
      });
      // Bound calls that never reach tool_result, including vetoes by later extensions.
      if (pendingReads.size > SIMILAR_COUNT_LIMIT) {
        pendingReads.delete(pendingReads.keys().next().value!);
      }
    } else {
      observeSimilarity(event.toolName, input, undefined, cycle !== undefined);
    }

    if (identicalCount < REPEAT_THRESHOLD) {
      blockedCount = 0;
      return undefined;
    }
    const reason = `stuck-guard: doom_loop - ${event.toolName} repeated with identical input (${identicalCount} consecutive calls)`;

    // Allow-once does not erase repetition history; only actual vetoes advance the stop counter.
    let denial: string | undefined;
    if (effect.action === "deny") {
      denial = `${reason}${effect.message === undefined ? "" : `\n${effect.message}`}`;
    } else if (!ctx.hasUI) {
      denial = `${reason}; approval required but no interactive UI is available`;
    } else {
      ctx.ui.setWorkingMessage("waiting for doom-loop approval");
      let choice: string | undefined;
      try {
        choice = await ctx.ui.select(reason, ["Allow once", "Reject"], { signal: ctx.signal });
      } catch (error) {
        denial = `${reason}; approval dialog failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        ctx.ui.setWorkingMessage();
      }
      if (choice !== "Allow once") denial ??= `${reason}; rejected by user`;
    }
    if (denial === undefined) {
      blockedCount = 0;
      return undefined;
    }
    pendingReads.delete(event.toolCallId);
    blockedCount++;
    const terminate = blockedCount >= STOP_AFTER_BLOCKS;
    const blockReason = terminate
      ? `${denial}\nstuck-guard: run stopped after ${blockedCount} consecutive blocked calls; change strategy before retrying.`
      : denial;
    const result: ToolCallEventResult = {
      block: true,
      reason: blockReason,
      ...(terminate ? { terminate: true } : {}),
    };
    if (terminate && ctx.hasUI) ctx.ui.notify(blockReason, "warning");
    return result;
  });

  return (loaded) => {
    if (!loaded.ok) {
      configError = loaded.error;
      reset();
      return;
    }
    configError = undefined;
    const next = loaded.config.doomLoop;
    const nextThreshold = loaded.config.similarCallThreshold;
    if (config.action !== next.action || similarThreshold !== nextThreshold) reset();
    config = next;
    similarThreshold = nextThreshold;
  };
}
