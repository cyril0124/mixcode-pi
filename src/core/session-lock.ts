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
import * as path from "node:path";
import { currentProcessIdentity, type ProcessIdentity } from "./instance-registry.js";
import { acquirePidFileLock } from "./pid-file-lock.js";

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

  const record: SessionLockRecord = {
    version: SESSION_LOCK_VERSION,
    sessionId,
    pid,
    acquiredAt: (options.now ?? new Date()).toISOString(),
  };
  const payload = `${JSON.stringify(record)}\n`;
  const lock = acquirePidFileLock({
    lockPath: filePath,
    payload,
    pid,
    parseRecord: parseLockRecord,
    isStale: (existing) => lockIsStale(existing, processInfo),
    onBusy: (holderPid) => {
      throw new SessionLockConflictError(sessionId, holderPid);
    },
    maxAttempts: 2,
  });
  return {
    sessionId,
    release: lock.release,
  };
}
