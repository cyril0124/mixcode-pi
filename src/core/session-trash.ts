import * as fs from "node:fs/promises";
import * as path from "node:path";
import { trashDir, trashIndexPath } from "./paths.js";

export type TrashEntry = {
  sessionId: string;
  title: string;
  deletedAt: string; // ISO 8601
  originalPath: string;
  trashPath: string;
  size: number; // bytes
};

// 2 GB total trash size limit. Oldest entries are evicted first when exceeded.
const TRASH_SIZE_LIMIT_BYTES = 2 * 1024 * 1024 * 1024;

/**
 * Move a session file to the trash directory and record it in the trash index.
 * Enforces the 2 GB size limit after adding the entry (FIFO eviction by
 * deletedAt). Safe to call across filesystems: falls back to copy+unlink when
 * rename returns EXDEV.
 */
export async function moveToTrash(
  file: string,
  meta: { sessionId: string; title: string },
): Promise<void> {
  const dir = trashDir();
  await fs.mkdir(dir, { recursive: true });

  const trashPath = path.join(dir, `${meta.sessionId}.jsonl`);
  const size = Bun.file(file).size;

  try {
    await fs.rename(file, trashPath);
  } catch (err) {
    // Cross-device rename: copy then delete the source.
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(file, trashPath);
    await fs.unlink(file);
  }

  const entry: TrashEntry = {
    sessionId: meta.sessionId,
    title: meta.title,
    deletedAt: new Date().toISOString(),
    originalPath: file,
    trashPath,
    size,
  };

  const existing = await readIndexText();
  await Bun.write(trashIndexPath(), existing + JSON.stringify(entry) + "\n");

  await enforceTrashSizeLimit();
}

/**
 * List trashed sessions, newest first.
 */
export async function listTrash(): Promise<TrashEntry[]> {
  const entries = await readIndex();
  return entries
    .slice()
    .sort((a, b) => new Date(b.deletedAt).getTime() - new Date(a.deletedAt).getTime());
}

/**
 * Restore a trashed session by sessionId. The session file is moved back to
 * its originalPath (parent directory is created if needed) and the entry is
 * removed from the index.
 * Throws if no entry with that sessionId exists in the trash.
 */
export async function restoreFromTrash(sessionId: string): Promise<TrashEntry> {
  const entries = await readIndex();
  const idx = entries.findIndex((e) => e.sessionId === sessionId);
  if (idx === -1) throw new Error(`Session ${sessionId} not found in trash`);

  const entry = entries[idx]!;
  await fs.mkdir(path.dirname(entry.originalPath), { recursive: true });

  try {
    await fs.rename(entry.trashPath, entry.originalPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EXDEV") throw err;
    await fs.copyFile(entry.trashPath, entry.originalPath);
    await fs.unlink(entry.trashPath);
  }

  const remaining = entries.filter((_, i) => i !== idx);
  await writeIndex(remaining);
  return entry;
}

async function enforceTrashSizeLimit(): Promise<void> {
  const entries = await readIndex();
  // Sort oldest first for eviction.
  const sorted = entries
    .slice()
    .sort((a, b) => new Date(a.deletedAt).getTime() - new Date(b.deletedAt).getTime());

  let totalSize = sorted.reduce((sum, e) => sum + e.size, 0);
  const evicted: string[] = [];

  for (const entry of sorted) {
    if (totalSize <= TRASH_SIZE_LIMIT_BYTES) break;
    evicted.push(entry.sessionId);
    totalSize -= entry.size;
    // Best-effort delete; ignore ENOENT (already gone).
    await Bun.file(entry.trashPath)
      .unlink()
      .catch((err: unknown) => {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      });
  }

  if (evicted.length > 0) {
    const remaining = entries.filter((e) => !evicted.includes(e.sessionId));
    await writeIndex(remaining);
  }
}

async function readIndexText(): Promise<string> {
  try {
    return await Bun.file(trashIndexPath()).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw err;
  }
}

async function readIndex(): Promise<TrashEntry[]> {
  const text = await readIndexText();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as TrashEntry);
}

async function writeIndex(entries: TrashEntry[]): Promise<void> {
  const text = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : "");
  await Bun.write(trashIndexPath(), text);
}
