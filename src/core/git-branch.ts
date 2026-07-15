import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
/** Stale-while-revalidate TTL for paint-path reads without an active watcher. */
const GIT_BRANCH_CACHE_TTL_MS = 2_000;
/** Debounce HEAD/fs events before re-reading branch (Pi FooterDataProvider uses 500ms). */
const WATCH_DEBOUNCE_MS = 500;

type GitBranchCacheEntry = {
  value: string;
  expiresAt: number;
  inflight?: Promise<void>;
};

type GitPaths = {
  repoDir: string;
  headPath: string;
};

type WorkdirWatchState = {
  paths: GitPaths | null;
  listeners: Set<() => void>;
  headWatcher: FSWatcher | null;
  debounceTimer: NodeJS.Timeout | null;
  refreshInFlight: boolean;
  refreshPending: boolean;
};

const gitBranchCache = new Map<string, GitBranchCacheEntry>();
/** Keyed by normalized workdir path. */
const workdirWatches = new Map<string, WorkdirWatchState>();

/**
 * Read git branch for a workdir without blocking the event loop.
 * Callers only get the last known value; refresh runs async and later
 * reads (next paint / footer re-render) pick up the update.
 *
 * Returns "" when unknown / not a repo / still loading the first value.
 */
export function gitBranchForWorkdir(workdir: string): string {
  const path = normalizeWorkdir(workdir);
  if (!path) return "";
  const now = Date.now();
  const cached = gitBranchCache.get(path);
  if (cached && cached.expiresAt > now) return cached.value;

  scheduleRefresh(path, cached?.value ?? "");
  return gitBranchCache.get(path)?.value ?? cached?.value ?? "";
}

/**
 * Subscribe to branch value changes for a workdir (Pi footerData.onBranchChange).
 * Uses fs.watch on the directory containing .git/HEAD (Pi strategy: git renames
 * HEAD atomically, so watching the file inode is unreliable).
 * Returns unsubscribe.
 */
export function onGitBranchChange(workdir: string, callback: () => void): () => void {
  const path = normalizeWorkdir(workdir);
  if (!path) return () => undefined;

  let state = workdirWatches.get(path);
  if (!state) {
    state = {
      paths: findGitPaths(path),
      listeners: new Set(),
      headWatcher: null,
      debounceTimer: null,
      refreshInFlight: false,
      refreshPending: false,
    };
    workdirWatches.set(path, state);
    setupHeadWatcher(path, state);
  }
  state.listeners.add(callback);
  // Kick a refresh so first resolve ("" -> branch) can notify.
  const entry = gitBranchCache.get(path);
  if (entry) entry.expiresAt = 0;
  scheduleRefresh(path, entry?.value ?? "");

  return () => {
    const current = workdirWatches.get(path);
    if (!current) return;
    current.listeners.delete(callback);
    if (current.listeners.size === 0) disposeWorkdirWatch(path, current);
  };
}

function normalizeWorkdir(workdir: string): string {
  return workdir.trim();
}

function scheduleRefresh(path: string, previousCachedValue: string): void {
  const cached = gitBranchCache.get(path);
  if (cached?.inflight) return;
  const run = refreshGitBranch(path, previousCachedValue);
  gitBranchCache.set(path, {
    value: cached?.value ?? previousCachedValue,
    expiresAt: cached?.expiresAt ?? 0,
    inflight: run,
  });
  void run.finally(() => {
    const entry = gitBranchCache.get(path);
    if (entry?.inflight === run) entry.inflight = undefined;
  });
}

async function refreshGitBranch(path: string, previousCachedValue: string): Promise<void> {
  const value = await resolveBranchAsync(path);
  const prev = gitBranchCache.get(path);
  const prevValue = prev?.value ?? previousCachedValue;
  gitBranchCache.set(path, {
    value,
    expiresAt: Date.now() + GIT_BRANCH_CACHE_TTL_MS,
    inflight: prev?.inflight,
  });
  if (prevValue !== value) notifyBranchChange(path);
}

