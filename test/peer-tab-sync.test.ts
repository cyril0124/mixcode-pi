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
  createSessionSelectorState,
  createTab,
  listTabsToReconcile,
  nextAvailableAgentTitle,
  openTabsFile,
  readOpenTabs,
  removeOpenTab,
  startPeerTabSync,
  writeOpenTabs,
} from "./helpers/mixcode.js";
import type { MixCodeTabInfo } from "../src/core/types.js";
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
  assert.deepEqual(plan.toOpen, [
    { sessionId: "new-one", title: "Peer New", workdir: "/repo" },
  ]);
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
      selfPid: 2002,
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
    assert.equal(stateB.tabs.some((tab) => tab.sessionId === created.sessionId), false);

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
      clearTab: async (
        sessionId: string,
        options?: { newSessionId?: string },
      ) => {
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

    assert.throws(
      () => prepareAgentTabClear(state, runtime as never, tab.sessionId),
      SyntaxError,
    );
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

test("resume publishes open_tabs before switch so reconcile keeps session title", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-resume-race-"));
  const openTabsPath = openTabsFile(path.join(dir, "state"));
  configureOpenTabsPath(openTabsPath);
  try {
    const state = createInitialState(dir);
    const existing = createTab(1, "old-last", dir, { title: "Agent-11", status: "idle" });
    state.tabs.push(existing);
    state.activeTabId = existing.sessionId;
    writeOpenTabs(openTabsPath, [existing.sessionId]);

    const durableId = "019f72f8-durable-resume-id";
    const sessionPath = path.join(dir, "zen.jsonl");
    await fsPromises.writeFile(sessionPath, "{}\n");

    let releaseSwitch!: () => void;
    const switchGate = new Promise<void>((resolve) => {
      releaseSwitch = resolve;
    });
    let reconcileDuringSwitch!: () => Promise<void>;

    const runtimeTabs = new Map<
      string,
      {
        tab: MixCodeTabInfo;
        session: { getSessionFile: () => string | null; getSessionName: () => string | undefined };
      }
    >([
      [
        existing.sessionId,
        {
          tab: existing,
          session: { getSessionFile: () => null, getSessionName: () => undefined },
        },
      ],
    ]);

    const runtime = {
      createTab: async (tab: MixCodeTabInfo) => {
        const rt = {
          tab,
          session: {
            getSessionFile: () => null as string | null,
            getSessionName: () => undefined as string | undefined,
          },
        };
        runtimeTabs.set(tab.sessionId, rt);
        return rt as never;
      },
      extensionSwitchSession: async (sessionId: string, _path: string) => {
        const rt = runtimeTabs.get(sessionId);
        if (!rt) throw new Error(`Unknown runtime tab: ${sessionId}`);
        // Race window: UI may already show durable id; open_tabs must list it.
        await reconcileDuringSwitch();
        await switchGate;
        // Mirror replace: map key moves to durable id; tab object keeps durable id/title.
        runtimeTabs.delete(sessionId);
        rt.tab.sessionId = durableId;
        rt.tab.title = "implement-zen-mode";
        rt.session = {
          getSessionFile: () => sessionPath,
          getSessionName: () => "implement-zen-mode",
        };
        runtimeTabs.set(durableId, rt);
        return { cancelled: false };
      },
      getTab: (id: string) => runtimeTabs.get(id),
      closeTab: async (id: string) => {
        if (!runtimeTabs.has(id)) throw new Error(`Unknown tab session: ${id}`);
        runtimeTabs.delete(id);
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
    reconcileDuringSwitch = () => sync.reconcileNow();

    state.sessionSelector = createSessionSelectorState();

    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => false,
      hideOverlay: () => undefined,
    };

    // Drive multi-tab resume glue directly (UI is Pi SessionSelectorComponent).
    resumeSelectedSession(
      state,
      tui as never,
      sessionPath,
      "implement-zen-mode",
      durableId,
      null,
      runtime as never,
    );
    // Allow async resume to publish durable id then hit switch gate.
    await Bun.sleep(20);
    await sync.reconcileNow();
    releaseSwitch();
    await Bun.sleep(30);
    await sync.reconcileNow();

    assert.deepEqual(closed, [], "in-flight resume must not be closed by peer reconcile");
    assert.deepEqual(opened, [], "in-flight resume must not reopen with peer Agent-NN title");
    const resumed = state.tabs.find((tab) => tab.sessionId === durableId);
    assert.ok(resumed, "resumed tab must remain");
    assert.equal(resumed.title, "implement-zen-mode");
    assert.ok(readOpenTabs(openTabsPath).includes(durableId));
    assert.ok(runtimeTabs.has(durableId));

    sync.dispose();
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
