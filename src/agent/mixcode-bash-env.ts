import {
  createBashToolDefinition,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { applyMixCodeTabEnv, MIXCODE_PID_ENV, type MixCodeTabEnvTitles } from "../core/tab-env.js";

/**
 * Bash ToolDefinition that overrides the builtin bash tool and injects
 * MIXCODE_PID / MIXCODE_TAB_TITLE / MIXCODE_FOCUSED_TAB_TITLE on each spawn
 * (after Pi PI_*).
 */
export function createMixCodeBashCustomTools(
  cwd: string,
  settingsManager: SettingsManager,
  getTitles: () => MixCodeTabEnvTitles,
): ToolDefinition[] {
  // createBashToolDefinition is generic; createAgentSession customTools expects ToolDefinition[].
  return [
    createBashToolDefinition(cwd, {
      commandPrefix: settingsManager.getShellCommandPrefix(),
      shellPath: settingsManager.getShellPath(),
      spawnHook: (ctx) => ({
        ...ctx,
        env: applyMixCodeTabEnv({ ...ctx.env, [MIXCODE_PID_ENV]: String(process.pid) }, getTitles()),
      }),
    }) as ToolDefinition,
  ];
}
