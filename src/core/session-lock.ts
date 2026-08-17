// Cross-process, per-session "turn lock".
//
// Multiple mixcode-pi instances sharing one sessionsRoot must not append to the
// same session JSONL concurrently: interleaved appends corrupt the append-only
// tree (two children claiming the same leaf). This lock serializes session
// mutation across processes. It is advisory (cooperative): only code paths that
// acquire it are serialized.
//
// A lock is a small JSON file published atomically (temp write + linkSync) so the
// path never appears empty. Ownership is verified with the same process-identity
// check used by the instance registry (PID liveness), so a crashed owner's stale
// lock is reclaimed without stealing a live holder's.
import * as fs from "node:fs";
import * as path from "node:path";
import { currentProcessIdentity, type ProcessIdentity } from "./instance-registry.js";

export const SESSION_LOCK_VERSION = 1;

export interface SessionLockRecord {
  version: typeof SESSION_LOCK_VERSION;
  sessionId: string;
  pid: number;
  acquiredAt: string;
}

export interface SessionLockHandle {
  readonly sessionId: string;
  release(): void;
}

export class SessionLockConflictError extends Error {
  readonly holderPid: number;
  constructor(sessionId: string, holderPid: number) {
    super(
      `Session "${sessionId}" is being modified by another mixcode-pi instance (PID ${holderPid}). ` +
        `Wait for it to finish, or continue in that instance.`,
    );
    this.name = "SessionLockConflictError";
    this.holderPid = holderPid;
  }
}

export function sessionLockDir(sessionsRoot: string): string {
  return path.join(sessionsRoot, ".locks");
}

function sessionLockFile(sessionsRoot: string, sessionId: string): string {
  // sessionId is a UUID-shaped token (assertValidSessionId upstream); it never
  // contains path separators, so it is safe as a filename component.
  return path.join(sessionLockDir(sessionsRoot), `${sessionId}.lock`);
}

function parseLockRecord(raw: string): SessionLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<SessionLockRecord>;
    if (typeof value.pid !== "number") return undefined;
    return value as SessionLockRecord;
  } catch {
    return undefined;
  }
}

/**
 * A lock is stale when its owning process is gone. A corrupt/unparseable lock
 * is also treated as stale so a bad write never wedges a session forever.
 * ponytail: pid-only liveness; add start-time if PID wrap/reuse becomes a problem.
 */
function lockIsStale(
  record: SessionLockRecord | undefined,
  processInfo: (pid: number) => ProcessIdentity,
): boolean {
  if (!record) return true;
  return !processInfo(record.pid).alive;
}

export interface AcquireSessionTurnLockOptions {
  pid?: number;
  now?: Date;
  processInfo?: (pid: number) => ProcessIdentity;
}

/**
 * Acquire the turn lock for a session. Throws {@link SessionLockConflictError}
 * if a live instance holds it. Reclaims a stale lock left by a dead/reused PID.
 */
export function acquireSessionTurnLock(
  sessionsRoot: string,
  sessionId: string,
  options: AcquireSessionTurnLockOptions = {},
): SessionLockHandle {
  const pid = options.pid ?? process.pid;
  const processInfo = options.processInfo ?? ((p: number) => currentProcessIdentity(p));
  const filePath = sessionLockFile(sessionsRoot, sessionId);
  fs.mkdirSync(sessionLockDir(sessionsRoot), { recursive: true });

  const record: SessionLockRecord = {
    version: SESSION_LOCK_VERSION,
    sessionId,
    pid,
    acquiredAt: (options.now ?? new Date()).toISOString(),
  };
  const payload = `${JSON.stringify(record)}\n`;

  // Publish via temp+linkSync so the lock path never appears empty between
  // create and write. Reclaim stale locks via rename (not rm) so two reclaimers
  // cannot delete each other's freshly published lock (rm TOCTOU dual-hold).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tempPath = `${filePath}.${pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, payload, "utf8");
      try {
        fs.linkSync(tempPath, filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        // EEXIST then ENOENT means the holder released — retry acquire.
        // Never treat a missing path as reclaimable (that steals a brand-new lock).
        const existing = readLockSnapshot(filePath);
        if (existing.kind === "missing") continue;
        if (existing.kind === "ok" && !lockIsStale(existing.record, processInfo)) {
          throw new SessionLockConflictError(sessionId, existing.record.pid);
        }
        // Stale (dead pid) or corrupt/unparseable content that still exists on disk.
        if (!tryReclaimStaleLockFile(filePath, processInfo)) {
          const holder = readLockSnapshot(filePath);
          if (holder.kind === "ok" && !lockIsStale(holder.record, processInfo)) {
            throw new SessionLockConflictError(sessionId, holder.record.pid);
          }
        }
        continue;
      }
      return makeHandle(sessionId, filePath, pid, processInfo);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
  // A racer reclaimed and took the lock between our checks.
  const existing = readLockRecord(filePath);
  throw new SessionLockConflictError(sessionId, existing?.pid ?? -1);
}

/**
 * Atomically take a suspected-stale lock aside, re-verify, and drop it only if
 * still stale. Returns true when the path is free for a new acquire attempt.
 */
function tryReclaimStaleLockFile(
  filePath: string,
  processInfo: (pid: number) => ProcessIdentity,
): boolean {
  const quarantine = `${filePath}.reclaim.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(filePath, quarantine);
  } catch {
    return false;
  }
  const taken = readLockRecord(quarantine);
  if (!lockIsStale(taken, processInfo)) {
    // Live lock — put it back so the owner keeps mutual exclusion.
    try {
      fs.renameSync(quarantine, filePath);
    } catch {
      try {
        fs.linkSync(quarantine, filePath);
        fs.rmSync(quarantine, { force: true });
      } catch {
        // Path occupied; leave quarantine for diagnosis rather than deleting a live record.
      }
    }
    return false;
  }
  fs.rmSync(quarantine, { force: true });
  return true;
}

type LockSnapshot =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; record: SessionLockRecord };

function readLockSnapshot(filePath: string): LockSnapshot {
  try {
    const record = parseLockRecord(fs.readFileSync(filePath, "utf8"));
    return record ? { kind: "ok", record } : { kind: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

function readLockRecord(filePath: string): SessionLockRecord | undefined {
  const snap = readLockSnapshot(filePath);
  return snap.kind === "ok" ? snap.record : undefined;
}

function makeHandle(
  sessionId: string,
  filePath: string,
  pid: number,
  processInfo: (pid: number) => ProcessIdentity,
): SessionLockHandle {
  let released = false;
  return {
    sessionId,
    release(): void {
      if (released) return;
      released = true;
      // Only remove the file if we still own it. Guards the (rare) case where a
      // stale-reclaim by another process replaced our record with theirs.
      const current = readLockRecord(filePath);
      if (current && current.pid === pid) {
        fs.rmSync(filePath, { force: true });
      } else if (!current) {
        fs.rmSync(filePath, { force: true });
      }
      void processInfo; // reserved for future owner re-verification
    },
  };
}
