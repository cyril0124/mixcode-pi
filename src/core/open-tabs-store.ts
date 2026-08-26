// Shared open-tab set for multi-instance MixCode.
//
// Instance registry is per-process status (good for union discovery, bad for
// close: union never drops a tab while any peer still holds it). This file is
// the authoritative list of session ids that every live instance in the same
// workdir should keep open: create adds, close/delete removes, peers reconcile.
import * as fs from "node:fs";
import * as path from "node:path";
import { currentProcessIdentity } from "./instance-registry.js";
import { acquirePidFileLock } from "./pid-file-lock.js";

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
}

function parseOpenTabsLockRecord(raw: string): OpenTabsLockRecord | undefined {
  try {
    const value = JSON.parse(raw) as Partial<OpenTabsLockRecord>;
    if (typeof value.pid !== "number") return undefined;
    return value as OpenTabsLockRecord;
  } catch {
    return undefined;
  }
}

/** Exclusive lock for open_tabs RMW. Reclaim only when the holder PID is dead. */
function withOpenTabsLock<T>(filePath: string, fn: () => T): T {
  const lock = acquirePidFileLock({
    lockPath: `${filePath}.lock`,
    payload: `${JSON.stringify({
      pid: process.pid,
    } satisfies OpenTabsLockRecord)}\n`,
    parseRecord: parseOpenTabsLockRecord,
    isStale: (record) => !record || !currentProcessIdentity(record.pid).alive,
    onBusy: () => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    },
  });
  try {
    return fn();
  } finally {
    lock.release();
  }
}
