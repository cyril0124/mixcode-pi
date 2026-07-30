// Keep local Agent tabs aligned with the shared open_tabs.json set.
//
// Create adds a session id to open_tabs; close/delete removes it. Every live
// instance watches (and polls) that file and opens/closes tabs to match.
// Instance registry is only used here for optional title lookup.
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  loadLiveInstanceStatus,
  type LoadInstanceStatusOptions,
} from "./instance-registry.js";
import { readOpenTabs } from "./open-tabs-store.js";

export interface PeerTabCandidate {
  sessionId: string;
  /** Present only when a live peer registry advertised a title. */
  title?: string;
  workdir: string;
  peerPid?: number;
}

export interface TabReconcilePlan {
  toOpen: PeerTabCandidate[];
  toClose: string[];
  desiredOrder: string[];
}

export interface ListTabsToReconcileInput {
  localSessionIds: Iterable<string>;
  desiredSessionIds: Iterable<string>;
  localWorkdir: string;
  /** Optional title/workdir hints from live peer registry snapshots. */
  peerHints?: Array<{
    pid: number;
    workdir: string;
    /** Registry snapshot time; fresher titles win when multiple peers advertise one id. */
    updatedAt?: string;
    tabs: Array<{ sessionId: string; title: string; workdir: string }>;
  }>;
}

/** Pure diff: open missing desired ids, close local ids no longer desired. */
export function listTabsToReconcile(input: ListTabsToReconcileInput): TabReconcilePlan {
  const local = new Set(input.localSessionIds);
  const desiredOrder = [...new Set(
    [...input.desiredSessionIds].map(String).filter((id) => id.trim()),
  )];
  const desired = new Set(desiredOrder);
  const localWorkdir = normalizeWorkdir(input.localWorkdir);
  const hints = new Map<string, PeerTabCandidate>();
  for (const peer of input.peerHints ?? []) {
    if (normalizeWorkdir(peer.workdir) !== localWorkdir) continue;
    for (const tab of peer.tabs) {
      if (normalizeWorkdir(tab.workdir) !== localWorkdir) continue;
      if (!hints.has(tab.sessionId)) {
        hints.set(tab.sessionId, {
          sessionId: tab.sessionId,
          title: tab.title,
          workdir: tab.workdir,
          peerPid: peer.pid,
        });
      }
    }
  }

  const toOpen: PeerTabCandidate[] = [];
  for (const sessionId of desired) {
    if (local.has(sessionId)) continue;
    const hint = hints.get(sessionId);
    // No synthetic Agent-{uuid8} title: openExistingAgentTab assigns Agent-NN
    // when title is absent.
    toOpen.push(hint ?? { sessionId, workdir: input.localWorkdir });
  }

  const toClose: string[] = [];
  for (const sessionId of local) {
    if (!desired.has(sessionId)) toClose.push(sessionId);
  }
  return { toOpen, toClose, desiredOrder };
}

