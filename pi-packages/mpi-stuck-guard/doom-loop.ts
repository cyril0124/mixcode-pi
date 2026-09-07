import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_STUCK_GUARD_CONFIG,
  type DoomLoopConfig,
  type StuckGuardConfigLoad,
} from "./config.js";

const REPEAT_THRESHOLD = 3;

/**
 * Count tool calls reaching this extension, across user turns within a session.
 * Returns the config updater used by the shared lifecycle reload; no per-call I/O.
 * A new session or disabling/re-enabling resets the streak. Allow-once does not.
 * Invalid config blocks calls until the next successful reload.
 */
export function wireDoomLoop(pi: ExtensionAPI): (loaded: StuckGuardConfigLoad) => void {
  let config: DoomLoopConfig = DEFAULT_STUCK_GUARD_CONFIG.doomLoop;
  let configError: string | undefined;
  let lastTool: string | undefined;
  let lastInput: string | undefined;
  let count = 0;

  function reset(): void {
    lastTool = undefined;
    lastInput = undefined;
    count = 0;
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

    // Input is the validated JSON tool payload. Preserve byte-sensitive comparison.
    const input = JSON.stringify(event.input);
    count = event.toolName === lastTool && input === lastInput ? count + 1 : 1;
    lastTool = event.toolName;
    lastInput = input;
    if (count < REPEAT_THRESHOLD) return undefined;

    const reason = `stuck-guard: doom_loop - ${event.toolName} repeated with identical input (${count} consecutive calls)`;
    if (effect.action === "deny") {
      return {
        block: true,
        reason: `${reason}${effect.message === undefined ? "" : `\n${effect.message}`}`,
      };
    }
    if (!ctx.hasUI) {
      return {
        block: true,
        reason: `${reason}; approval required but no interactive UI is available`,
      };
    }

    ctx.ui.setWorkingMessage("waiting for doom-loop approval");
    let choice: string | undefined;
    try {
      choice = await ctx.ui.select(
        `Doom loop: ${event.toolName} repeated with identical input (${count} calls)`,
        ["Allow once", "Reject"],
        { signal: ctx.signal },
      );
    } catch (error) {
      return {
        block: true,
        reason: `${reason}; approval dialog failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    } finally {
      ctx.ui.setWorkingMessage();
    }
    return choice === "Allow once"
      ? undefined
      : { block: true, reason: `${reason}; rejected by user` };
  });

  return (loaded) => {
    if (!loaded.ok) {
      configError = loaded.error;
      reset();
      return;
    }
    configError = undefined;
    const next = loaded.config.doomLoop;
    if (config.action === "allow" || next.action === "allow") reset();
    config = next;
  };
}
