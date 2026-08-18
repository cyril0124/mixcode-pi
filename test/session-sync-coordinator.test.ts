import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { type FileFingerprint, SessionSyncCoordinator } from "./helpers/mixcode.js";

// A mutable fingerprint table keyed by absolute path; `bump` simulates a write.
function makeStatTable(): {
  stat: (filePath: string) => FileFingerprint | undefined;
  set: (fileName: string, fp: FileFingerprint) => void;
} {
  const table = new Map<string, FileFingerprint>();
  return {
    stat: (filePath) => {
      // Coordinator passes join(root, fileName); match on the basename tail.
      for (const [name, fp] of table) if (filePath.endsWith(name)) return fp;
      return undefined;
    },
    set: (fileName, fp) => table.set(fileName, fp),
  };
}

// 1ms poll so tests observe a few ticks within a short sleep.
// Poll ticks faster than the debounce so the debounce can fire between ticks.
const POLL_MS = 10;

// Wait for a condition instead of a fixed sleep: under full-suite load the
// event loop can starve short timers, so fixed sleeps flake. On timeout we
// fall through and let the assertion report the actual state.
async function waitFor(cond: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < timeoutMs) await Bun.sleep(5);
}

test("a real fingerprint change triggers exactly one debounced reload", async () => {
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    statFingerprint: stat.stat,
    debounceMs: 5,
    pollIntervalMs: POLL_MS,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");

  // External append: size + mtime grow. Many poll ticks see the new state.
  stat.set("a.jsonl", { size: 40, mtimeMs: 200 });
  await waitFor(() => changed.length >= 1);
  // Grace window for a duplicate fire; stretches under load, which only
  // widens duplicate detection.
  await Bun.sleep(30);
  assert.deepEqual(changed, ["sa"], "burst of ticks collapses to one reload");
  coord.dispose();
});

test("multiple registered sessions are all polled", async () => {
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    statFingerprint: stat.stat,
    debounceMs: 0,
    pollIntervalMs: POLL_MS,
  });
  stat.set("a.jsonl", { size: 1, mtimeMs: 1 });
  stat.set("b.jsonl", { size: 1, mtimeMs: 1 });
  coord.register("sa", "/root/a.jsonl");
  coord.register("sb", "/root/b.jsonl");

  stat.set("a.jsonl", { size: 2, mtimeMs: 2 });
  stat.set("b.jsonl", { size: 2, mtimeMs: 2 });
  await waitFor(() => changed.length >= 2);
  assert.deepEqual(changed.sort(), ["sa", "sb"]);
  coord.dispose();
});

test("same size and mtime with replaced content still reloads", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-session-sync-replace-"));
  const sessionPath = path.join(dir, "a.jsonl");
  const replacementPath = path.join(dir, "replacement.jsonl");
  const fixedTime = new Date("2026-01-01T00:00:00.000Z");
  const changed: string[] = [];
  try {
    await fsPromises.writeFile(sessionPath, "old\n", "utf8");
    await fsPromises.utimes(sessionPath, fixedTime, fixedTime);
    const coord = new SessionSyncCoordinator({
      sessionsRoot: dir,
      onExternalChange: (id) => changed.push(id),
      debounceMs: 5,
      pollIntervalMs: POLL_MS,
    });
    coord.register("sa", sessionPath);

    await fsPromises.writeFile(replacementPath, "new\n", "utf8");
    await fsPromises.utimes(replacementPath, fixedTime, fixedTime);
    await fsPromises.rename(replacementPath, sessionPath);
    await waitFor(() => changed.length >= 1);
    assert.deepEqual(changed, ["sa"]);
    coord.dispose();
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("poll ticks with an unchanged fingerprint do not reload", async () => {
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    statFingerprint: stat.stat,
    debounceMs: 5,
    pollIntervalMs: POLL_MS,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  // Same fingerprint -> not a real change.
  await Bun.sleep(20);
  assert.deepEqual(changed, []);
  coord.dispose();
});

test("markLocalWrite suppresses the echo reload of our own write", async () => {
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    statFingerprint: stat.stat,
    debounceMs: 5,
    pollIntervalMs: POLL_MS,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  // Local write grows the file; we record it BEFORE a poll tick sees it.
  stat.set("a.jsonl", { size: 30, mtimeMs: 300 });
  coord.markLocalWrite("sa");
  await Bun.sleep(20);
  assert.deepEqual(changed, [], "our own write must not echo back as a reload");
  coord.dispose();
});

test("unregister stops reloads and clears pending timers", async () => {
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    statFingerprint: stat.stat,
    debounceMs: 20,
    pollIntervalMs: POLL_MS,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  stat.set("a.jsonl", { size: 20, mtimeMs: 200 });
  await Bun.sleep(15); // a tick schedules the debounced reload
  coord.unregister("sa"); // ...which must be cancelled
  await Bun.sleep(40);
  assert.deepEqual(changed, []);
  coord.dispose();
});

test("dispose stops polling so no reloads fire after shutdown", async () => {
  const stat = makeStatTable();
  const changed: string[] = [];
  const coord = new SessionSyncCoordinator({
    sessionsRoot: "/root",
    onExternalChange: (id) => changed.push(id),
    statFingerprint: stat.stat,
    debounceMs: 5,
    pollIntervalMs: POLL_MS,
  });
  stat.set("a.jsonl", { size: 10, mtimeMs: 100 });
  coord.register("sa", "/root/a.jsonl");
  coord.dispose();
  stat.set("a.jsonl", { size: 20, mtimeMs: 200 });
  await Bun.sleep(20);
  assert.deepEqual(changed, []);
});
