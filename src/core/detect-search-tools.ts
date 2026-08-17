export interface SearchToolAvailability {
  /** Whether `rg` (ripgrep) is available on PATH. */
  hasRg: boolean;
  /** Whether `fd` (fd-find) is available on PATH. */
  hasFd: boolean;
}

/** Detect whether rg and fd are on PATH. */
export function detectSearchTools(): SearchToolAvailability {
  return {
    hasRg: Boolean(Bun.which("rg")),
    hasFd: Boolean(Bun.which("fd")),
  };
}
