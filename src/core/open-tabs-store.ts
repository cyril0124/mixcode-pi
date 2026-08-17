// Shared open-tab set for multi-instance MixCode.
//
// Instance registry is per-process status (good for union discovery, bad for
// close: union never drops a tab while any peer still holds it). This file is
// the authoritative list of session ids that every live instance in the same
// workdir should keep open: create adds, close/delete removes, peers reconcile.
import * as fs from "node:fs";
import * as path from "node:path";
import { currentProcessIdentity } from "./instance-registry.js";

export const OPEN_TABS_VERSION = 1;

export interface OpenTabsSnapshot {
  version: typeof OPEN_TABS_VERSION;
  sessionIds: string[];
  updatedAt: string;
}

export function openTabsFile(scopedStateDir: string): string {
  return path.join(scopedStateDir, "open_tabs.json");
}

// Process-wide path for the interactive TUI. create/close helpers call
// noteTabOpened/noteTabClosed so they do not need the path threaded through
// every UI call site. Batch/tests leave this unset (no shared open-set writes).
let configuredOpenTabsPath: string | undefined;

export function configureOpenTabsPath(filePath: string | undefined): void {
  configuredOpenTabsPath = filePath;
}

/** Fail before mutating runtime or UI state when the shared snapshot is unreadable. */
export function assertConfiguredOpenTabsReadable(): void {
  if (configuredOpenTabsPath) readOpenTabs(configuredOpenTabsPath);
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
  let raw: string;
  try {
    // Sync RMW lock path: keep sync fs (not Bun.file).
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid open tabs snapshot: ${filePath}`);
  }
  const snapshot = parsed as { version?: unknown; sessionIds?: unknown; updatedAt?: unknown };
  if (
    snapshot.version !== OPEN_TABS_VERSION ||
    !Array.isArray(snapshot.sessionIds) ||
    !snapshot.sessionIds.every((id) => typeof id === "string") ||
    typeof snapshot.updatedAt !== "string"
  ) {
    throw new Error(`Invalid open tabs snapshot: ${filePath}`);
  }
  return [...new Set(snapshot.sessionIds.filter((id) => id.trim()))];
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const temp = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temp, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
    fs.renameSync(temp, filePath);
    return sessionIds;
  });
}

interface OpenTabsLockRecord {
  pid: number;
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const pid = process.pid;
  const payload = `${JSON.stringify({
    pid,
    acquiredAt: new Date().toISOString(),
  } satisfies OpenTabsLockRecord)}\n`;

  for (;;) {
    // Publish fully-written lock via temp+linkSync (no empty-file window).
    // Reclaim stale locks via rename, not rm — concurrent rm reclaimers used to
    // delete each other's freshly published lock and dual-enter the CS.
    const tempPath = `${lockPath}.${pid}.${crypto.randomUUID()}.tmp`;
    try {
      fs.writeFileSync(tempPath, payload, "utf8");
      try {
        fs.linkSync(tempPath, lockPath);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST") throw error;
        // EEXIST then ENOENT: holder released — retry, do not reclaim (avoids
        // renaming away a lock published after our failed read).
        const existing = readOpenTabsLockSnapshot(lockPath);
        if (existing.kind === "missing") continue;
        if (existing.kind === "ok" && !openTabsLockIsStale(existing.record)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
          continue;
        }
        // Stale dead-pid record or corrupt content still on disk.
        if (!tryReclaimStaleOpenTabsLock(lockPath)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
        continue;
      }
      try {
        return fn();
      } finally {
        // Only remove if we still own it (another process may have reclaimed a
        // crash mid-section and replaced the record).
        const current = readOpenTabsLockRecord(lockPath);
        if (!current || current.pid === pid) {
          fs.rmSync(lockPath, { force: true });
        }
      }
    } finally {
      fs.rmSync(tempPath, { force: true });
    }
  }
}

/** Take a suspected-stale lock aside, re-verify, drop only if still stale. */
function tryReclaimStaleOpenTabsLock(lockPath: string): boolean {
  const quarantine = `${lockPath}.reclaim.${process.pid}.${crypto.randomUUID()}`;
  try {
    fs.renameSync(lockPath, quarantine);
  } catch {
    return false;
  }
  const taken = readOpenTabsLockRecord(quarantine);
  if (!openTabsLockIsStale(taken)) {
    try {
      fs.renameSync(quarantine, lockPath);
    } catch {
      try {
        fs.linkSync(quarantine, lockPath);
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

type OpenTabsLockSnapshot =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "ok"; record: OpenTabsLockRecord };

function readOpenTabsLockSnapshot(lockPath: string): OpenTabsLockSnapshot {
  try {
    const value = JSON.parse(fs.readFileSync(lockPath, "utf8")) as Partial<OpenTabsLockRecord>;
    if (typeof value.pid !== "number") return { kind: "invalid" };
    return { kind: "ok", record: value as OpenTabsLockRecord };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    return { kind: "invalid" };
  }
}

function readOpenTabsLockRecord(lockPath: string): OpenTabsLockRecord | undefined {
  const snap = readOpenTabsLockSnapshot(lockPath);
  return snap.kind === "ok" ? snap.record : undefined;
}

function openTabsLockIsStale(record: OpenTabsLockRecord | undefined): boolean {
  if (!record) return true;
  return !currentProcessIdentity(record.pid).alive;
}
