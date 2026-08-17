// Shared NFS-safe PID file lock: temp write + linkSync publish, rename reclaim.
// Callers choose busy policy (throw vs wait) and lock record shape.
import * as fs from "node:fs";
import * as path from "node:path";

export type PidLockSnapshot<T> =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; record: T };

export function readPidLockSnapshot<T>(
  filePath: string,
  parseRecord: (raw: string) => T | undefined,
): PidLockSnapshot<T> {
  try {
    const record = parseRecord(fs.readFileSync(filePath, "utf8"));
    return record ? { kind: "ok", record } : { kind: "invalid" };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

/** Take a suspected-stale lock aside, re-verify, drop only if still stale. */
export function tryReclaimStalePidLock<T>(
  filePath: string,
  parseRecord: (raw: string) => T | undefined,
  isStale: (record: T | undefined) => boolean,
): boolean {
  const quarantine = `${filePath}.reclaim.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(filePath, quarantine);
  } catch {
    return false;
  }
  const taken = readPidLockSnapshot(quarantine, parseRecord);
  const record = taken.kind === "ok" ? taken.record : undefined;
  if (!isStale(record)) {
    try {
      fs.renameSync(quarantine, filePath);
    } catch {
      try {
        fs.linkSync(quarantine, filePath);
        fs.rmSync(quarantine, { force: true });
      } catch {
        // Path occupied; keep quarantine rather than destroy a live record.
      }
    }
    return false;
  }
  fs.rmSync(quarantine, { force: true });
  return true;
}

export interface AcquirePidFileLockOptions<T extends { pid: number }> {
  lockPath: string;
  payload: string;
  pid?: number;
  parseRecord: (raw: string) => T | undefined;
  isStale: (record: T | undefined) => boolean;
  /** Live holder exists. Throw to abort, or return to retry. */
  onBusy: (holderPid: number) => void;
  maxAttempts?: number;
}

/**
 * Publish a lock via temp+linkSync so the path never appears empty.
 * Reclaim stale locks via rename (not rm) so two reclaimers cannot delete
 * each other's freshly published lock.
 */
export function acquirePidFileLock<T extends { pid: number }>(
  options: AcquirePidFileLockOptions<T>,
): { release(): void } {
  const pid = options.pid ?? process.pid;
  const { lockPath, payload, parseRecord, isStale, onBusy, maxAttempts } = options;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  for (let attempt = 1; ; attempt += 1) {
    const tempPath = `${lockPath}.${pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, payload, "utf8");
      try {
        fs.linkSync(tempPath, lockPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const existing = readPidLockSnapshot(lockPath, parseRecord);
        if (existing.kind === "missing") {
          // Holder released — retry, do not reclaim (avoids stealing a new lock).
        } else if (existing.kind === "ok" && !isStale(existing.record)) {
          onBusy(existing.record.pid);
        } else if (!tryReclaimStalePidLock(lockPath, parseRecord, isStale)) {
          const holder = readPidLockSnapshot(lockPath, parseRecord);
          if (holder.kind === "ok" && !isStale(holder.record)) {
            onBusy(holder.record.pid);
          }
        }
        if (maxAttempts !== undefined && attempt >= maxAttempts) {
          const holder = readPidLockSnapshot(lockPath, parseRecord);
          onBusy(holder.kind === "ok" ? holder.record.pid : -1);
        }
        continue;
      }
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          const current = readPidLockSnapshot(lockPath, parseRecord);
          if (current.kind !== "ok" || current.record.pid === pid) {
            fs.rmSync(lockPath, { force: true });
          }
        },
      };
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}
