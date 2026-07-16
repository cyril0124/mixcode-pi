import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  addOpenTab,
  addOpenTabAfter,
  configureOpenTabsPath,
  replaceOpenTab,
  createInitialState,
  listTabsToReconcile,
  openTabsFile,
  readOpenTabs,
  removeOpenTab,
  startPeerTabSync,
  writeOpenTabs,
} from "../src/index.js";
import {
  closeExistingAgentTab,
  createAgentTab,
  openExistingAgentTab,
} from "../src/ui/agent-tab-actions.js";

test("listTabsToReconcile opens missing and closes extras", () => {
  const plan = listTabsToReconcile({
    localSessionIds: ["keep", "drop-me"],
    desiredSessionIds: ["keep", "new-one"],
    localWorkdir: "/repo",
    peerHints: [
      {
        pid: 2,
        workdir: "/repo",
        tabs: [{ sessionId: "new-one", title: "Peer New", workdir: "/repo" }],
      },
    ],
  });
  assert.deepEqual(plan.toClose, ["drop-me"]);
  assert.deepEqual(plan.toOpen, [
    { sessionId: "new-one", title: "Peer New", workdir: "/repo", peerPid: 2 },
  ]);
  assert.deepEqual(plan.desiredOrder, ["keep", "new-one"]);
});

test("open_tabs store add/remove is durable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-open-tabs-"));
  try {
    const file = openTabsFile(dir);
    writeOpenTabs(file, ["a", "tail"]);
    addOpenTab(file, "b");
    assert.deepEqual(readOpenTabs(file), ["a", "tail", "b"]);
    addOpenTabAfter(file, "fork", "a");
    assert.deepEqual(readOpenTabs(file), ["a", "fork", "tail", "b"]);
    // /clear: replace in-place keeps position
    replaceOpenTab(file, "tail", "tail-new");
    assert.deepEqual(readOpenTabs(file), ["a", "fork", "tail-new", "b"]);
    removeOpenTab(file, "a");
    assert.deepEqual(readOpenTabs(file), ["fork", "tail-new", "b"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("openExistingAgentTab opens disk session without stealing focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-peer-open-"));
  const sessionsRoot = join(dir, "sessions");
  const workdir = join(dir, "repo");
  const runtimeA = new MixCodeRuntime({ sessionsRoot });
  const runtimeB = new MixCodeRuntime({ sessionsRoot });
  try {
    const stateA = createInitialState(workdir);
    const created = await createAgentTab(stateA, runtimeA, {
      title: "From A",
      runtimeModel: MIXCODE_FAUX_MODEL,
    });

    const stateB = createInitialState(workdir);
    stateB.activeTabId = "config";
    const opened = await openExistingAgentTab(stateB, runtimeB, {
      sessionId: created.sessionId,
      title: "From A",
      workdir,
      runtimeModel: MIXCODE_FAUX_MODEL,
    });

    assert.equal(opened.sessionId, created.sessionId);
    assert.equal(stateB.activeTabId, "config");
    assert.ok(runtimeB.getTab(created.sessionId));
  } finally {
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});

test("startPeerTabSync opens and closes against shared open_tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-peer-sync-"));
  const sessionsRoot = join(dir, "sessions");
  const workdir = join(dir, "repo");
  const openTabsPath = openTabsFile(join(dir, "state"));
  const runtimeA = new MixCodeRuntime({ sessionsRoot });
  const runtimeB = new MixCodeRuntime({ sessionsRoot });
  runtimeB.enableSessionSync();
  configureOpenTabsPath(openTabsPath);
  try {
    const stateA = createInitialState(workdir);
    const created = await createAgentTab(stateA, runtimeA, {
      title: "Peer Tab",
      runtimeModel: MIXCODE_FAUX_MODEL,
    });
    // createAgentTab notes open via configureOpenTabsPath
    assert.ok(readOpenTabs(openTabsPath).includes(created.sessionId));

    const stateB = createInitialState(workdir);
    stateB.activeTabId = "config";
    const opened: string[] = [];
    const closed: string[] = [];
    const orders: string[][] = [];
    const sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: join(dir, "root"),
      workdir,
      selfPid: 2002,
      debounceMs: 1,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => stateB.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        await openExistingAgentTab(stateB, runtimeB, {
          sessionId: candidate.sessionId,
          title: candidate.title,
          workdir: candidate.workdir,
          runtimeModel: MIXCODE_FAUX_MODEL,
        });
        opened.push(candidate.sessionId);
      },
      closeTab: async (sessionId) => {
        await closeExistingAgentTab(stateB, runtimeB, sessionId, { publishClose: false });
        closed.push(sessionId);
      },
      reorderTabs: (sessionIds) => {
        orders.push([...sessionIds]);
      },
      loadStatus: async () => ({ instances: [] }),
      watchFactory: () => ({ close: () => undefined }),
    });

    await sync.reconcileNow();
    assert.deepEqual(opened, [created.sessionId]);
    assert.equal(stateB.activeTabId, "config");
    assert.deepEqual(orders.at(-1), [created.sessionId]);

    removeOpenTab(openTabsPath, created.sessionId);
    await sync.reconcileNow();
    assert.deepEqual(closed, [created.sessionId]);
    assert.equal(stateB.tabs.some((tab) => tab.sessionId === created.sessionId), false);

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await rm(dir, { recursive: true, force: true });
  }
});
