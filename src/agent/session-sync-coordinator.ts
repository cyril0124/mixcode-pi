// Detects external appends to session files and drives per-session reloads.
//
// One coordinator per process. It polls the fingerprints of all registered
// session files on an interval (no fs.watch: inotify instances are a scarce
// per-user kernel quota on shared boxes), dedupes repeat notifications with a
// metadata fingerprint, and debounces bursts so a single conversation turn
// (which the SDK may flush as several appends) causes at most one reload.
//
// The poll interval and stat function are injectable so behavior is
// deterministic in tests; production uses node:fs stat.

import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Cheap metadata signature. ctime can trigger harmless metadata-only reloads;
 * prefer that over missing an equal-size/equal-mtime external replacement.
 */
export interface FileFingerprint {
  size: number;
  mtimeMs: number;
  ctimeMs?: number;
  ino?: number;
}

export type StatFingerprintFn = (
  filePath: string,
) => FileFingerprint | undefined | Promise<FileFingerprint | undefined>;

export interface SessionSyncCoordinatorOptions {
  sessionsRoot: string;
  /**
   * Called (debounced) when a registered session's file changed externally.
   * Returns false when the reload was refused (local agent streaming or
   * compacting); the change then stays pending for the next poll.
   */
  onExternalChange: (sessionId: string) => boolean;
  debounceMs?: number;
  /** Fingerprint poll cadence. Default 2s. */
  pollIntervalMs?: number;
  statFingerprint?: StatFingerprintFn;
}

const DEFAULT_DEBOUNCE_MS = 250;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

const defaultStatFingerprint: StatFingerprintFn = async (filePath) => {
  try {
    const s = await fs.promises.stat(filePath);
    return { size: s.size, mtimeMs: s.mtimeMs, ctimeMs: s.ctimeMs, ino: s.ino };
  } catch {
    return undefined;
  }
};

interface TrackedSession {
  sessionId: string;
  fileName: string;
  fingerprint?: FileFingerprint;
  debounceTimer?: ReturnType<typeof setTimeout>;
}

export class SessionSyncCoordinator {
  private readonly sessionsRoot: string;
  private readonly onExternalChange: (sessionId: string) => boolean;
  private readonly debounceMs: number;
  private readonly pollIntervalMs: number;
  private readonly statFingerprint: StatFingerprintFn;

  private readonly bySessionId = new Map<string, TrackedSession>();
  private pollTimer?: ReturnType<typeof setInterval>;
  private pollInFlight = false;
  private disposed = false;

  constructor(options: SessionSyncCoordinatorOptions) {
    this.sessionsRoot = options.sessionsRoot;
    this.onExternalChange = options.onExternalChange;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.statFingerprint = options.statFingerprint ?? defaultStatFingerprint;
  }

  /** Track a session's file. The current file state seeds the fingerprint so a
   *  freshly opened session does not immediately look "changed". */
  register(sessionId: string, sessionFile: string): void {
    if (this.disposed) return;
    this.unregister(sessionId);
    const fileName = path.basename(sessionFile);
    const tracked: TrackedSession = { sessionId, fileName };
    this.bySessionId.set(sessionId, tracked);
    void Promise.resolve(this.statFingerprint(path.join(this.sessionsRoot, fileName))).then(
      (fingerprint) => {
        if (this.bySessionId.get(sessionId) === tracked) tracked.fingerprint = fingerprint;
      },
    );
    this.ensurePolling();
  }

  unregister(sessionId: string): void {
    const tracked = this.bySessionId.get(sessionId);
    if (!tracked) return;
    if (tracked.debounceTimer) clearTimeout(tracked.debounceTimer);
    this.bySessionId.delete(sessionId);
  }

  /**
   * Record that the local process just wrote this session, so the resulting
   * watcher event is recognized as already-known and does not trigger an echo
   * reload of our own write. Also cancels any pending debounce for it.
   */
  markLocalWrite(sessionId: string): void {
    const tracked = this.bySessionId.get(sessionId);
    if (!tracked) return;
    if (tracked.debounceTimer) {
      clearTimeout(tracked.debounceTimer);
      tracked.debounceTimer = undefined;
    }
    void Promise.resolve(this.statFingerprint(path.join(this.sessionsRoot, tracked.fileName))).then(
      (fingerprint) => {
        if (this.bySessionId.get(sessionId) === tracked) tracked.fingerprint = fingerprint;
      },
    );
  }

  private ensurePolling(): void {
    if (this.pollTimer || this.disposed) return;
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
    this.pollTimer.unref?.();
  }

  /** Re-check every tracked session's fingerprint; changed files debounce a reload. */
  private async poll(): Promise<void> {
    if (this.disposed || this.pollInFlight) return;
    this.pollInFlight = true;
    try {
      await Promise.all(
        [...this.bySessionId.values()].map((tracked) => this.considerReload(tracked)),
      );
    } finally {
      this.pollInFlight = false;
    }
  }

  /** Reload only if the file's fingerprint actually changed. */
  private async considerReload(tracked: TrackedSession): Promise<void> {
    const next = await Promise.resolve(
      this.statFingerprint(path.join(this.sessionsRoot, tracked.fileName)),
    );
    if (next && fingerprintsEqual(tracked.fingerprint, next)) return;
    if (tracked.debounceTimer) clearTimeout(tracked.debounceTimer);
    tracked.debounceTimer = setTimeout(async () => {
      tracked.debounceTimer = undefined;
      if (this.bySessionId.get(tracked.sessionId) !== tracked || this.disposed) return;
      // Capture the fingerprint at fire time; the reload itself only reads.
      const atFireTime = await Promise.resolve(
        this.statFingerprint(path.join(this.sessionsRoot, tracked.fileName)),
      );
      // Consume the change only once the reload applied it. A refused reload
      // must leave the fingerprint stale, or the peer append behind it (a new
      // turn, or a rename carried by session_info) is dropped until the file
      // happens to change again.
      if (this.onExternalChange(tracked.sessionId)) tracked.fingerprint = atFireTime;
    }, this.debounceMs);
    tracked.debounceTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    for (const tracked of this.bySessionId.values()) {
      if (tracked.debounceTimer) clearTimeout(tracked.debounceTimer);
    }
    this.bySessionId.clear();
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}

function fingerprintsEqual(a: FileFingerprint | undefined, b: FileFingerprint): boolean {
  return (
    a !== undefined &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs &&
    a.ino === b.ino
  );
}
