import * as path from "node:path";
import {
  expandTilde,
  resolveMixcodeAgentDir,
  resolveMixcodeStateDir,
} from "../core/paths.js";
import {
  formatInstanceStatusJson,
  formatInstanceStatusTable,
  loadLiveInstanceStatus,
} from "../core/instance-registry.js";

export { expandTilde, resolveMixcodeAgentDir, resolveMixcodeStateDir };

/** Check if CLI argv targets the status subcommand. */
export function isStatusCliArgs(args: string[]): boolean {
  return args[0] === "status";
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
