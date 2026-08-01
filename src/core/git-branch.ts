import * as fs from "node:fs";
import * as path from "node:path";

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
  headWatcher: fs.FSWatcher | null;
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
  const normalized = normalizeWorkdir(workdir);
  if (!normalized) return "";
  const now = Date.now();
  const cached = gitBranchCache.get(normalized);
  if (cached && cached.expiresAt > now) return cached.value;

  scheduleRefresh(normalized, cached?.value ?? "");
  return gitBranchCache.get(normalized)?.value ?? cached?.value ?? "";
}

/**
 * Subscribe to branch value changes for a workdir (Pi footerData.onBranchChange).
 * Uses fs.watch on the directory containing .git/HEAD (Pi strategy: git renames
 * HEAD atomically, so watching the file inode is unreliable).
 * Returns unsubscribe.
 */
export function onGitBranchChange(workdir: string, callback: () => void): () => void {
  const normalized = normalizeWorkdir(workdir);
  if (!normalized) return () => undefined;

  let state = workdirWatches.get(normalized);
  if (!state) {
    state = {
      paths: findGitPaths(normalized),
      listeners: new Set(),
      headWatcher: null,
      debounceTimer: null,
      refreshInFlight: false,
      refreshPending: false,
    };
    workdirWatches.set(normalized, state);
    setupHeadWatcher(normalized, state);
  }
  state.listeners.add(callback);
  // Kick a refresh so first resolve ("" -> branch) can notify.
  const entry = gitBranchCache.get(normalized);
  if (entry) entry.expiresAt = 0;
  scheduleRefresh(normalized, entry?.value ?? "");

  return () => {
    const current = workdirWatches.get(normalized);
    if (!current) return;
    current.listeners.delete(callback);
    if (current.listeners.size === 0) disposeWorkdirWatch(normalized, current);
  };
}

function normalizeWorkdir(workdir: string): string {
  return workdir.trim();
}

function scheduleRefresh(pathKey: string, previousCachedValue: string): void {
  const cached = gitBranchCache.get(pathKey);
  if (cached?.inflight) return;
  const run = refreshGitBranch(pathKey, previousCachedValue);
  gitBranchCache.set(pathKey, {
    value: cached?.value ?? previousCachedValue,
    expiresAt: cached?.expiresAt ?? 0,
    inflight: run,
  });
  void run.finally(() => {
    const entry = gitBranchCache.get(pathKey);
    if (entry?.inflight === run) entry.inflight = undefined;
  });
}

async function refreshGitBranch(pathKey: string, previousCachedValue: string): Promise<void> {
  const value = await resolveBranchAsync(pathKey);
  const prev = gitBranchCache.get(pathKey);
  const prevValue = prev?.value ?? previousCachedValue;
  gitBranchCache.set(pathKey, {
    value,
    expiresAt: Date.now() + GIT_BRANCH_CACHE_TTL_MS,
    inflight: prev?.inflight,
  });
  if (prevValue !== value) notifyBranchChange(pathKey);
}

async function resolveBranchAsync(pathKey: string): Promise<string> {
  const watchState = workdirWatches.get(pathKey);
  const gitPaths = watchState?.paths ?? findGitPaths(pathKey);
  if (watchState && !watchState.paths) watchState.paths = gitPaths;
  if (!gitPaths) return "";

  try {
    const content = (await Bun.file(gitPaths.headPath).text()).trim();
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
    const branch = (await runGit(repoDir, ["branch", "--show-current"])).trim();
    if (branch) return branch;
    return (await runGit(repoDir, ["rev-parse", "--short", "HEAD"])).trim();
  } catch {
    return "";
  }
}

