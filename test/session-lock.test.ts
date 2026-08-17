import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  acquireSessionTurnLock,
  SessionLockConflictError,
  sessionLockDir,
} from "../src/index.js";

const LIVE = { alive: true };

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-lock-"));
  try {
    await fn(root);
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
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
      pid === 999 ? { alive: false } : LIVE;
    const reclaimed = acquireSessionTurnLock(root, "s1", { pid: 200, processInfo });
    assert.throws(
      () => acquireSessionTurnLock(root, "s1", { pid: 300, processInfo }),
      SessionLockConflictError,
    );
    reclaimed.release();
  });
});

test("a corrupt lock file is treated as stale", async () => {
  await withRoot(async (root) => {
    const dir = sessionLockDir(root);
    await fsPromises.rm(dir, { recursive: true, force: true });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await fsPromises.writeFile(path.join(dir, "s1.lock"), "{ not json", "utf8");
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
    const before = await fsPromises.readdir(sessionLockDir(root));
    assert.deepEqual(before, ["s1.lock"]);
    handle.release();
    assert.equal(fs.existsSync(path.join(sessionLockDir(root), "s1.lock")), false);
    // Double release is a no-op.
    handle.release();
  });
});

test("successful acquire never leaves an empty lock file", async () => {
  await withRoot(async (root) => {
    const handle = acquireSessionTurnLock(root, "s1", { pid: 100, processInfo: () => LIVE });
    const raw = await import("node:fs/promises").then((fs) =>
      fs.readFile(path.join(sessionLockDir(root), "s1.lock"), "utf8"),
    );
    assert.ok(raw.trim().length > 0, "lock path must not be empty after acquire");
    const parsed = JSON.parse(raw) as { pid?: number };
    assert.equal(parsed.pid, 100);
    handle.release();
  });
});

test("concurrent acquires never overlap the critical section", async () => {
  await withRoot(async (root) => {
    const { spawn } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const workerPath = path.join(root, "worker.mjs");
    // Worker uses the same module under test; log IN/OUT around the held section.
    await writeFile(
      workerPath,
      `
import * as fs from "node:fs";
import { acquireSessionTurnLock } from ${JSON.stringify(new URL("../src/core/session-lock.ts", import.meta.url).pathname)};
const root = process.argv[2];
const log = process.argv[3];
const endAt = Date.now() + 1500;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
while (Date.now() < endAt) {
  try {
    const h = acquireSessionTurnLock(root, "s1");
    fs.appendFileSync(log, "IN " + process.pid + "\\n");
    sleep(1);
    fs.appendFileSync(log, "OUT " + process.pid + "\\n");
    h.release();
  } catch {}
}
`,
    );
    const logPath = path.join(root, "cs.log");
    const kids = Array.from({ length: 6 }, () =>
      spawn(process.execPath, [workerPath, root, logPath], { stdio: "ignore" }),
    );
    await Promise.all(kids.map((c) => new Promise<void>((r) => c.on("exit", () => r()))));
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(logPath)) {
      assert.fail("workers produced no CS log");
    }
    let depth = 0;
    let maxDepth = 0;
    for (const line of readFileSync(logPath, "utf8").split("\n")) {
      if (line.startsWith("IN ")) {
        depth += 1;
        if (depth > maxDepth) maxDepth = depth;
      } else if (line.startsWith("OUT ")) {
        depth = Math.max(0, depth - 1);
      }
    }
    assert.equal(maxDepth, 1, `lock must serialize CS, maxDepth=${maxDepth}`);
  });
});
