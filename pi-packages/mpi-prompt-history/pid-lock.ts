// NFS-safe advisory PID file lock: temp write + linkSync publish, rename reclaim.
//
// The lock file is published atomically so the path never appears empty, and a
// crashed owner's lock is reclaimed only after re-verifying it under quarantine
// (rename-aside, re-read, drop) so two reclaimers cannot delete each other's
// freshly published lock.
//
// Filesystems that reject link(2) (EPERM/ENOTSUP on FUSE-backed phone storage) fall
// back to exclusive create, and degrade to an unlocked write when even that is
// refused: history writes stay atomic per writer, only cross-process merging weakens.
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const HISTORY_LOCK_VERSION = 1;

export interface PidLockRecord {
  version: typeof HISTORY_LOCK_VERSION;
  id: string;
  pid: number;
  acquiredAt: string;
}

export interface PidLockHandle {
  release(): void;
}

export interface AcquirePidLockOptions {
  pid?: number;
  /** Liveness probe; injectable so tests can simulate a crashed owner. */
  processAlive?: (pid: number) => boolean;
  /** Hard-link publish; injectable so tests can simulate a filesystem without link(2). */
  linkFile?: (from: string, to: string) => void;
}

/** Returned when the filesystem cannot publish a lock file atomically at all. */
const UNLOCKED_HANDLE: PidLockHandle = { release() {} };

/** Busy signal: a live process holds the lock. Callers decide wait vs abort. */
export class PidLockBusyError extends Error {
  readonly holderPid: number;
  constructor(id: string, holderPid: number) {
    super(`Lock "${id}" is held by a live process (PID ${holderPid}).`);
    this.name = "PidLockBusyError";
    this.holderPid = holderPid;
  }
}

function lockDir(stateDir: string): string {
  return path.join(stateDir, ".locks");
}

function lockFile(stateDir: string, id: string): string {
  return path.join(lockDir(stateDir), `${id}.lock`);
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function parseRecord(raw: string): PidLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<PidLockRecord>;
    return typeof value.pid === "number" ? (value as PidLockRecord) : undefined;
  } catch {
    // Corrupt lock content is treated as stale so a bad write never wedges the file.
    return undefined;
  }
}

function linkUnsupported(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "EPERM" || code === "ENOTSUP" || code === "EOPNOTSUPP";
}

/**
 * Publish `payload` at `filePath` with exclusive create, the only atomic
 * primitive left once link(2) is refused.
 */
function publishExclusive(
  filePath: string,
  payload: string,
): "published" | "exists" | "unsupported" {
  let fd: number;
  try {
    fd = fs.openSync(filePath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    if (linkUnsupported(error)) return "unsupported";
    throw error;
  }
  try {
    fs.writeFileSync(fd, payload, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  return "published";
}

type Snapshot = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; record: PidLockRecord };

function readSnapshot(filePath: string): Snapshot {
  try {
    const record = parseRecord(fs.readFileSync(filePath, "utf8"));
    return record ? { kind: "ok", record } : { kind: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

function makeHandle(filePath: string, pid: number): PidLockHandle {
  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      const current = readSnapshot(filePath);
      if (current.kind !== "ok" || current.record.pid === pid) {
        fs.rmSync(filePath, { force: true });
      }
    },
  };
}

/** Take a suspected-stale lock aside, re-verify, drop only if still stale. */
function tryReclaimStale(
  filePath: string,
  isStale: (r: PidLockRecord | undefined) => boolean,
): boolean {
  const quarantine = `${filePath}.reclaim.${process.pid}.${randomUUID()}`;
  try {
    fs.renameSync(filePath, quarantine);
  } catch {
    // Another reclaimer won the race; nothing to drop.
    return false;
  }
  const taken = readSnapshot(quarantine);
  const record = taken.kind === "ok" ? taken.record : undefined;
  if (!isStale(record)) {
    try {
      fs.renameSync(quarantine, filePath);
    } catch {
      try {
        fs.linkSync(quarantine, filePath);
        fs.rmSync(quarantine, { force: true });
      } catch {
        // Path re-occupied; keep quarantine rather than destroy a live record.
      }
    }
    return false;
  }
  fs.rmSync(quarantine, { force: true });
  return true;
}

/**
 * Acquire `id` under `stateDir/.locks/`. Throws {@link PidLockBusyError} when a
 * live process holds it; reclaims locks whose owning PID is gone.
 */
export function acquirePidLock(
  stateDir: string,
  id: string,
  options: AcquirePidLockOptions = {},
): PidLockHandle {
  const pid = options.pid ?? process.pid;
  const alive = options.processAlive ?? pidIsAlive;
  const link = options.linkFile ?? fs.linkSync;
  const isStale = (record: PidLockRecord | undefined): boolean => !record || !alive(record.pid);
  const filePath = lockFile(stateDir, id);
  const payload = `${JSON.stringify({
    version: HISTORY_LOCK_VERSION,
    id,
    pid,
    acquiredAt: new Date().toISOString(),
  } satisfies PidLockRecord)}\n`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  for (let attempt = 1; ; attempt += 1) {
    const tempPath = `${filePath}.${pid}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, payload, "utf8");
      try {
        link(tempPath, filePath);
      } catch (error) {
        if (linkUnsupported(error)) {
          const fallback = publishExclusive(filePath, payload);
          if (fallback === "unsupported") return UNLOCKED_HANDLE;
          if (fallback === "published") return makeHandle(filePath, pid);
          // "exists" falls through to the reclaim path below.
        } else if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
          throw error;
        }
        const existing = readSnapshot(filePath);
        if (existing.kind === "ok" && !isStale(existing.record)) {
          throw new PidLockBusyError(id, existing.record.pid);
        }
        if (existing.kind !== "missing" && !tryReclaimStale(filePath, isStale)) {
          const holder = readSnapshot(filePath);
          if (holder.kind === "ok" && !isStale(holder.record)) {
            throw new PidLockBusyError(id, holder.record.pid);
          }
        }
        // Two attempts is enough: publish, or report the live holder.
        if (attempt >= 2) {
          const holder = readSnapshot(filePath);
          throw new PidLockBusyError(id, holder.kind === "ok" ? holder.record.pid : -1);
        }
        continue;
      }
      return makeHandle(filePath, pid);
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}
