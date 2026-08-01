export interface SearchToolAvailability {
  /** Whether `rg` (ripgrep) is available on PATH. */
  hasRg: boolean;
  /** Whether `fd` (fd-find) is available on PATH. */
  hasFd: boolean;
}

/**
 * Detect whether rg and fd are available by running `--version`.
 */
export function detectSearchTools(): SearchToolAvailability {
  return {
    hasRg: isCommandAvailable("rg", ["--version"]),
    hasFd: isCommandAvailable("fd", ["--version"]),
  };
}

function isCommandAvailable(command: string, args: string[]): boolean {
  if (!Bun.which(command)) return false;
  try {
    const result = Bun.spawnSync([command, ...args], {
      stdout: "ignore",
      stderr: "ignore",
      timeout: 5000,
    });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
