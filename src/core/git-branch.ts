import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const GIT_BRANCH_CACHE_TTL_MS = 2_000;

type GitBranchCacheEntry = {
  value: string;
  expiresAt: number;
  /** In-flight refresh so concurrent callers do not spawn parallel git processes. */
  inflight?: Promise<void>;
};

const gitBranchCache = new Map<string, GitBranchCacheEntry>();

/**
 * Read git branch for a workdir without blocking the event loop.
 * Callers only get the last known value; refresh runs async and later
 * reads (next paint / footer re-render) pick up the update.
 *
 * Returns "" when unknown / not a repo / still loading the first value.
 */
export function gitBranchForWorkdir(workdir: string): string {
  const path = workdir.trim();
  if (!path) return "";
  const now = Date.now();
  const cached = gitBranchCache.get(path);
  if (cached && cached.expiresAt > now) return cached.value;

  // Stale-while-revalidate: keep returning the previous value while git runs.
  if (!cached?.inflight) {
    const run = refreshGitBranch(path);
    gitBranchCache.set(path, {
      value: cached?.value ?? "",
      expiresAt: cached?.expiresAt ?? 0,
      inflight: run,
    });
    void run.finally(() => {
      const entry = gitBranchCache.get(path);
      if (entry?.inflight === run) entry.inflight = undefined;
    });
  }
  return gitBranchCache.get(path)?.value ?? "";
}

async function refreshGitBranch(path: string): Promise<void> {
  let value = "";
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: path,
      encoding: "utf8",
      timeout: 1_000,
    });
    value = stdout.trim();
    if (!value) {
      const short = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
        cwd: path,
        encoding: "utf8",
        timeout: 1_000,
      });
      value = short.stdout.trim();
    }
  } catch {
    value = "";
  }
  const prev = gitBranchCache.get(path);
  gitBranchCache.set(path, {
    value,
    expiresAt: Date.now() + GIT_BRANCH_CACHE_TTL_MS,
    inflight: prev?.inflight,
  });
}
