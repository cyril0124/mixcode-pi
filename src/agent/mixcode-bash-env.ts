import {
  createBashToolDefinition,
  type SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mixCodeSpawnEnvContribution, type MixCodeTabEnvTitles } from "../core/tab-env.js";

/** ToolDefinition contract consumed by the MIXCODE_SPAWN_ENV_BRACKET patch hunk. */
type SpawnEnvBracketToolDefinition = ToolDefinition & {
  spawnEnvBracket?: () => Record<string, string | undefined>;
};

/**
 * Bash ToolDefinition that overrides the builtin bash tool and declares the
 * per-spawn MIXCODE tab env via `spawnEnvBracket`. The patched AgentSession
 * registry applies that contribution to process.env around the final "bash"
 * owner's execute — this tool, or an extension override that re-registered
 * "bash" (e.g. display extensions) — so the child env survives tool-name
 * collisions that would silently drop a spawnHook.
 */
export function createMixCodeBashCustomTools(
  cwd: string,
  settingsManager: SettingsManager,
  getTitles: () => MixCodeTabEnvTitles,
): ToolDefinition[] {
  // createBashToolDefinition is generic; createAgentSession customTools expects ToolDefinition[].
  const bash: SpawnEnvBracketToolDefinition = createBashToolDefinition(cwd, {
    commandPrefix: settingsManager.getShellCommandPrefix(),
    shellPath: settingsManager.getShellPath(),
  }) as ToolDefinition;
  bash.spawnEnvBracket = () => mixCodeSpawnEnvContribution(getTitles());
  return [bash];
}