/** Run git via Bun.spawn (global) — no `import from "bun"` so tsup/esbuild can bundle. */
async function runGit(repoDir: string, args: string[]): Promise<string> {
  // Match prior execFileAsync timeout so a stuck git (NFS, lock) cannot hang the footer.
  const timeoutMs = 1_000;
  const proc = Bun.spawn(["git", ...args], {
    cwd: repoDir,
    stdout: "pipe",
    // Ignore stderr so a chatty git cannot fill the pipe and deadlock.
    stderr: "ignore",
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const outcome = await Promise.race([
      Promise.all([proc.exited, new Response(proc.stdout).text()]).then(([code, stdout]) => ({
        timedOut: false as const,
        code,
        stdout,
      })),
      new Promise<{ timedOut: true }>((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (outcome.timedOut) {
      proc.kill();
      return "";
    }
    if (outcome.code !== 0) return "";
    return outcome.stdout;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Find git metadata paths by walking up from cwd.
 * Handles regular repos (.git dir) and worktrees (.git file with gitdir:).
 * Sync: used from paint-path and watcher setup.
 */
function findGitPaths(cwd: string): GitPaths | null {
  let dir = path.resolve(cwd);
  while (true) {
    const gitPath = path.join(dir, ".git");
    if (fs.existsSync(gitPath)) {
      try {
        const stat = fs.statSync(gitPath);
        if (stat.isFile()) {
          const content = fs.readFileSync(gitPath, "utf8").trim();
          if (content.startsWith("gitdir: ")) {
            const gitDir = path.resolve(dir, content.slice("gitdir: ".length).trim());
            const headPath = path.join(gitDir, "HEAD");
            if (!fs.existsSync(headPath)) return null;
            return { repoDir: dir, headPath };
          }
        } else if (stat.isDirectory()) {
          const headPath = path.join(gitPath, "HEAD");
          if (!fs.existsSync(headPath)) return null;
          return { repoDir: dir, headPath };
        }
      } catch {
        return null;
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function setupHeadWatcher(pathKey: string, state: WorkdirWatchState): void {
  teardownHeadWatcher(state);
  if (!state.paths) return;

  // Watch the directory containing HEAD, not HEAD itself.
  // Git uses atomic writes (write temp, rename over HEAD), which changes the inode.
  const headDir = path.dirname(state.paths.headPath);
  try {
    state.headWatcher = fs.watch(headDir, (_eventType, filename) => {
      if (filename && filename !== "HEAD") return;
      scheduleWatchedRefresh(pathKey, state);
    });
    state.headWatcher.on("error", () => {
      teardownHeadWatcher(state);
    });
    state.headWatcher.unref?.();
  } catch {
    state.headWatcher = null;
  }
}

function scheduleWatchedRefresh(pathKey: string, state: WorkdirWatchState): void {
  if (state.debounceTimer) return;
  if (state.refreshInFlight) {
    state.refreshPending = true;
    return;
  }
  state.debounceTimer = setTimeout(() => {
    state.debounceTimer = null;
    void runWatchedRefresh(pathKey, state);
  }, WATCH_DEBOUNCE_MS);
  state.debounceTimer.unref?.();
}

async function runWatchedRefresh(pathKey: string, state: WorkdirWatchState): Promise<void> {
  if (state.refreshInFlight) {
    state.refreshPending = true;
    return;
  }
  state.refreshInFlight = true;
  try {
    const prevValue = gitBranchCache.get(pathKey)?.value ?? "";
    // Re-resolve git paths in case the repo layout changed.
    state.paths = findGitPaths(pathKey);
    if (!state.headWatcher && state.paths) setupHeadWatcher(pathKey, state);
    const value = await resolveBranchAsync(pathKey);
    const prev = gitBranchCache.get(pathKey);
    gitBranchCache.set(pathKey, {
      value,
      expiresAt: Date.now() + GIT_BRANCH_CACHE_TTL_MS,
      inflight: prev?.inflight,
    });
    if (prevValue !== value) notifyBranchChange(pathKey);
  } finally {
    state.refreshInFlight = false;
    if (state.refreshPending) {
      state.refreshPending = false;
      scheduleWatchedRefresh(pathKey, state);
    }
  }
}

function notifyBranchChange(pathKey: string): void {
  const listeners = workdirWatches.get(pathKey)?.listeners;
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

function disposeWorkdirWatch(pathKey: string, state: WorkdirWatchState): void {
  teardownHeadWatcher(state);
  workdirWatches.delete(pathKey);
}