async function resolveBranchAsync(path: string): Promise<string> {
  const watch = workdirWatches.get(path);
  const gitPaths = watch?.paths ?? findGitPaths(path);
  if (watch && !watch.paths) watch.paths = gitPaths;
  if (!gitPaths) return "";

  try {
    const content = readFileSync(gitPaths.headPath, "utf8").trim();
    if (content.startsWith("ref: refs/heads/")) {
      const branch = content.slice("ref: refs/heads/".length);
      // Pi treats ".invalid" as needing a git spawn; keep same fallback.
      if (branch === ".invalid") return (await resolveBranchWithGitAsync(gitPaths.repoDir)) || "";
      return branch;
    }
    // Detached HEAD: short hash for chrome badge (Pi footer uses "detached").
    if (/^[0-9a-f]{7,40}$/i.test(content)) return content.slice(0, 7);
    return (await resolveBranchWithGitAsync(gitPaths.repoDir)) || "";
  } catch {
    return (await resolveBranchWithGitAsync(gitPaths.repoDir)) || "";
  }
}

async function resolveBranchWithGitAsync(repoDir: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync("git", ["branch", "--show-current"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 1_000,
    });
    const branch = stdout.trim();
    if (branch) return branch;
    const short = await execFileAsync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
      timeout: 1_000,
    });
    return short.stdout.trim();
  } catch {
    return "";
  }
}

/**
 * Find git metadata paths by walking up from cwd.
 * Handles regular repos (.git dir) and worktrees (.git file with gitdir:).
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = resolve(cwd);
  while (true) {
    const gitPath = join(dir, ".git");
    if (existsSync(gitPath)) {
      try {
        const stat = statSync(gitPath);
        if (stat.isFile()) {
          const content = readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = resolve(dir, content.slice("gitdir: ".length).trim());
            const headPath = join(gitDir, "HEAD");
            if (!existsSync(headPath)) return null;
            return { repoDir: dir, headPath };
          }
        } else if (stat.isDirectory()) {
          const headPath = join(gitPath, "HEAD");
          if (!existsSync(headPath)) return null;
          return { repoDir: dir, headPath };
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function setupHeadWatcher(path: string, state: WorkdirWatchState): void {
  teardownHeadWatcher(state);
  if (!state.paths) return;

  // Watch the directory containing HEAD, not HEAD itself.
  // Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
  const headDir = dirname(state.paths.headPath);
  try {
    state.headWatcher = watch(headDir, (_eventType, filename) => {
      if (filename && filename !== "HEAD") return;
      scheduleWatchedRefresh(path, state);
    });
    state.headWatcher.on("error", () => {
      teardownHeadWatcher(state);
    });
    state.headWatcher.unref?.();
  } catch {
    state.headWatcher = null;
  }
}

function scheduleWatchedRefresh(path: string, state: WorkdirWatchState): void {
  if (state.debounceTimer) return;
  if (state.refreshInFlight) {
    state.refreshPending = true;
    return;
  }
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void runWatchedRefresh(path, state);
  }, WATCH_DEBOUNCE_MS);
  state.debounceTimer.unref?.();
}

async function runWatchedRefresh(path: string, state: WorkdirWatchState): Promise<void> {
  if (state.refreshInFlight) {
    state.refreshPending = true;
    return;
  }
  state.refreshInFlight = true;
  try {
    const prevValue = gitBranchCache.get(path)?.value ?? "";
    // Re-resolve git paths in case the repo layout changed.
    state.paths = findGitPaths(path);
    if (!state.headWatcher && state.paths) setupHeadWatcher(path, state);
    const value = await resolveBranchAsync(path);
    const prev = gitBranchCache.get(path);
    gitBranchCache.set(path, {
      value,
      expiresAt: Date.now() + GIT_BRANCH_CACHE_TTL_MS,
      inflight: prev?.inflight,
    });
    if (prevValue !== value) notifyBranchChange(path);
  } finally {
    state.refreshInFlight = false;
    if (state.refreshPending) {
      state.refreshPending = false;
      scheduleWatchedRefresh(path, state);
    }
  }
}

function notifyBranchChange(path: string): void {
  const listeners = workdirWatches.get(path)?.listeners;
  if (!listeners?.size) return;
  for (const callback of listeners) callback();
}

function teardownHeadWatcher(state: WorkdirWatchState): void {
  if (state.debounceTimer) {
    clearTimeout(state.debounceTimer);
    state.debounceTimer = null;
  }
  if (state.headWatcher) {
    state.headWatcher.close();
    state.headWatcher = null;
  }
}

function disposeWorkdirWatch(path: string, state: WorkdirWatchState): void {
  teardownHeadWatcher(state);
  workdirWatches.delete(path);
}
