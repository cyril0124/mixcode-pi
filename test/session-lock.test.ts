import assert from "node:assert/strict";
import { mkdtemp, rm, readdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  acquireSessionTurnLock,
  SessionLockConflictError,
  sessionLockDir,
} from "../src/index.js";

const LIVE = { alive: true, startTime: "111", verification: "linux-start-time" as const };

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "mixcode-lock-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("second acquire on a live-held session throws a conflict", async () => {
  await withRoot(async (root) => {
    const processInfo = () => LIVE;
    const held = acquireSessionTurnLock(root, "s1", { pid: 100, processInfo });
    assert.throws(
      () => acquireSessionTurnLock(root, "s1", { pid: 200, processInfo }),
      (error: unknown) => {
        assert.ok(error instanceof SessionLockConflictError);
        assert.equal(error.holderPid, 100);
        return true;
      },
    );
    held.release();
    // After release the lock is free again.
    const reacquired = acquireSessionTurnLock(root, "s1", { pid: 200, processInfo });
    reacquired.release();
  });
});

test("a different session is not blocked by another session's lock", async () => {
  await withRoot(async (root) => {
    const processInfo = () => LIVE;
    const a = acquireSessionTurnLock(root, "sA", { pid: 100, processInfo });
    const b = acquireSessionTurnLock(root, "sB", { pid: 100, processInfo });
    assert.notEqual(a, b);
    a.release();
    b.release();
    // Both sessions free again after independent release.
    const a2 = acquireSessionTurnLock(root, "sA", { pid: 200, processInfo });
    const b2 = acquireSessionTurnLock(root, "sB", { pid: 200, processInfo });
    a2.release();
    b2.release();
  });
});

test("a dead owner's stale lock is reclaimed", async () => {
  await withRoot(async (root) => {
    acquireSessionTurnLock(root, "s1", {
      pid: 999,
      processInfo: () => LIVE,
    }); // never released — simulates a crash
    // A new process sees pid 999 as dead and reclaims the lock.
    const processInfo = (pid: number) =>
      pid === 999 ? { alive: false, verification: "pid-only" as const } : LIVE;
    const reclaimed = acquireSessionTurnLock(root, "s1", { pid: 200, processInfo });
    assert.throws(
      () => acquireSessionTurnLock(root, "s1", { pid: 300, processInfo }),
      SessionLockConflictError,
    );
    reclaimed.release();
  });
});

test("PID reuse (start-time mismatch) is treated as stale, not a live holder", async () => {
  await withRoot(async (root) => {
    // Owner recorded start time "111"; the same PID now reports "222" -> reused.
    acquireSessionTurnLock(root, "s1", {
      pid: 500,
      processInfo: () => ({ alive: true, startTime: "111", verification: "linux-start-time" }),
    });
    const processInfo = (pid: number) =>
      pid === 500
        ? { alive: true, startTime: "222", verification: "linux-start-time" as const }
        : LIVE;
    const reclaimed = acquireSessionTurnLock(root, "s1", { pid: 600, processInfo });
    assert.throws(
      () => acquireSessionTurnLock(root, "s1", { pid: 700, processInfo }),
      SessionLockConflictError,
    );
    reclaimed.release();
  });
});

test("a corrupt lock file is treated as stale", async () => {
  await withRoot(async (root) => {
    const dir = sessionLockDir(root);
    await rm(dir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "s1.lock"), "{ not json", "utf8");
    const handle = acquireSessionTurnLock(root, "s1", { pid: 100, processInfo: () => LIVE });
    assert.throws(
      () => acquireSessionTurnLock(root, "s1", { pid: 200, processInfo: () => LIVE }),
      SessionLockConflictError,
    );
    handle.release();
  });
});

test("release removes the lock file", async () => {
  await withRoot(async (root) => {
    const handle = acquireSessionTurnLock(root, "s1", { pid: 100, processInfo: () => LIVE });
    const before = await readdir(sessionLockDir(root));
    assert.deepEqual(before, ["s1.lock"]);
    handle.release();
    assert.equal(existsSync(join(sessionLockDir(root), "s1.lock")), false);
    // Double release is a no-op.
    handle.release();
  });
});
