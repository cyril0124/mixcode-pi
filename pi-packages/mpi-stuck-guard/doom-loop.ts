import type { ExtensionAPI, ToolCallEventResult } from "@earendil-works/pi-coding-agent";
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

/** Mean adjacent bigram-Dice similarity in one bounded same-tool argument window. */
function meanSimilarity(inputs: readonly string[]): number {
  let previousBigrams = bigramCounts(inputs[0]!);
  let totalSimilarity = 0;
  for (let index = 1; index < inputs.length; index++) {
    const currentBigrams = bigramCounts(inputs[index]!);
    let sharedBigramCount = 0;
    for (const [pair, count] of previousBigrams) {
      sharedBigramCount += Math.min(count, currentBigrams.get(pair) ?? 0);
    }
    const combinedBigramCount = inputs[index - 1]!.length + inputs[index]!.length - 2;
    totalSimilarity +=
      combinedBigramCount === 0 ? 1 : (2 * sharedBigramCount) / combinedBigramCount;
    previousBigrams = currentBigrams;
  }
  return totalSimilarity / (inputs.length - 1);
}

/**
 * Protect tool calls across user turns within a session. Similar calls only warn;
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
  let targets: (string | undefined)[] = [];
  let similarCount = 0;
  let lastNoticeCount = 0;
  let blockedCount = 0;

  function reset(): void {
    lastTool = undefined;
    lastInput = undefined;
    identicalCount = 0;
    inputs = [];
    targets = [];
    similarCount = 0;
    lastNoticeCount = 0;
    blockedCount = 0;
  }

  pi.on("session_start", reset);
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
    if (event.toolName !== lastTool) reset();
    identicalCount = input === lastInput ? identicalCount + 1 : 1;
    lastTool = event.toolName;
    lastInput = input;
    inputs.push(input);
    // Distinct file paths suppress similarity reminders; pagination remains eligible.
    targets.push(
      event.toolName === "read" && typeof event.input.path === "string"
        ? event.input.path
        : undefined,
    );
    if (inputs.length > similarThreshold) {
      inputs.shift();
      targets.shift();
    }

    const distinctTargets =
      targets.every((target) => target !== undefined) && new Set(targets).size === targets.length;
    const similarity = inputs.length >= similarThreshold ? meanSimilarity(inputs) : 0;
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
    if (shouldWarn) {
      lastNoticeCount = similarCount;
      pi.sendMessage(
        {
          customType: "stuck-guard-similar-loop",
          content:
            `stuck-guard: ${event.toolName} repeated with near-identical arguments ` +
            `(${similarCount} calls, ${Math.round(similarity * 100)}% similarity). ` +
            "Check whether these calls produce new evidence. Reuse existing results or change strategy if they do not. " +
            "This is an advisory reminder; different arguments remain allowed.",
          display: true,
        },
        { triggerTurn: false, deliverAs: "steer" },
      );
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
