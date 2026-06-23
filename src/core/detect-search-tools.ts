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

/**
 * Resolve the fd binary name available on PATH, trying `fd` then `fdfind`
 * (Debian/Ubuntu ship the binary as `fdfind`). Mirrors pi's tools-manager
 * `getToolPath("fd")` system-PATH probe so live `@` file completion can shell
 * out to the same tool pi uses. Returns the invokable command name, or
 * undefined when fd is not installed.
 */
export function resolveFdBinary(): string | undefined {
  for (const candidate of ["fd", "fdfind"]) {
    if (isCommandAvailable(candidate, ["--version"])) return candidate;
  }
  return undefined;
}
