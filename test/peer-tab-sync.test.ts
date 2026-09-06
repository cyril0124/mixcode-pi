import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
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
  nextAvailableAgentTitle,
  openTabsFile,
  readOpenTabs,
  removeOpenTab,
  startPeerTabSync,
  writeOpenTabs,
} from "./helpers/mixcode.js";
import {
  closeExistingAgentTab,
  completeAgentTabClear,
  createAgentTab,
  openExistingAgentTab,
  prepareAgentTabClear,
} from "../src/ui/agent-tab-actions.js";
import { resumeSelectedSession } from "../src/ui/session-resume.js";

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
  assert.deepEqual(plan.toOpen, [{ sessionId: "new-one", title: "Peer New", workdir: "/repo" }]);
  assert.deepEqual(plan.desiredOrder, ["keep", "new-one"]);
});

// Regression: orphan open_tabs ids (no live peer registry title) must not get
// Agent-{uuid8} titles. openExistingAgentTab then assigns Agent-NN.
test("listTabsToReconcile without peer hints leaves title unset", () => {
  const sessionId = "019f757b-c2e7-7c4c-a306-e2bd80c2cc45";
  const plan = listTabsToReconcile({
    localSessionIds: [],
    desiredSessionIds: [sessionId],
    localWorkdir: "/repo",
  });
  assert.equal(plan.toOpen.length, 1);
  assert.deepEqual(plan.toOpen, [{ sessionId, workdir: "/repo" }]);
});

