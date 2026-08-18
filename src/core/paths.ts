import * as os from "node:os";
import * as path from "node:path";

/**
 * The home directory `~` expands to. Prefers $HOME (shell semantics) and falls
 * back to the passwd entry. Single owner of this fact: the workdir picker
 * builds its `~` entry from the same rule, so listing and accepting `~` must
 * never resolve to different directories. Note Bun's os.homedir() snapshots at
 * startup and does not follow a mutated process.env.HOME.
 */
export function homeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HOME || os.homedir();
}

/** Expand leading ~ or ~/ (and win32 ~\\) to the user homedir. */
export function expandTilde(filepath: string): string {
  if (filepath === "~") return homeDir();
  if (filepath.startsWith("~/") || (process.platform === "win32" && filepath.startsWith("~\\"))) {
    return path.join(homeDir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Effective agent dir without importing @earendil-works/pi-coding-agent.
 * Matches Pi getAgentDir(): PI_CODING_AGENT_DIR ?? ~/.pi/agent.
 */
export function resolveMixcodeAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return expandTilde(envDir);
  return path.join(homeDir(env), ".pi", "agent");
}

/** Default root state dir: <agentDir>/mixcode-pi. */
export function resolveMixcodeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMixcodeAgentDir(env), "mixcode-pi");
}
