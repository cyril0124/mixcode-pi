// Cross-process, per-session "turn lock".
//
// Multiple mixcode-pi instances sharing one sessionsRoot must not append to the
// same session JSONL concurrently: interleaved appends corrupt the append-only
// tree (two children claiming the same leaf). This lock serializes session
// mutation across processes. It is advisory (cooperative): only code paths that
// acquire it are serialized.
//
// A lock is a small JSON file created atomically (open with "wx"). Ownership is
// verified with the same process-identity check used by the instance registry
// (PID liveness + Linux process start time), so a crashed owner's stale lock is
// detected and reclaimed, and PID reuse cannot silently steal ownership.
import * as fs from "node:fs";
import * as path from "node:path";
import { currentProcessIdentity, type ProcessIdentity } from "./instance-registry.js";

export const SESSION_LOCK_VERSION = 1;

export interface SessionLockRecord {
  version: typeof SESSION_LOCK_VERSION;
  sessionId: string;
  pid: number;
  processStartTime?: string;
  processVerification: ProcessIdentity["verification"];
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
 * A lock is stale when its owning process is gone, or the PID was reused by a
 * different process (start time mismatch). A corrupt/unparseable lock is also
 * treated as stale so a bad write never wedges a session forever.
 */
function lockIsStale(
  record: SessionLockRecord | undefined,
  processInfo: (pid: number) => ProcessIdentity,
): boolean {
  if (!record) return true;
  const identity = processInfo(record.pid);
  if (!identity.alive) return true;
  if (
    identity.startTime &&
    record.processStartTime &&
    identity.startTime !== record.processStartTime
  ) {
    return true;
  }
  return false;
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

  const identity = processInfo(pid);
  const record: SessionLockRecord = {
    version: SESSION_LOCK_VERSION,
    sessionId,
    pid,
    processStartTime: identity.startTime,
    processVerification: identity.verification,
    acquiredAt: (options.now ?? new Date()).toISOString(),
  };
  const payload = `${JSON.stringify(record)}\n`;

  // Two attempts: the first may fail because a stale lock is present; after
  // reclaiming it the second creation must succeed (or a live racer beat us).
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(filePath, "wx");
      try {
        fs.writeSync(fd, payload);
      } finally {
        fs.closeSync(fd);
      }
      return makeHandle(sessionId, filePath, pid, processInfo);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = readLockRecord(filePath);
      if (!lockIsStale(existing, processInfo)) {
        throw new SessionLockConflictError(sessionId, existing?.pid ?? -1);
      }
      // Reclaim: remove the stale lock and retry the atomic create.
      fs.rmSync(filePath, { force: true });
    }
  }
  // A racer reclaimed and took the lock between our checks.
  const existing = readLockRecord(filePath);
  throw new SessionLockConflictError(sessionId, existing?.pid ?? -1);
}

function readLockRecord(filePath: string): SessionLockRecord | undefined {
  try {
    return parseLockRecord(fs.readFileSync(filePath, "utf8"));
  } catch {
    return undefined;
  }
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