test("openExistingAgentTab without title uses sequential Agent-NN", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-peer-title-"));
  const sessionsRoot = path.join(dir, "sessions");
  const workdir = path.join(dir, "repo");
  const runtimeA = new MixCodeRuntime({ sessionsRoot });
  const runtimeB = new MixCodeRuntime({ sessionsRoot });
  try {
    const stateA = createInitialState(workdir);
    const created = await createAgentTab(stateA, runtimeA, {
      title: "From A",
      runtimeModel: MIXCODE_FAUX_MODEL,
    });

    const stateB = createInitialState(workdir);
    stateB.tabs.push(createTab(1, "local-keep", workdir, { title: "Agent-01" }));
    stateB.activeTabId = "home";
    const opened = await openExistingAgentTab(stateB, runtimeB, {
      sessionId: created.sessionId,
      workdir,
      runtimeModel: MIXCODE_FAUX_MODEL,
    });

    assert.equal(opened.sessionId, created.sessionId);
    assert.equal(opened.title, "Agent-02");
  } finally {
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs store add/remove is durable", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-tabs-"));
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("openExistingAgentTab opens disk session without stealing focus", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-peer-open-"));
  const sessionsRoot = path.join(dir, "sessions");
  const workdir = path.join(dir, "repo");
  const runtimeA = new MixCodeRuntime({ sessionsRoot });
  const runtimeB = new MixCodeRuntime({ sessionsRoot });
  try {
    const stateA = createInitialState(workdir);
    const created = await createAgentTab(stateA, runtimeA, {
      title: "From A",
      runtimeModel: MIXCODE_FAUX_MODEL,
    });

    const stateB = createInitialState(workdir);
    stateB.activeTabId = "home";
    const opened = await openExistingAgentTab(stateB, runtimeB, {
      sessionId: created.sessionId,
      title: "From A",
      workdir,
      runtimeModel: MIXCODE_FAUX_MODEL,
    });

    assert.equal(opened.sessionId, created.sessionId);
    assert.equal(stateB.activeTabId, "home");
    assert.ok(runtimeB.getTab(created.sessionId));
  } finally {
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("startPeerTabSync opens and closes against shared open_tabs", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-peer-sync-"));
  const sessionsRoot = path.join(dir, "sessions");
  const workdir = path.join(dir, "repo");
  const openTabsPath = openTabsFile(path.join(dir, "state"));
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
    stateB.activeTabId = "home";
    const opened: string[] = [];
    const closed: string[] = [];
    const orders: string[][] = [];
    const sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: path.join(dir, "root"),
      workdir,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => stateB.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        await openExistingAgentTab(stateB, runtimeB, {
          sessionId: candidate.sessionId,
          ...(candidate.title ? { title: candidate.title } : {}),
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
    });

    await sync.reconcileNow();
    assert.deepEqual(opened, [created.sessionId]);
    assert.equal(stateB.activeTabId, "home");
    assert.deepEqual(orders.at(-1), [created.sessionId]);
    // loadStatus empty → no peer title; production path must assign Agent-NN.
    const peerOpened = stateB.tabs.find((tab) => tab.sessionId === created.sessionId);
    assert.ok(peerOpened);
    assert.match(peerOpened.title, /^Agent-\d{2}$/);
    assert.doesNotMatch(peerOpened.title, /^Agent-[0-9a-f]{8}$/i);

    removeOpenTab(openTabsPath, created.sessionId);
    await sync.reconcileNow();
    assert.deepEqual(closed, [created.sessionId]);
    assert.equal(
      stateB.tabs.some((tab) => tab.sessionId === created.sessionId),
      false,
    );

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await runtimeA.closeAllTabs();
    await runtimeB.closeAllTabs();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("createAgentTab publishes open_tabs before create finishes so reconcile keeps the new tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-new-session-race-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
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
    };

    const closed: string[] = [];
    const reopened: string[] = [];
    const sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: path.join(dir, "root"),
      workdir: dir,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => state.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        reopened.push(candidate.sessionId);
        state.tabs.push(
          createTab(state.tabs.length + 1, candidate.sessionId, dir, {
            title: candidate.title ?? nextAvailableAgentTitle(state.tabs),
            status: "idle",
          }),
        );
      },
      closeTab: async (sessionId) => {
        closed.push(sessionId);
        await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      },
      loadStatus: async () => ({ instances: [] }),
    });

    const queuedStatuses: string[] = [];
    const createPromise = createAgentTab(state, runtime, {
      onQueued: (tab) => {
        queuedStatuses.push(tab.status);
      },
    });
    // Reconcile while createTab is still gated. Late noteTabOpened would lose the new id.
    const inFlight = state.tabs[state.tabs.length - 1]!;
    assert.equal(inFlight.status, "Not Ready");
    assert.deepEqual(queuedStatuses, ["Not Ready"]);
    await sync.reconcileNow();
    releaseCreate();
    const created = await createPromise;
    await sync.reconcileNow();

    assert.deepEqual(closed, [], "in-flight new tab must not be closed by peer reconcile");
    assert.equal(
      state.tabs.some((tab) => tab.sessionId === created.sessionId),
      true,
    );
    assert.equal(created.status, "idle");
    assert.match(created.title, /^Agent-\d{2}$/);
    // In-flight create must not be treated as missing and peer-reopened.
    assert.deepEqual(reopened, []);
    assert.ok(readOpenTabs(openTabsPath).includes(created.sessionId));
    assert.ok(runtimeTabs.has(created.sessionId));

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("reconcile does not close a tab created during the loadStatus await gap", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-peer-sync-gap-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    const state = createInitialState(dir);
    const existing = createTab(1, "keep-me", dir, { title: "Agent-01", status: "idle" });
    state.tabs.push(existing);
    state.activeTabId = existing.sessionId;
    writeOpenTabs(openTabsPath, [existing.sessionId]);

    // Gate runtime.createTab so the new tab has no runtime tab registered yet,
    // so runtime.closeTab throws "Unknown tab session" the way it does for a
    // real in-flight create.
    let releaseCreate!: () => void;
    const createGate = Promise.withResolvers<void>();
    releaseCreate = createGate.resolve;
    const runtimeTabs = new Map<string, { tab: { sessionId: string; title: string } }>([
      [existing.sessionId, { tab: existing }],
    ]);
    const runtime = {
      createTab: async (tab: { sessionId: string; title: string }) => {
        await createGate.promise;
        const rt = { tab };
        runtimeTabs.set(tab.sessionId, rt);
        return rt as never;
      },
      getTab: (id: string) => runtimeTabs.get(id),
      closeTab: async (id: string) => {
        if (!runtimeTabs.has(id)) throw new Error(`Unknown tab session: ${id}`);
        runtimeTabs.delete(id);
      },
    };

    const closed: string[] = [];
    const opened: string[] = [];
    let createPromise: Promise<{ sessionId: string }> | undefined;
    const sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: path.join(dir, "root"),
      workdir: dir,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => state.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        opened.push(candidate.sessionId);
        state.tabs.push(
          createTab(state.tabs.length + 1, candidate.sessionId, dir, {
            title: candidate.title ?? nextAvailableAgentTitle(state.tabs),
            status: "idle",
          }),
        );
      },
      closeTab: async (sessionId) => {
        closed.push(sessionId);
        await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      },
      // readDesired has already run, so open_tabs lacks the new id. During this
      // await, createAgentTab runs its synchronous publish+push and parks on the
      // runtime gate, exactly inside the gap between the two snapshots.
      loadStatus: async () => {
        createPromise = createAgentTab(state, runtime as never, { title: "batch-tab" });
        await Bun.sleep(20);
        return { instances: [] };
      },
    });

    await sync.reconcileNow();
    assert.ok(createPromise, "loadStatus must have started the concurrent create");
    releaseCreate();
    const created = await createPromise;
    await sync.reconcileNow();

    assert.deepEqual(closed, [], "tab created inside the hint-load gap must not be closed");
    assert.deepEqual(opened, []);
    assert.equal(
      state.tabs.some((tab) => tab.sessionId === created.sessionId),
      true,
      "created tab must stay in state.tabs",
    );
    assert.ok(readOpenTabs(openTabsPath).includes(created.sessionId));

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("createAgentTab rolls open_tabs back when createTab fails", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-new-session-rollback-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
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
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("completeAgentTabClear publishes open_tabs before session id swaps so reconcile keeps the title", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clear-race-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    const state = createInitialState(dir);
    const existing = createTab(1, "old-clear", dir, { title: "Agent-03", status: "idle" });
    state.tabs.push(existing);
    state.activeTabId = existing.sessionId;
    writeOpenTabs(openTabsPath, [existing.sessionId]);

    const runtimeTabs = new Map<
      string,
      {
        tab: { sessionId: string; title: string; index?: number };
        chat: unknown[];
        agentSession: { isStreaming: boolean; isBashRunning: boolean };
      }
    >([
      [
        existing.sessionId,
        {
          tab: existing,
          chat: [],
          agentSession: { isStreaming: false, isBashRunning: false },
        },
      ],
    ]);

    let reconcileDuringClear!: () => Promise<void>;
    let seenNewSessionId: string | undefined;
    const runtime = {
      getTab: (id: string) => runtimeTabs.get(id),
      clearTab: async (sessionId: string, options?: { newSessionId?: string }) => {
        const existingRt = runtimeTabs.get(sessionId);
        if (!existingRt) throw new Error(`Unknown tab session: ${sessionId}`);
        const tab = existingRt.tab as { sessionId: string; title: string; index: number };
        const targetId = options?.newSessionId;
        if (!targetId) throw new Error("clearTab requires newSessionId");
        seenNewSessionId = targetId;
        // Mirror runtime.clearTab: mutate the tab object's session id in place.
        tab.sessionId = targetId;
        tab.title = `Agent-${String(tab.index).padStart(2, "0")}`;
        runtimeTabs.delete(sessionId);
        const rt = {
          tab,
          chat: [] as unknown[],
          agentSession: { isStreaming: false, isBashRunning: false },
        };
        runtimeTabs.set(targetId, rt);
        // Race window: local id is new; open_tabs must already list it.
        await reconcileDuringClear();
        return rt as never;
      },
      closeTab: async (id: string) => {
        if (!runtimeTabs.has(id)) throw new Error(`Unknown tab session: ${id}`);
        runtimeTabs.delete(id);
      },
      clearTabChatProjection: (id: string) => {
        const rt = runtimeTabs.get(id);
        if (rt) rt.chat = [];
      },
    };

    const closed: string[] = [];
    const opened: Array<{ sessionId: string; title: string }> = [];
    const sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: path.join(dir, "root"),
      workdir: dir,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => state.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        opened.push({
          sessionId: candidate.sessionId,
          title: candidate.title ?? nextAvailableAgentTitle(state.tabs),
        });
        state.tabs.push(
          createTab(state.tabs.length + 1, candidate.sessionId, dir, {
            title: candidate.title ?? nextAvailableAgentTitle(state.tabs),
            status: "idle",
          }),
        );
      },
      closeTab: async (sessionId) => {
        closed.push(sessionId);
        await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      },
      loadStatus: async () => ({ instances: [] }),
    });
    reconcileDuringClear = () => sync.reconcileNow();

    const prepared = prepareAgentTabClear(state, runtime as never, existing.sessionId);
    const resultId = await completeAgentTabClear(state, runtime as never, prepared);
    await sync.reconcileNow();

    assert.ok(seenNewSessionId);
    assert.equal(resultId, seenNewSessionId);
    assert.deepEqual(closed, [], "in-flight clear must not close the tab via peer reconcile");
    assert.deepEqual(opened, [], "in-flight clear must not reopen with peer fallback title");
    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0]?.sessionId, seenNewSessionId);
    assert.equal(state.tabs[0]?.title, "Agent-01");
    assert.doesNotMatch(state.tabs[0]?.title ?? "", /^Agent-[0-9a-f]{8}$/i);
    assert.deepEqual(readOpenTabs(openTabsPath), [seenNewSessionId]);
    assert.ok(runtimeTabs.has(seenNewSessionId!));

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("prepareAgentTabClear rejects corrupt open_tabs before wiping the tab", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clear-corrupt-open-tabs-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    await fsPromises.mkdir(path.join(dir, "state"), { recursive: true });
    await fsPromises.writeFile(openTabsPath, '{"version":1,"sessionIds":[', "utf8");
    const state = createInitialState(dir);
    const tab = createTab(1, "keep-session", dir, { status: "idle", unreadDone: true });
    state.tabs.push(tab);
    state.activeTabId = tab.sessionId;
    let projectionClears = 0;
    const runtime = {
      getTab: () => ({
        agentSession: { isStreaming: false, isBashRunning: false },
      }),
      clearTabChatProjection: () => {
        projectionClears++;
      },
    };

    assert.throws(() => prepareAgentTabClear(state, runtime as never, tab.sessionId), SyntaxError);
    assert.equal(projectionClears, 0);
    assert.equal(tab.unreadDone, true);
    assert.equal(tab.sessionId, "keep-session");
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("clear restores local identity when shared rollback also fails", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-clear-rollback-failure-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    const state = createInitialState(dir);
    const tab = createTab(1, "old-session", dir, { status: "idle" });
    state.tabs.push(tab);
    state.activeTabId = tab.sessionId;
    writeOpenTabs(openTabsPath, [tab.sessionId]);
    const runtimeFailure = new Error("runtime clear failed");
    const runtime = {
      getTab: () => ({
        agentSession: { isStreaming: false, isBashRunning: false },
      }),
      clearTabChatProjection: () => undefined,
      clearTab: async () => {
        await fsPromises.writeFile(openTabsPath, '{"version":1,"sessionIds":[', "utf8");
        throw runtimeFailure;
      },
    };
    const prepared = prepareAgentTabClear(state, runtime as never, tab.sessionId);
    let caught: unknown;
    try {
      await completeAgentTabClear(state, runtime as never, prepared);
    } catch (error) {
      caught = error;
    }

    assert.ok(caught instanceof AggregateError);
    assert.equal(caught.errors[0], runtimeFailure);
    assert.ok(caught.errors[1] instanceof SyntaxError);
    assert.equal(tab.sessionId, "old-session");
    assert.equal(state.activeTabId, "old-session");
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("resume commits shared identity through the real runtime without losing its tab or title", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-resume-race-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const completed = Promise.withResolvers<void>();
  const runtime = new MixCodeRuntime({
    sessionsRoot: path.join(dir, "sessions"),
    agentDir: path.join(dir, "agent"),
    extensionFactories: [
      (pi) => {
        pi.on("session_start", async (event) => {
          if (event.reason !== "resume") return;
          entered.resolve();
          await release.promise;
        });
      },
    ],
  });
  let sync: ReturnType<typeof startPeerTabSync> | undefined;
  try {
    const state = createInitialState(dir);
    const existing = createTab(1, "old-last", dir, { title: "Agent-11", status: "idle" });
    state.tabs.push(existing);
    state.activeTabId = existing.sessionId;
    writeOpenTabs(openTabsPath, [existing.sessionId]);
    await runtime.createTab(existing, {
      workdir: dir,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
    const durableId = "durable-resume-id";
    const target = await runtime.forkSession(existing.sessionId, durableId);
    target.appendSessionInfo("implement-zen-mode");
    const sessionPath = target.getSessionFile()!;
    const closed: string[] = [];
    const opened: string[] = [];
    sync = startPeerTabSync({
      openTabsPath,
      rootStateDir: path.join(dir, "root"),
      workdir: dir,
      pollIntervalMs: 60_000,
      getLocalSessionIds: () => state.tabs.map((tab) => tab.sessionId),
      openTab: async (candidate) => {
        opened.push(candidate.sessionId);
        await openExistingAgentTab(state, runtime, {
          ...candidate,
          runtimeModel: MIXCODE_FAUX_MODEL,
        });
      },
      closeTab: async (sessionId) => {
        closed.push(sessionId);
        await closeExistingAgentTab(state, runtime, sessionId, { publishClose: false });
      },
      loadStatus: async () => ({ instances: [] }),
    });
    await sync.reconcileNow();
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => false,
      hideOverlay: () => undefined,
    };
    resumeSelectedSession(
      state,
      tui as never,
      sessionPath,
      "implement-zen-mode",
      null,
      runtime as never,
      () => {
        completed.resolve();
      },
    );
    await entered.promise;
    await sync.reconcileNow();
    release.resolve();
    await completed.promise;
    await sync.reconcileNow();
    assert.deepEqual(closed, [], "in-flight resume must not be closed by peer reconcile");
    assert.deepEqual(opened, [], "in-flight resume must not reopen with peer Agent-NN title");
    const resumed = state.tabs.find((tab) => tab.sessionId === durableId);
    assert.ok(resumed, "resumed tab must remain");
    assert.equal(resumed.title, "implement-zen-mode");
    assert.deepEqual(readOpenTabs(openTabsPath), [existing.sessionId, durableId]);
    assert.ok(runtime.getTab(durableId));
  } finally {
    release.resolve();
    sync?.dispose();
    configureOpenTabsPath(undefined);
    await runtime.closeAllTabs();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
