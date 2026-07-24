// Shared open-tab set for multi-instance MixCode.
//
// Instance registry is per-process status (good for union discovery, bad for
// close: union never drops a tab while any peer still holds it). This file is
// the authoritative list of session ids that every live instance in the same
// workdir should keep open: create adds, close/delete removes, peers reconcile.
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { currentProcessIdentity, type ProcessIdentity } from "./instance-registry.js";

export const OPEN_TABS_VERSION = 1;

export interface OpenTabsSnapshot {
  version: typeof OPEN_TABS_VERSION;
  sessionIds: string[];
  updatedAt: string;
}

export function openTabsFile(scopedStateDir: string): string {
  return join(scopedStateDir, "open_tabs.json");
}

// Process-wide path for the interactive TUI. create/close helpers call
// noteTabOpened/noteTabClosed so they do not need the path threaded through
// every UI call site. Batch/tests leave this unset (no shared open-set writes).
let configuredOpenTabsPath: string | undefined;

export function configureOpenTabsPath(filePath: string | undefined): void {
  configuredOpenTabsPath = filePath;
}

export function getConfiguredOpenTabsPath(): string | undefined {
  return configuredOpenTabsPath;
}

/** Record a tab the user (or bootstrap) opened into the shared ordered list. */
export function noteTabOpened(sessionId: string, afterSessionId?: string): void {
  if (!configuredOpenTabsPath || !sessionId.trim()) return;
  if (afterSessionId) {
    addOpenTabAfter(configuredOpenTabsPath, sessionId, afterSessionId);
  } else {
    addOpenTab(configuredOpenTabsPath, sessionId);
  }
}

/** Record a tab the user closed/deleted so peers drop it too. */
export function noteTabClosed(sessionId: string): void {
  if (!configuredOpenTabsPath || !sessionId.trim()) return;
  removeOpenTab(configuredOpenTabsPath, sessionId);
}

/** Record a /clear session swap: replace old id in-place so tab stays at its position. */
export function noteTabReplaced(oldId: string, newId: string): void {
  if (!configuredOpenTabsPath) return;
  replaceOpenTab(configuredOpenTabsPath, oldId, newId);
}

/** Replace the shared set after a bulk workspace restore/reorder. */
export function noteTabsReplaced(sessionIds: Iterable<string>): void {
  if (!configuredOpenTabsPath) return;
  writeOpenTabs(configuredOpenTabsPath, sessionIds);
}

export function readOpenTabs(filePath: string): string[] {
  try {
    const raw = readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    const ids = (parsed as { sessionIds?: unknown }).sessionIds;
    if (!Array.isArray(ids)) return [];
    return [...new Set(ids.map(String).filter((id) => id.trim()))];
  } catch {
    return [];
  }
}

/** Replace the shared open-tab set. Used at bootstrap to seed from state children. */
export function writeOpenTabs(filePath: string, sessionIds: Iterable<string>): string[] {
  return mutateOpenTabs(filePath, (ids) => {
    ids.clear();
    for (const id of sessionIds) {
      if (id.trim()) ids.add(id);
    }
  });
}

export function addOpenTab(filePath: string, sessionId: string): string[] {
  if (!sessionId.trim()) return readOpenTabs(filePath);
  return mutateOpenTabs(filePath, (ids) => {
    ids.add(sessionId);
  });
}

/** Insert a tab immediately after its source (fork ordering). */
export function addOpenTabAfter(
  filePath: string,
  sessionId: string,
  afterSessionId: string,
): string[] {
  if (!sessionId.trim()) return readOpenTabs(filePath);
  return mutateOpenTabs(filePath, (ids) => {
    const ordered = [...ids].filter((id) => id !== sessionId);
    const sourceIndex = ordered.indexOf(afterSessionId);
    ordered.splice(sourceIndex >= 0 ? sourceIndex + 1 : ordered.length, 0, sessionId);
    ids.clear();
    for (const id of ordered) ids.add(id);
  });
}

/** Atomically replace an old session id with a new one at the same position (/clear). */
export function replaceOpenTab(filePath: string, oldId: string, newId: string): string[] {
  if (!newId.trim()) return readOpenTabs(filePath);
  return mutateOpenTabs(filePath, (ids) => {
    const ordered = [...ids];
    const idx = ordered.indexOf(oldId);
    if (idx >= 0) {
      ordered.splice(idx, 1, newId);
    } else {
      ordered.push(newId);
    }
    ids.clear();
    for (const id of ordered) ids.add(id);
  });
}

export function removeOpenTab(filePath: string, sessionId: string): string[] {
  if (!sessionId.trim()) return readOpenTabs(filePath);
  return mutateOpenTabs(filePath, (ids) => {
    ids.delete(sessionId);
  });
}

/**
 * Atomic read-modify-write under an exclusive lock file. Callers pass a mutator
 * that edits the in-memory set; the result is written back as open_tabs.json.
 */
export function mutateOpenTabs(
  filePath: string,
  mutator: (sessionIds: Set<string>) => void,
): string[] {
  return withOpenTabsLock(filePath, () => {
    const ids = new Set(readOpenTabs(filePath));
    mutator(ids);
    const sessionIds = [...ids];
    const snapshot: OpenTabsSnapshot = {
      version: OPEN_TABS_VERSION,
      sessionIds,
      updatedAt: new Date().toISOString(),
    };
    mkdirSync(dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    renameSync(temp, filePath);
    return sessionIds;
  });
}

interface OpenTabsLockRecord {
  pid: number;
  processStartTime?: string;
  processVerification: ProcessIdentity["verification"];
  acquiredAt: string;
}

/**
 * Exclusive lock for open_tabs read-modify-write.
 * Same ownership rule as session-lock: reclaim only when the holder PID is dead
 * or reused. Never steal after a wall-clock deadline — that races a live holder
 * and drops concurrent add/remove updates.
 */
function withOpenTabsLock<T>(filePath: string, fn: () => T): T {
  const lockPath = `${filePath}.lock`;
  mkdirSync(dirname(filePath), { recursive: true });
  const pid = process.pid;
  const identity = currentProcessIdentity(pid);
  const payload = `${JSON.stringify({
    pid,
    processStartTime: identity.startTime,
    processVerification: identity.verification,
    acquiredAt: new Date().toISOString(),
  } satisfies OpenTabsLockRecord)}\n`;

  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      try {
        writeSync(fd, payload);
        return fn();
      } finally {
        closeSync(fd);
        // Only remove if we still own it (another process may have reclaimed a
        // crash mid-write and replaced the record).
        const current = readOpenTabsLockRecord(lockPath);
        if (!current || current.pid === pid) {
          rmSync(lockPath, { force: true });
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") throw error;
      const existing = readOpenTabsLockRecord(lockPath);
      if (openTabsLockIsStale(existing)) {
        rmSync(lockPath, { force: true });
        continue;
      }
      // Live holder: yield without burning a core, then retry.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function readOpenTabsLockRecord(lockPath: string): OpenTabsLockRecord | undefined {
  try {
    const value = JSON.parse(readFileSync(lockPath, "utf8")) as Partial<OpenTabsLockRecord>;
    if (typeof value.pid !== "number") return undefined;
    return value as OpenTabsLockRecord;
  } catch {
    return undefined;
  }
}

function openTabsLockIsStale(record: OpenTabsLockRecord | undefined): boolean {
  if (!record) return true;
  const identity = currentProcessIdentity(record.pid);
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