export interface StartPeerTabSyncOptions {
  /** Path to shared open_tabs.json for this workdir. */
  openTabsPath: string;
  rootStateDir: string;
  workdir: string;
  selfPid?: number;
  getLocalSessionIds: () => Iterable<string>;
  openTab: (candidate: PeerTabCandidate) => Promise<void>;
  closeTab: (sessionId: string) => Promise<void>;
  reorderTabs?: (orderedSessionIds: string[]) => void | Promise<void>;
  /** Apply peer registry titles onto already-open local tabs (e.g. after /rename). */
  syncTabTitles?: (titles: Array<{ sessionId: string; title: string }>) => void | Promise<void>;
  onError?: (error: unknown) => void;
  debounceMs?: number;
  /** Polling fallback: NFS/dir watch can miss events. Default 2000ms. */
  pollIntervalMs?: number;
  loadStatus?: (
    rootStateDir: string,
    options?: LoadInstanceStatusOptions,
  ) => Promise<{ instances: Array<{
    pid: number;
    workdir: string;
    tabs: Array<{ sessionId: string; title: string; workdir: string }>;
  }> }>;
  readDesired?: (openTabsPath: string) => string[];
  watchFactory?: (
    dir: string,
    onEvent: () => void,
    onError: (error: unknown) => void,
  ) => { close(): void };
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Watch + poll open_tabs.json and open/close local tabs to match.
 * Opening failures (e.g. session file not on disk yet) surface via onError and
 * are retried on the next event — no silent disable.
 */
export function startPeerTabSync(options: StartPeerTabSyncOptions): {
  dispose(): void;
  reconcileNow(): Promise<void>;
} {
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const loadStatus = options.loadStatus ?? loadLiveInstanceStatus;
  const readDesired = options.readDesired ?? readOpenTabs;
  const watchFactory = options.watchFactory ?? defaultWatchFactory;
  const openTabsDir = dirname(options.openTabsPath);

  let disposed = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileInFlight: Promise<void> | undefined;
  let reconcileAgain = false;
  const opening = new Set<string>();
  const closing = new Set<string>();
  let watchHandle: { close(): void } | undefined;

  const schedule = () => {
    if (disposed) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void reconcile();
    }, debounceMs);
    debounceTimer.unref?.();
  };

  const reconcile = async (): Promise<void> => {
    if (disposed) return;
    if (reconcileInFlight) {
      reconcileAgain = true;
      return reconcileInFlight;
    }
    reconcileInFlight = (async () => {
      do {
        reconcileAgain = false;
        try {
          await runOnce();
        } catch (error) {
          options.onError?.(error);
        }
      } while (reconcileAgain && !disposed);
    })().finally(() => {
      reconcileInFlight = undefined;
    });
    return reconcileInFlight;
  };

  const runOnce = async (): Promise<void> => {
    // No shared file yet: do not close local tabs (bootstrap may still be seeding).
    if (!existsSync(options.openTabsPath)) return;
    const desired = readDesired(options.openTabsPath);

    let peerHints: ListTabsToReconcileInput["peerHints"] = [];
    try {
      const report = await loadStatus(options.rootStateDir, { workdir: options.workdir });
      peerHints = report.instances;
    } catch (error) {
      // Titles are optional; still reconcile opens/closes from open_tabs.
      options.onError?.(error);
    }

    const plan = listTabsToReconcile({
      localSessionIds: options.getLocalSessionIds(),
      desiredSessionIds: desired,
      localWorkdir: options.workdir,
      peerHints,
    });

    for (const candidate of plan.toOpen) {
      if (disposed) return;
      if (opening.has(candidate.sessionId) || closing.has(candidate.sessionId)) continue;
      const local = new Set(options.getLocalSessionIds());
      if (local.has(candidate.sessionId)) continue;
      opening.add(candidate.sessionId);
      try {
        await options.openTab(candidate);
      } catch (error) {
        options.onError?.(error);
      } finally {
        opening.delete(candidate.sessionId);
      }
    }

    for (const sessionId of plan.toClose) {
      if (disposed) return;
      if (closing.has(sessionId) || opening.has(sessionId)) continue;
      const local = new Set(options.getLocalSessionIds());
      if (!local.has(sessionId)) continue;
      closing.add(sessionId);
      try {
        await options.closeTab(sessionId);
      } catch (error) {
        options.onError?.(error);
      } finally {
        closing.delete(sessionId);
      }
    }

    // Titles are only set on open; refresh already-open tabs from live peer registry.
    if (options.syncTabTitles) {
      const local = new Set(options.getLocalSessionIds());
      const localWorkdir = normalizeWorkdir(options.workdir);
      // Freshest registry wins so a local /rename is not clobbered by a peer
      // still advertising the previous title (instances are sorted by pid).
      const best = new Map<string, { title: string; updatedAt: number }>();
      for (const peer of peerHints) {
        if (normalizeWorkdir(peer.workdir) !== localWorkdir) continue;
        const peerUpdatedAt = Date.parse(peer.updatedAt ?? "");
        const stamp = Number.isFinite(peerUpdatedAt) ? peerUpdatedAt : 0;
        for (const tab of peer.tabs) {
          if (normalizeWorkdir(tab.workdir) !== localWorkdir) continue;
          if (!local.has(tab.sessionId)) continue;
          const clean = tab.title?.trim();
          if (!clean) continue;
          const prev = best.get(tab.sessionId);
          if (!prev || stamp >= prev.updatedAt) {
            best.set(tab.sessionId, { title: clean, updatedAt: stamp });
          }
        }
      }
      const titles = [...best.entries()].map(([sessionId, value]) => ({
        sessionId,
        title: value.title,
      }));
      if (titles.length > 0) await options.syncTabTitles(titles);
    }

    await options.reorderTabs?.(plan.desiredOrder);
  };

  void mkdir(openTabsDir, { recursive: true })
    .then(() => {
      if (disposed) return;
      watchHandle = watchFactory(openTabsDir, schedule, (error) => options.onError?.(error));
      pollTimer = setInterval(schedule, pollIntervalMs);
      pollTimer.unref?.();
      schedule();
    })
    .catch((error: unknown) => options.onError?.(error));

  return {
    dispose() {
      disposed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = undefined;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
      watchHandle?.close();
      watchHandle = undefined;
    },
    reconcileNow: reconcile,
  };
}

function defaultWatchFactory(
  dir: string,
  onEvent: () => void,
  onError: (error: unknown) => void,
): { close(): void } {
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, () => onEvent());
  } catch (error) {
    onError(error);
    return { close: () => {} };
  }
  watcher.on("error", onError);
  return { close: () => watcher.close() };
}

function normalizeWorkdir(workdir: string): string {
  return workdir.trim().replace(/\/+$/, "");
}
