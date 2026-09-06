import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type TestContext, test } from "node:test";
import { openTabsFile, readOpenTabs, writeOpenTabs } from "../src/core/open-tabs-store.js";
import {
  type PeerTabCandidate,
  type StartPeerTabSyncOptions,
  startPeerTabSync,
} from "../src/core/peer-tab-sync.js";

async function fixture(t: TestContext) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-peer-reconcile-"));
  const file = openTabsFile(dir);
  writeOpenTabs(file, ["keep"]);
  const local = new Set(["keep"]);
  const opened: PeerTabCandidate[] = [];
  const closed: string[] = [];
  const orders: string[][] = [];
  const errors: unknown[] = [];
  let reads = 0;
  const hooks: {
    loadStatus: NonNullable<StartPeerTabSyncOptions["loadStatus"]>;
    open: (id: string) => Promise<void>;
    close: (id: string) => Promise<void>;
  } = {
    loadStatus: async () => ({ instances: [] }),
    open: async () => {},
    close: async () => {},
  };
  const started = Promise.withResolvers<void>();
  const sync = startPeerTabSync({
    openTabsPath: file,
    rootStateDir: dir,
    workdir: dir,
    pollIntervalMs: 60_000,
    getLocalSessionIds: () => local,
    readDesired: (filePath) => {
      reads++;
      return readOpenTabs(filePath);
    },
    loadStatus: (...args) => hooks.loadStatus(...args),
    openTab: async (candidate) => {
      opened.push(candidate);
      await hooks.open(candidate.sessionId);
      local.add(candidate.sessionId);
    },
    closeTab: async (id) => {
      closed.push(id);
      await hooks.close(id);
      local.delete(id);
    },
    reorderTabs: (ids) => {
      orders.push(ids);
      started.resolve();
    },
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    sync.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  });
  // Drain startup before measuring a single explicitly requested pass.
  await started.promise;
  await sync.reconcileNow();
  reads = 0;
  orders.length = 0;
  return { dir, file, local, opened, closed, orders, errors, hooks, sync, reads: () => reads };
}

test("reconcile snapshots desired and local after awaiting title hints", async (t) => {
  const f = await fixture(t);
  writeOpenTabs(f.file, ["keep", "obsolete"]);
  f.local.add("restore");
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.hooks.loadStatus = async () => {
    entered.resolve();
    await release.promise;
    return {
      instances: [
        {
          pid: 2,
          workdir: f.dir,
          tabs: [{ sessionId: "fresh", title: "Peer title", workdir: f.dir }],
        },
      ],
    };
  };
  const pass = f.sync.reconcileNow();
  await entered.promise;
  writeOpenTabs(f.file, ["keep", "restore", "created", "fresh"]);
  f.local.add("created");
  release.resolve();
  await pass;

  assert.deepEqual(f.opened, [{ sessionId: "fresh", title: "Peer title", workdir: f.dir }]);
  assert.deepEqual(f.closed, []);
  assert.deepEqual([...f.local], ["keep", "restore", "created", "fresh"]);
  assert.deepEqual(f.orders, [["keep", "restore", "created", "fresh"]]);
  assert.deepEqual(f.errors, []);
});

test("reconcile replaces pending desired IDs while an open is awaited", async (t) => {
  const f = await fixture(t);
  writeOpenTabs(f.file, ["keep", "opening", "obsolete"]);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  f.hooks.open = async (id) => {
    if (id === "opening") {
      entered.resolve();
      await release.promise;
    }
  };
  const pass = f.sync.reconcileNow();
  await entered.promise;
  writeOpenTabs(f.file, ["keep", "replacement"]);
  release.resolve();
  await pass;

  assert.deepEqual(
    f.opened.map((tab) => tab.sessionId),
    ["opening", "replacement"],
  );
  assert.deepEqual(f.closed, ["opening"]);
  assert.deepEqual([...f.local], ["keep", "replacement"]);
  assert.deepEqual(f.orders, [["keep", "replacement"]]);
  assert.equal(f.reads(), 4, "one initial read plus one per awaited mutation");
});

for (const change of ["restore desired", "remove local"] as const) {
  test(`reconcile drops a pending close after an awaited earlier close: ${change}`, async (t) => {
    const f = await fixture(t);
    f.local.add("first");
    f.local.add("pending");
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    f.hooks.close = async (id) => {
      if (id === "first") {
        entered.resolve();
        await release.promise;
      }
    };
    const pass = f.sync.reconcileNow();
    await entered.promise;
    if (change === "restore desired") writeOpenTabs(f.file, ["keep", "pending"]);
    else f.local.delete("pending");
    release.resolve();
    await pass;

    assert.deepEqual(f.closed, ["first"]);
    assert.deepEqual(f.opened, []);
    assert.deepEqual([...f.local], change === "restore desired" ? ["keep", "pending"] : ["keep"]);
    assert.deepEqual(f.orders, [readOpenTabs(f.file)]);
    assert.equal(f.reads(), 2);
  });
}

test("failed open and close are attempted once per pass and retried on the next pass", async (t) => {
  const f = await fixture(t);
  writeOpenTabs(f.file, ["keep", "missing", "good"]);
  f.local.add("stuck");
  f.local.add("drop");
  const openError = new Error("session unavailable");
  const closeError = new Error("close failed");
  let failedOpen = false;
  let failedClose = false;
  f.hooks.open = async (id) => {
    if (id === "missing" && !failedOpen) {
      failedOpen = true;
      throw openError;
    }
  };
  f.hooks.close = async (id) => {
    if (id === "stuck" && !failedClose) {
      failedClose = true;
      throw closeError;
    }
  };
  await f.sync.reconcileNow();

  assert.deepEqual(
    f.opened.map((tab) => tab.sessionId),
    ["missing", "good"],
  );
  assert.deepEqual(f.closed, ["stuck", "drop"]);
  assert.deepEqual(f.errors, [openError, closeError]);
  assert.deepEqual([...f.local], ["keep", "stuck", "good"]);

  await f.sync.reconcileNow();
  assert.deepEqual(
    f.opened.map((tab) => tab.sessionId),
    ["missing", "good", "missing"],
  );
  assert.deepEqual(f.closed, ["stuck", "drop", "stuck"]);
  assert.deepEqual([...f.local], ["keep", "good", "missing"]);
  assert.deepEqual(f.errors, [openError, closeError]);
});

test("idle reconciliation reads the desired list exactly once", async (t) => {
  const f = await fixture(t);
  await f.sync.reconcileNow();

  assert.equal(f.reads(), 1);
  assert.deepEqual(f.opened, []);
  assert.deepEqual(f.closed, []);
  assert.deepEqual(f.orders, [["keep"]]);
});
