// Detects external appends to session files and drives per-session reloads.
//
// One coordinator per process. It watches the sessionsRoot directory ONCE (not
// once per tab), maps changed filenames back to registered sessions, dedupes
// repeat notifications with a metadata fingerprint, and debounces bursts so a
// single conversation turn (which the SDK may flush as several appends) causes
// at most one reload.
//
// The watch and stat functions are injectable so behavior is deterministic in
// tests; production uses node:fs (watch has no Bun equivalent).

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

export interface SessionWatchHandle {
  close(): void;
}

export type SessionWatchFactory = (
  dir: string,
  onEvent: (filename: string | null) => void,
  onError: (error: unknown) => void,
) => SessionWatchHandle;

export type StatFingerprintFn = (filePath: string) => FileFingerprint | undefined;

export interface SessionSyncCoordinatorOptions {
  sessionsRoot: string;
  /** Called (debounced) when a registered session's file changed externally. */
  onExternalChange: (sessionId: string) => void;
  /** Surface watch failures explicitly instead of silently disabling sync. */
  onError?: (error: unknown) => void;
  debounceMs?: number;
  watchFactory?: SessionWatchFactory;
  statFingerprint?: StatFingerprintFn;
}

const DEFAULT_DEBOUNCE_MS = 250;

const defaultWatchFactory: SessionWatchFactory = (dir, onEvent, onError) => {
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(dir, { persistent: false }, (_type, filename) => {
      onEvent(typeof filename === "string" ? filename : null);
    });
  } catch (error) {
    onError(error);
    return { close: () => {} };
  }
  watcher.on("error", onError);
  return { close: () => watcher.close() };
};

const defaultStatFingerprint: StatFingerprintFn = (filePath) => {
  try {
    const s = fs.statSync(filePath);
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
  private readonly onExternalChange: (sessionId: string) => void;
  private readonly onError?: (error: unknown) => void;
  private readonly debounceMs: number;
  private readonly watchFactory: SessionWatchFactory;
  private readonly statFingerprint: StatFingerprintFn;

  // Two indexes over the same tracked sessions: by session id (register/
  // unregister/markLocalWrite) and by file basename (watcher event resolution).
  private readonly bySessionId = new Map<string, TrackedSession>();
  private readonly byFileName = new Map<string, TrackedSession>();
  private watchHandle?: SessionWatchHandle;
  private disposed = false;

  constructor(options: SessionSyncCoordinatorOptions) {
    this.sessionsRoot = options.sessionsRoot;
    this.onExternalChange = options.onExternalChange;
    this.onError = options.onError;
    this.debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.watchFactory = options.watchFactory ?? defaultWatchFactory;
    this.statFingerprint = options.statFingerprint ?? defaultStatFingerprint;
  }

  /** Track a session's file. The current file state seeds the fingerprint so a
   *  freshly opened session does not immediately look "changed". */
  register(sessionId: string, sessionFile: string): void {
    if (this.disposed) return;
    this.unregister(sessionId);
    const fileName = path.basename(sessionFile);
    const tracked: TrackedSession = {
      sessionId,
      fileName,
      fingerprint: this.statFingerprint(path.join(this.sessionsRoot, fileName)),
    };
    this.bySessionId.set(sessionId, tracked);
    this.byFileName.set(fileName, tracked);
    this.ensureWatching();
  }

  unregister(sessionId: string): void {
    const tracked = this.bySessionId.get(sessionId);
    if (!tracked) return;
    if (tracked.debounceTimer) clearTimeout(tracked.debounceTimer);
    this.bySessionId.delete(sessionId);
    // Only drop the filename index if it still points at this session (a
    // re-register under a new file could have replaced it).
    if (this.byFileName.get(tracked.fileName) === tracked) {
      this.byFileName.delete(tracked.fileName);
    }
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
    tracked.fingerprint = this.statFingerprint(path.join(this.sessionsRoot, tracked.fileName));
  }

  private ensureWatching(): void {
    if (this.watchHandle || this.disposed) return;
    this.watchHandle = this.watchFactory(
      this.sessionsRoot,
      (filename) => this.handleEvent(filename),
      (error) => this.onError?.(error),
    );
  }

  private handleEvent(filename: string | null): void {
    if (this.disposed) return;
    if (filename !== null) {
      const tracked = this.byFileName.get(filename);
      if (tracked) this.considerReload(tracked);
      return;
    }
    // Some platforms omit the filename. Re-check every tracked session instead
    // of scanning the (potentially large) directory of historical sessions.
    for (const tracked of this.bySessionId.values()) this.considerReload(tracked);
  }

  /** Reload only if the file's fingerprint actually changed. */
  private considerReload(tracked: TrackedSession): void {
    const next = this.statFingerprint(path.join(this.sessionsRoot, tracked.fileName));
    if (next && fingerprintsEqual(tracked.fingerprint, next)) return;
    if (tracked.debounceTimer) clearTimeout(tracked.debounceTimer);
    tracked.debounceTimer = setTimeout(() => {
      tracked.debounceTimer = undefined;
      // Capture the fingerprint at fire time; the reload itself only reads.
      tracked.fingerprint = this.statFingerprint(path.join(this.sessionsRoot, tracked.fileName));
      this.onExternalChange(tracked.sessionId);
    }, this.debounceMs);
    tracked.debounceTimer.unref?.();
  }

  dispose(): void {
    this.disposed = true;
    for (const tracked of this.bySessionId.values()) {
      if (tracked.debounceTimer) clearTimeout(tracked.debounceTimer);
    }
    this.bySessionId.clear();
    this.byFileName.clear();
    this.watchHandle?.close();
    this.watchHandle = undefined;
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
