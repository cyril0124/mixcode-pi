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
  createTab,
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

test("createAgentTab publishes open_tabs before create finishes so reconcile keeps the new tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-new-session-race-"));
  const openTabsPath = openTabsFile(join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    const state = createInitialState(dir);
    const existing = createTab(1, "old-last", dir, { title: "Agent-11", status: "idle" });
    state.tabs.push(existing);
    state.activeTabId = existing.sessionId;
    writeOpenTabs(openTabsPath, [existing.sessionId]);

    let releaseCreate!: () => void;
    const createGate = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const runtimeTabs = new Map<string, { tab: { sessionId: string; title: string } }>([
      [existing.sessionId, { tab: existing }],
    ]);
    const runtime = {
      createTab: async (tab: { sessionId: string; title: string }) => {
        await createGate;
        const rt = { tab };
        runtimeTabs.set(tab.sessionId, rt);
        return rt as never;
      },
      getTab: (id: string) => runtimeTabs.get(id),
      closeTab: async (id: string) => {
        if (!runtimeTabs.has(id)) throw new Error(`Unknown tab session: ${id}`);
        runtimeTabs.delete(id);
      },
      getSessionsRoot: () => dir,
    };

    const closed: string[] = [];
    const openedTitles: string[] = [];
    const sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: join(dir, "root"),
      workdir: dir,
      debounceMs: 1,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => state.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        openedTitles.push(candidate.title);
        state.tabs.push(
          createTab(state.tabs.length + 1, candidate.sessionId, dir, {
            title: candidate.title,
            status: "idle",
          }),
        );
      },
      closeTab: async (sessionId) => {
        closed.push(sessionId);
        await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      },
      loadStatus: async () => ({ instances: [] }),
      watchFactory: () => ({ close: () => undefined }),
    });

    const createPromise = createAgentTab(state, runtime);
    // Reconcile while createTab is still gated. Late noteTabOpened would lose the new id.
    await sync.reconcileNow();
    releaseCreate();
    const created = await createPromise;
    await sync.reconcileNow();

    assert.deepEqual(closed, [], "in-flight new tab must not be closed by peer reconcile");
    assert.equal(
      state.tabs.some((tab) => tab.sessionId === created.sessionId),
      true,
    );
    assert.match(created.title, /^Agent-\d{2}$/);
    assert.equal(
      openedTitles.some((title) => /^Agent-[0-9a-f]{8}$/i.test(title)),
      false,
    );
    assert.ok(readOpenTabs(openTabsPath).includes(created.sessionId));
    assert.ok(runtimeTabs.has(created.sessionId));

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("createAgentTab rolls open_tabs back when createTab fails", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-new-session-rollback-"));
  const openTabsPath = openTabsFile(join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    const state = createInitialState(dir);
    const existing = createTab(1, "old-last", dir, { title: "Agent-11", status: "idle" });
    state.tabs.push(existing);
    state.activeTabId = existing.sessionId;
    writeOpenTabs(openTabsPath, [existing.sessionId]);

    await assert.rejects(
      () =>
        createAgentTab(state, {
          createTab: async () => {
            throw new Error("create failed");
          },
        }),
      /create failed/,
    );

    assert.deepEqual(
      state.tabs.map((tab) => tab.sessionId),
      [existing.sessionId],
    );
    assert.equal(state.activeTabId, existing.sessionId);
    assert.deepEqual(readOpenTabs(openTabsPath), [existing.sessionId]);
  } finally {
    configureOpenTabsPath(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});
