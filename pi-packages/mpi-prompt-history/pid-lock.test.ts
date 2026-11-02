import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { test } from "node:test";
import { acquirePidLock, PidLockBusyError } from "./pid-lock.js";

async function tempDir(label: string): Promise<string> {
  return fsPromises.mkdtemp(nodePath.join(os.tmpdir(), `mpi-pid-lock-${label}-`));
}

/** link(2) refused the way FUSE-backed phone storage refuses it. */
function rejectLink(): void {
  throw Object.assign(new Error("EPERM: operation not permitted, link"), { code: "EPERM" });
}

test("lock works on a filesystem without link(2)", async () => {
  const dir = await tempDir("exclusive");
  const lockPath = nodePath.join(dir, ".locks", "demo.lock");
  const locked = { linkFile: rejectLink };
  try {
    const handle = acquirePidLock(dir, "demo", locked);
    const record = JSON.parse(await fsPromises.readFile(lockPath, "utf8")) as {
      id: string;
      pid: number;
    };
    assert.deepEqual([record.id, record.pid], ["demo", process.pid]);

    assert.throws(
      () => acquirePidLock(dir, "demo", locked),
      (error: unknown) => error instanceof PidLockBusyError && error.holderPid === process.pid,
      "a second process must still see the lock as taken",
    );

    handle.release();
    await assert.rejects(fsPromises.stat(lockPath), /ENOENT/);

    // A crashed run leaves its lock behind; the next acquire must take it over.
    await fsPromises.writeFile(
      lockPath,
      `${JSON.stringify({ version: 1, id: "demo", pid: 999_999_999, acquiredAt: "2024-01-01T00:00:00.000Z" })}\n`,
    );
    acquirePidLock(dir, "demo", locked).release();
    await assert.rejects(fsPromises.stat(lockPath), /ENOENT/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
