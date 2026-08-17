import * as os from "node:os";
import * as path from "node:path";
import {
  formatInstanceStatusJson,
  formatInstanceStatusTable,
  loadLiveInstanceStatus,
} from "../core/instance-registry.js";

/** Check if CLI argv targets the status subcommand. */
export function isStatusCliArgs(args: string[]): boolean {
  return args[0] === "status";
}

/**
 * Expand leading ~ or ~/ to user homedir.
 * Replicates Pi's expandTildePath without importing pi-coding-agent.
 */
export function expandTilde(filepath: string): string {
  if (filepath === "~") return os.homedir();
  if (filepath.startsWith("~/") || (process.platform === "win32" && filepath.startsWith("~\\"))) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

/** Parse `--workdir <path>` / `--workdir=<path>` and resolve against `baseWorkdir`. */
export function takeWorkdirFlag(
  arg: string | undefined,
  next: () => string | undefined,
  baseWorkdir: string,
): string | undefined {
  if (arg === "--workdir") {
    const value = next();
    if (!value) throw new Error("--workdir requires a path");
    return path.resolve(baseWorkdir, expandTilde(value));
  }
  if (arg?.startsWith("--workdir=")) {
    const value = arg.slice("--workdir=".length);
    if (!value) throw new Error("--workdir requires a path");
    return path.resolve(baseWorkdir, expandTilde(value));
  }
  return undefined;
}

/**
 * Resolve effective agent dir without importing @earendil-works/pi-coding-agent.
 * Matches Pi getAgentDir() contract: PI_CODING_AGENT_DIR ?? ~/.pi/agent.
 */
export function resolveMixcodeAgentDir(env: NodeJS.ProcessEnv = process.env): string {
  const envDir = env.PI_CODING_AGENT_DIR?.trim();
  if (envDir) return expandTilde(envDir);
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * Resolve default root state dir without heavy imports.
 * Matches bootstrap.ts defaultStateDir() output: <agentDir>/mixcode-pi.
 */
export function resolveMixcodeStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMixcodeAgentDir(env), "mixcode-pi");
}

export interface StatusCliOptions {
  json?: boolean;
  workdir?: string;
  stateDir?: string;
}

/** Execute status command and write output to stdout. */
export async function runStatusCommand(options: StatusCliOptions = {}): Promise<void> {
  const rootStateDir = options.stateDir ?? resolveMixcodeStateDir();
  const report = await loadLiveInstanceStatus(rootStateDir, { workdir: options.workdir });
  const output = options.json ? formatInstanceStatusJson(report) : formatInstanceStatusTable(report);
  process.stdout.write(`${output}\n`);
}
