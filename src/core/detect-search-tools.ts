import { spawnSync } from "node:child_process";

export interface SearchToolAvailability {
  /** Whether `rg` (ripgrep) is available on PATH. */
  hasRg: boolean;
  /** Whether `fd` (fd-find) is available on PATH. */
  hasFd: boolean;
}

/**
 * Detect whether rg and fd are available by running `--version`.
 * Uses spawnSync for cross-platform compatibility (no dependency on `which`).
 */
export function detectSearchTools(): SearchToolAvailability {
  return {
    hasRg: isCommandAvailable("rg", ["--version"]),
    hasFd: isCommandAvailable("fd", ["--version"]),
  };
}

function isCommandAvailable(command: string, args: string[]): boolean {
  try {
    const result = spawnSync(command, args, {
      stdio: "ignore",
      timeout: 5000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
