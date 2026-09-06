// Keep local Agent tabs aligned with the shared open_tabs.json set.
//
// Create adds a session id to open_tabs; close/delete removes it. Every live
// instance polls that file and opens/closes tabs to match. Polling (no
// fs.watch: inotify instances are a scarce per-user kernel quota on shared
// boxes) is also what makes this work on NFS, where dir watches can miss
// events. Instance registry is only used here for optional title lookup.
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type LoadInstanceStatusOptions, loadLiveInstanceStatus } from "./instance-registry.js";
import { readOpenTabs } from "./open-tabs-store.js";

export interface PeerTabCandidate {
  sessionId: string;
  /** Present only when a live peer registry advertised a title. */
  title?: string;
  workdir: string;
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
    tabs: Array<{ sessionId: string; title: string; workdir: string }>;
  }>;
}

/** Pure diff: open missing desired ids, close local ids no longer desired. */
export function listTabsToReconcile(input: ListTabsToReconcileInput): TabReconcilePlan {
  const local = new Set(input.localSessionIds);
  const desiredOrder = [
    ...new Set([...input.desiredSessionIds].map(String).filter((id) => id.trim())),
  ];
  const desired = new Set(desiredOrder);
  const hints = peerHintsBySession(input.peerHints, input.localWorkdir);

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

function peerHintsBySession(
  peers: ListTabsToReconcileInput["peerHints"],
  workdir: string,
): Map<string, PeerTabCandidate> {
  const localWorkdir = normalizeWorkdir(workdir);
  const hints = new Map<string, PeerTabCandidate>();
  for (const peer of peers ?? []) {
    if (normalizeWorkdir(peer.workdir) !== localWorkdir) continue;
    for (const tab of peer.tabs) {
      if (normalizeWorkdir(tab.workdir) !== localWorkdir || hints.has(tab.sessionId)) continue;
      hints.set(tab.sessionId, {
        sessionId: tab.sessionId,
        title: tab.title,
        workdir: tab.workdir,
      });
    }
  }
  return hints;
}

export interface StartPeerTabSyncOptions {
  /** Path to shared open_tabs.json for this workdir. */
  openTabsPath: string;
  rootStateDir: string;
  workdir: string;
  getLocalSessionIds: () => Iterable<string>;
  openTab: (candidate: PeerTabCandidate) => Promise<void>;
  closeTab: (sessionId: string) => Promise<void>;
  reorderTabs?: (orderedSessionIds: string[]) => void | Promise<void>;
  onError?: (error: unknown) => void;
  /** Poll cadence. Default 2000ms. */
  pollIntervalMs?: number;
  loadStatus?: (
    rootStateDir: string,
    options?: LoadInstanceStatusOptions,
  ) => Promise<{
    instances: Array<{
      pid: number;
      workdir: string;
      tabs: Array<{ sessionId: string; title: string; workdir: string }>;
    }>;
  }>;
  readDesired?: (openTabsPath: string) => string[];
}

const DEFAULT_POLL_INTERVAL_MS = 2_000;

/**
 * Poll open_tabs.json and open/close local tabs to match.
 * Opening failures (e.g. session file not on disk yet) surface via onError and
 * are retried on the next poll — no silent disable.
 */
export function startPeerTabSync(options: StartPeerTabSyncOptions): {
  dispose(): void;
  reconcileNow(): Promise<void>;
} {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const loadStatus = options.loadStatus ?? loadLiveInstanceStatus;
  const readDesired = options.readDesired ?? readOpenTabs;
  const openTabsDir = path.dirname(options.openTabsPath);

  let disposed = false;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconcileInFlight: Promise<void> | undefined;
  let reconcileAgain = false;

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
    if (!(await Bun.file(options.openTabsPath).exists())) return;

    let peerHints: ListTabsToReconcileInput["peerHints"] = [];
    try {
      const report = await loadStatus(options.rootStateDir, { workdir: options.workdir });
      peerHints = report.instances;
    } catch (error) {
      // Titles are optional; still reconcile opens/closes from open_tabs.
      options.onError?.(error);
    }

    // Hints are advisory and loaded once; do not rebuild their index per mutation.
    const hints = peerHintsBySession(peerHints, options.workdir);
    // Each operation/id is attempted once per pass, including failures. A later
    // poll can retry it without an immediate retry loop blocking reconciliation.
    const attemptedOpens = new Set<string>();
    const attemptedCloses = new Set<string>();
    let plan: TabReconcilePlan;
    for (;;) {
      if (disposed) return;
      // Keep desired/local reads synchronous after every await. Local publishing
      // and tab membership changes must not be paired with a stale desired set.
      const desired = readDesired(options.openTabsPath);
      const localSnapshot = [...options.getLocalSessionIds()];
      plan = listTabsToReconcile({
        localSessionIds: localSnapshot,
        desiredSessionIds: desired,
        localWorkdir: options.workdir,
      });

      const candidate = plan.toOpen.find((tab) => !attemptedOpens.has(tab.sessionId));
      if (candidate) {
        attemptedOpens.add(candidate.sessionId);
        try {
          await options.openTab(hints.get(candidate.sessionId) ?? candidate);
        } catch (error) {
          options.onError?.(error);
        }
        continue;
      }

      const sessionId = plan.toClose.find((id) => !attemptedCloses.has(id));
      if (sessionId === undefined) break;
      attemptedCloses.add(sessionId);
      try {
        await options.closeTab(sessionId);
      } catch (error) {
        options.onError?.(error);
      }
    }

    // Registry titles seed tabs only at open time. Titles of already-open tabs
    // follow the session file (session_info entry) through session sync, which
    // carries a per-rename record; registry snapshots only carry a heartbeat
    // timestamp and cannot order two instances' titles against each other.
    await options.reorderTabs?.(plan.desiredOrder);
  };

  void fs
    .mkdir(openTabsDir, { recursive: true })
    .then(() => {
      if (disposed) return;
      pollTimer = setInterval(() => void reconcile(), pollIntervalMs);
      pollTimer.unref?.();
      void reconcile();
    })
    .catch((error: unknown) => options.onError?.(error));

  return {
    dispose() {
      disposed = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = undefined;
    },
    reconcileNow: reconcile,
  };
}

function normalizeWorkdir(workdir: string): string {
  return workdir.trim().replace(/\/+$/, "");
}
