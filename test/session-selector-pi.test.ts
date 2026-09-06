import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test, type TestContext } from "node:test";
import {
  SessionManager,
  SessionSelectorComponent,
  type SessionInfo,
} from "@earendil-works/pi-coding-agent";
import { getKeybindings } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  handleSubmittedInput,
  MIXCODE_FAUX_MODEL,
  MixCodeRuntime,
  modelToRef,
} from "./helpers/mixcode.js";
import { materializeSessionFile } from "../src/agent/runtime-session.js";
import { applyMixCodeKeybindings } from "../src/agent/runtime-pi-tui-bridge.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import {
  closeSessionSelector,
  getSessionSelectorComponent,
  openSessionSelector,
  renameOpenSession,
  resumeSelectedSession,
} from "../src/ui/session-resume.js";

function makeSessions(): SessionInfo[] {
  return [
    {
      path: "/sessions/session-a.jsonl",
      id: "session-a",
      cwd: "/repo",
      name: "My Session",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-02"),
      messageCount: 10,
      firstMessage: "Hello world",
      allMessagesText: "Hello world",
    },
    {
      path: "/sessions/session-b.jsonl",
      id: "session-b",
      cwd: "/repo",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-01"),
      messageCount: 5,
      firstMessage: "Another session",
      allMessagesText: "Another session",
    },
  ];
}

function mockInputHost() {
  let mounted: unknown;
  let cleared = 0;
  return {
    host: {
      setInputComponent: (component: unknown) => {
        mounted = component;
      },
      clearInputComponent: () => {
        cleared++;
        mounted = undefined;
      },
      requestRender: () => undefined,
    },
    get mounted() {
      return mounted;
    },
    get cleared() {
      return cleared;
    },
  };
}

test("submitted /resume mounts SessionSelectorComponent in the editor input slot", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const input = mockInputHost();
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      throw new Error("session selector must not use floating overlay");
    },
  };
  const sessions = makeSessions();
  const runtime = {
    appendSystemMessage: () => undefined,
    getTab: () => ({ session: { getSessionFile: () => "/sessions/current.jsonl" } }),
    listSessions: async () => sessions,
    listAllSessions: async () => sessions,
    extensionSwitchSession: async () => ({ cancelled: false }),
    createTab: async () => undefined,
    closeTab: async () => undefined,
    closeAllTabs: async () => undefined,
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
    prompt: async () => undefined,
    setExtensionEnabled: () => undefined,
    forkSession: async () => undefined,
    executeShellCommand: async () => undefined,
    extensionReload: async () => undefined,
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/resume", tui as never, undefined, input.host);

  assert.equal(state.sessionSelector.open, true);
  assert.ok(getSessionSelectorComponent(state) instanceof SessionSelectorComponent);
  // Host wraps component for keybindings bridge; inner is still on state.
  assert.ok(input.mounted);
  assert.notEqual(input.mounted, undefined);
});

function makeResumeByIdRuntime(
  currentSessions: SessionInfo[] = makeSessions(),
  allSessions: SessionInfo[] = currentSessions,
) {
  const switched: Array<{ id: string; path: string }> = [];
  const systemMessages: Array<{ id: string; text: string; kind?: string }> = [];
  const runtime = {
    appendSystemMessage: (id: string, text: string, kind?: string) => {
      systemMessages.push({ id, text, kind });
    },
    listSessions: async () => currentSessions,
    listAllSessions: async () => allSessions,

    extensionSwitchSession: async (sessionId: string, sessionPath: string) => {
      switched.push({ id: sessionId, path: sessionPath });
      return { cancelled: false };
    },
    createTab: async () => undefined,
    getTab: (sessionId: string) => {
      if (sessionId === "s1") {
        return {
          session: {
            getSessionFile: () => "/sessions/current.jsonl",
            getSessionId: () => "current-session",
          },
        };
      }
      if (sessionId === "s2") {
        return {
          session: {
            getSessionFile: () => "/sessions/session-b.jsonl",
            getSessionId: () => "session-b",
            getSessionName: () => "Agent-02",
          },
        };
      }
      return {
        session: {
          getSessionFile: () => "/sessions/session-a.jsonl",
          getSessionId: () => "session-a",
          getSessionName: () => "My Session",
        },
      };
    },
    closeTab: async () => undefined,
    prompt: async () => undefined,
  } as unknown as MixCodeRuntime;
  return { runtime, switched, systemMessages };
}

async function createResumeFixture(t: TestContext, fromHome = false) {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-resume-selector-"));
  const sessionsRoot = path.join(root, "sessions");
  const runtime = new MixCodeRuntime({ sessionsRoot, agentDir: path.join(root, "agent") });
  t.after(async () => {
    try {
      await runtime.closeAllTabs();
    } finally {
      await fsPromises.rm(root, { recursive: true, force: true });
    }
  });
  const state = createInitialState(root);
  state.model = modelToRef(MIXCODE_FAUX_MODEL);
  const target = SessionManager.create(root, sessionsRoot);
  target.newSession({ id: "session-a" });
  target.appendModelChange(MIXCODE_FAUX_MODEL.provider, MIXCODE_FAUX_MODEL.id);
  target.appendSessionInfo("My Session");
  target.appendMessage({ role: "user", content: "Target history", timestamp: Date.now() });
  materializeSessionFile(target);
  const targetPath = target.getSessionFile()!;
  if (!fromHome) {
    const source = createTab(1, "s1", root, { title: "Source", model: state.model });
    state.tabs.push(source);
    state.activeTabId = source.sessionId;
    await runtime.createTab(source, {
      workdir: root,
      systemPrompt: "test",
      model: MIXCODE_FAUX_MODEL,
    });
  }
  // Resume finishes after handleSubmittedInput returns; observe its public completion callback.
  const completion = Promise.withResolvers<void>();
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render: (width: number) => string[] }) => {
      completion.reject(new Error(component.render(100).join("\n")));
      return { hide: () => undefined };
    },
  };
  return { state, runtime, targetPath, tui, completion };
}

test("/resume N:<tab-name> resumes the exact session name", async (t) => {
  const { state, runtime, targetPath, tui, completion } = await createResumeFixture(t);
  const source = runtime.getTab("s1")!;
  const sourcePath = source.session.getSessionFile();

  await handleSubmittedInput(state, runtime, "/resume N:My Session", tui as never, () => {
    completion.resolve();
  });
  await completion.promise;

  assert.equal(runtime.listTabs().length, 2);
  assert.equal(state.tabs.length, 2);
  assert.equal(runtime.getTab("session-a")?.session.getSessionFile(), targetPath);
  assert.equal(runtime.getTab("session-a")?.session.getSessionName(), "My Session");
  assert.equal(state.tabs.find((tab) => tab.sessionId === "session-a")?.title, "My Session");
  assert.equal(state.activeTabId, "session-a");
  assert.equal(state.sessionSelector.open, false);
  assert.equal(runtime.getTab("s1"), source);
  assert.equal(source.session.getSessionFile(), sourcePath);
  assert.notEqual(sourcePath, targetPath);
  assert.equal(source.tab.title, "Source");
});

test("/resume N:<tab-name> matches an open tab title", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.tabs.push(createTab(2, "s2", "/repo", { title: "Agent-02" }));
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({ hide: () => undefined }) };
  const { runtime, switched } = makeResumeByIdRuntime();

  await handleSubmittedInput(state, runtime, "/resume N:Agent-02", tui as never);

  assert.equal(switched.length, 0);
  assert.equal(state.activeTabId, "s2");
});

test("/resume N:<tab-name> requires a complete name match", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({ hide: () => undefined }) };
  const { runtime, switched, systemMessages } = makeResumeByIdRuntime();

  await handleSubmittedInput(state, runtime, "/resume N:My", tui as never);

  assert.equal(switched.length, 0);
  assert.equal(tab.toast?.type, "warning");
  assert.match(tab.toast?.message ?? "", /No session found for name: My/);
  assert.match(systemMessages[0]?.text ?? "", /No session found for name: My/);
  assert.equal(systemMessages[0]?.kind, "error");
});

test("/resume N:<tab-name> reports duplicate names with candidate ids", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const duplicateSessions = makeSessions().map((session) => ({ ...session, name: "Duplicate" }));
  const tui = { requestRender: () => undefined, showOverlay: () => ({ hide: () => undefined }) };
  const { runtime, switched, systemMessages } = makeResumeByIdRuntime([], duplicateSessions);

  await handleSubmittedInput(state, runtime, "/resume N:Duplicate", tui as never);

  assert.equal(switched.length, 0);
  assert.match(systemMessages[0]?.text ?? "", /Multiple sessions named "Duplicate"/);
  assert.match(systemMessages[0]?.text ?? "", /session-a/);
  assert.match(systemMessages[0]?.text ?? "", /session-b/);
  assert.equal(systemMessages[0]?.kind, "error");
});

test("/resume N:<tab-name> prefers a current-folder match", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const current = makeSessions()[0]!;
  const other = { ...current, path: "/other/session.jsonl", id: "other-session", cwd: "/other" };
  const tui = { requestRender: () => undefined, showOverlay: () => ({ hide: () => undefined }) };
  const { runtime, switched } = makeResumeByIdRuntime([current], [current, other]);

  await handleSubmittedInput(state, runtime, "/resume N:My Session", tui as never);
  await Bun.sleep(30);

  assert.equal(switched.length, 1);
  assert.equal(switched[0]!.path, "/sessions/session-a.jsonl");
});

test("/resume <session-id> resumes the session directly without opening the selector", async (t) => {
  const { state, runtime, targetPath, tui, completion } = await createResumeFixture(t);
  const source = runtime.getTab("s1")!;
  const sourcePath = source.session.getSessionFile();

  await handleSubmittedInput(state, runtime, "/resume session-a", tui as never, () => {
    completion.resolve();
  });
  await completion.promise;

  assert.equal(state.sessionSelector.open, false);
  assert.equal(runtime.listTabs().length, 2);
  assert.equal(state.tabs.length, 2);
  assert.equal(runtime.getTab("session-a")?.session.getSessionFile(), targetPath);
  assert.equal(runtime.getTab("session-a")?.session.getSessionName(), "My Session");
  const resumed = state.tabs.find((tab) => tab.sessionId === "session-a");
  assert.ok(resumed);
  assert.equal(resumed.title, "My Session");
  assert.equal(state.activeTabId, "session-a");
  assert.equal(runtime.getTab("s1"), source);
  assert.equal(source.session.getSessionFile(), sourcePath);
  assert.notEqual(sourcePath, targetPath);
  assert.notEqual(resumed, source.tab);
  assert.equal(source.tab.title, "Source");
});

test("/resume <session-id> works from Home with no open tabs", async (t) => {
  const { state, runtime, targetPath, tui, completion } = await createResumeFixture(t, true);
  assert.equal(state.activeTabId, "home");
  assert.equal(state.tabs.length, 0);
  assert.equal(runtime.listTabs().length, 0);

  await handleSubmittedInput(state, runtime, "/resume session-a", tui as never, () => {
    completion.resolve();
  });
  await completion.promise;

  assert.equal(runtime.listTabs().length, 1);
  assert.equal(state.tabs.length, 1);
  assert.equal(runtime.getTab("session-a")?.session.getSessionFile(), targetPath);
  assert.equal(runtime.getTab("session-a")?.session.getSessionName(), "My Session");
  const resumed = state.tabs.find((tab) => tab.sessionId === "session-a");
  assert.ok(resumed);
  assert.equal(resumed.title, "My Session");
  assert.equal(state.activeTabId, "session-a");
  assert.equal(state.sessionSelector.open, false);
});

test("/resume <unknown-id> from Home fails loud via error overlay", async () => {
  const state = createInitialState("/repo");
  const overlays: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render: (width: number) => string[] }) => {
      overlays.push(component.render(60).join("\n"));
      return { hide: () => undefined };
    },
  };
  const { runtime, switched } = makeResumeByIdRuntime();

  await handleSubmittedInput(state, runtime, "/resume nope-123", tui as never);

  assert.equal(switched.length, 0);
  assert.equal(state.tabs.length, 0);
  assert.equal(overlays.length, 1);
  assert.match(overlays[0]!, /No session found for id: nope-123/);
});

test("/resume <unknown-id> warns on the active tab and opens nothing", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = { requestRender: () => undefined, showOverlay: () => ({ hide: () => undefined }) };
  const { runtime, switched } = makeResumeByIdRuntime();

  await handleSubmittedInput(state, runtime, "/resume nope-123", tui as never);
  await Bun.sleep(30);

  assert.equal(state.sessionSelector.open, false);
  assert.equal(switched.length, 0);
  assert.equal(state.tabs.length, 1);
  assert.equal(tab.toast?.type, "warning");
  assert.match(tab.toast?.message ?? "", /No session found for id: nope-123/);
});

test("openSessionSelector returns without waiting for listing; close clears input slot", async () => {
  const state = createInitialState("/repo");
  state.activeTabId = "s1";
  state.tabs.push(createTab(1, "s1", "/repo"));
  let resolveListing: (sessions: SessionInfo[]) => void = () => undefined;
  const listing = new Promise<SessionInfo[]>((resolve) => {
    resolveListing = resolve;
  });
  const input = mockInputHost();
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
  };
  const runtime = {
    listSessions: () => listing,
    listAllSessions: async () => [],
  };

  const opening = openSessionSelector(
    state,
    runtime as never,
    tui as never,
    "/repo",
    null,
    undefined,
    input.host,
  );
  const returned = await Promise.race([
    opening.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 25)),
  ]);
  assert.equal(returned, true, "opening must not wait for disk scanning");
  assert.equal(state.sessionSelector.open, true);
  assert.ok(getSessionSelectorComponent(state));
  assert.ok(input.mounted);

  closeSessionSelector(state, tui as never);
  resolveListing(makeSessions());
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(state.sessionSelector.open, false);
  assert.equal(getSessionSelectorComponent(state), undefined);
  assert.ok(input.cleared >= 1);
  assert.equal(input.mounted, undefined);
});

test("applyMixCodeKeybindings exposes app.session shortcut labels for Pi keyHint", () => {
  const restore = applyMixCodeKeybindings();
  try {
    const kb = getKeybindings();
    assert.deepEqual(kb.getKeys("app.session.toggleSort" as never), ["ctrl+s"]);
    assert.deepEqual(kb.getKeys("app.session.delete" as never), ["ctrl+d"]);
    assert.deepEqual(kb.getKeys("app.session.rename" as never), ["ctrl+r"]);
    assert.deepEqual(kb.getKeys("app.session.toggleNamedFilter" as never), ["ctrl+n"]);
    assert.deepEqual(kb.getKeys("app.session.togglePath" as never), ["ctrl+p"]);
  } finally {
    restore();
  }
});

test("session selector render includes key hints when keybindings bridge is applied", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const input = mockInputHost();
  const tui = { requestRender: () => undefined, showOverlay: () => ({ hide: () => undefined }) };
  const runtime = {
    listSessions: async () => makeSessions(),
    listAllSessions: async () => [],
  };
  await openSessionSelector(
    state,
    runtime as never,
    tui as never,
    "/repo",
    null,
    undefined,
    input.host,
  );
  // Wait a tick for async list load inside Pi component
  await Bun.sleep(30);
  const host = input.mounted as { render: (w: number) => string[] };
  assert.ok(host?.render);
  const plain = host
    .render(100)
    .join("\n")
    .replace(/\x1b\[[0-9;]*m/g, "");
  assert.match(plain, /ctrl\+s|Ctrl\+S/i);
  assert.match(plain, /sort/i);
  assert.match(plain, /ctrl\+d|Ctrl\+D/i);
  closeSessionSelector(state, tui as never);
});

type MountedSelector = {
  handleInput: (data: string) => void;
  render: (w: number) => string[];
};

async function openMountedSelector(runtime: {
  listSessions: () => Promise<SessionInfo[]>;
  listAllSessions: (
    signal?: AbortSignal,
    onProgress?: (loaded: number, total: number) => void,
  ) => Promise<SessionInfo[]>;
}) {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let mounted: MountedSelector | undefined;
  const input = {
    setInputComponent: (component: unknown) => {
      mounted = component as MountedSelector;
    },
    clearInputComponent: () => {
      mounted = undefined;
    },
    requestRender: () => undefined,
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
    hasOverlay: () => false,
  };
  await openSessionSelector(state, runtime as never, tui as never, "/repo", null, undefined, input);
  await Bun.sleep(30);
  assert.ok(mounted);
  return {
    state,
    tui,
    get mounted() {
      return mounted!;
    },
    tab(data: string) {
      return handleMixCodeKeyInput(
        state,
        data,
        tui as never,
        undefined,
        undefined,
        undefined,
        () => false,
        {
          getText: () => "",
          setText: () => undefined,
          hasInputComponent: () => mounted !== undefined,
          forwardToInputComponent: (key) => mounted?.handleInput(key),
        },
      );
    },
    plain(width = 120) {
      return mounted!
        .render(width)
        .join("\n")
        .replace(/\x1b\[[0-9;]*m/g, "");
    },
    close() {
      closeSessionSelector(state, tui as never);
    },
  };
}

test("All scope load reports Loading n/m progress to the header", async () => {
  const current = makeSessions();
  let reportProgress: ((loaded: number, total: number) => void) | undefined;
  let resolveAll: (sessions: SessionInfo[]) => void = () => undefined;
  const allPending = new Promise<SessionInfo[]>((resolve) => {
    resolveAll = resolve;
  });
  const sel = await openMountedSelector({
    listSessions: async () => current,
    listAllSessions: async (_signal, onProgress) => {
      reportProgress = onProgress;
      return allPending;
    },
  });

  sel.tab("\t");
  await Bun.sleep(20);
  assert.ok(reportProgress, "first All load must accept an onProgress sink");
  reportProgress!(3, 10);
  await Bun.sleep(10);
  assert.match(sel.plain(), /Loading\s+3\/10/);

  resolveAll(current);
  await Bun.sleep(20);
  sel.close();
});

test("All scope clears current-folder rows while the global list is still loading", async () => {
  const current = [
    {
      path: "/sessions/only-current.jsonl",
      id: "only-current",
      cwd: "/repo",
      name: "OnlyInCurrent",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-02"),
      messageCount: 1,
      firstMessage: "current only",
      allMessagesText: "current only",
    },
  ];
  let releaseAll: (sessions: SessionInfo[]) => void = () => undefined;
  const allPending = new Promise<SessionInfo[]>((resolve) => {
    releaseAll = resolve;
  });
  const sel = await openMountedSelector({
    listSessions: async () => current,
    listAllSessions: () => allPending,
  });
  assert.match(sel.plain(100), /OnlyInCurrent/);

  // Tab to All while the global scan is still in flight.
  sel.tab("\t");
  await Bun.sleep(30);
  const loadingPlain = sel.plain(100);
  assert.match(loadingPlain, /Resume Session \(All\)/);
  assert.doesNotMatch(
    loadingPlain,
    /OnlyInCurrent/,
    "must not keep current-folder rows under All while loading",
  );

  releaseAll([
    ...current,
    {
      path: "/sessions/other.jsonl",
      id: "other",
      cwd: "/other",
      name: "FromOther",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-03"),
      messageCount: 1,
      firstMessage: "other",
      allMessagesText: "other",
    },
  ]);
  await Bun.sleep(30);
  assert.match(sel.plain(100), /FromOther/);
  sel.close();
});

test("Tab scope toggle survives Kitty key-release (does not bounce back to Current)", async () => {
  const current = makeSessions();
  const all = [
    ...current,
    {
      path: "/sessions/other.jsonl",
      id: "other",
      cwd: "/other",
      name: "Other Folder",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-03"),
      messageCount: 2,
      firstMessage: "From elsewhere",
      allMessagesText: "From elsewhere",
    },
  ];
  let allCalls = 0;
  const sel = await openMountedSelector({
    listSessions: async () => current,
    listAllSessions: async () => {
      allCalls++;
      return all;
    },
  });

  // Kitty protocol: press then release for the same Tab key.
  // Release (\x1b[9;1:3u) also matches tui.input.tab — must not re-toggle.
  assert.deepEqual(sel.tab("\x1b[9;1u"), { consume: true });
  assert.deepEqual(sel.tab("\x1b[9;1:3u"), { consume: true });
  await Bun.sleep(30);

  assert.equal(allCalls, 1, "All-scope loader must run once, not bounce back");
  const plain = sel.plain();
  assert.match(plain, /Resume Session \(All\)/);
  assert.match(plain, /Other Folder/);
  sel.close();
});

test("resumeSelectedSession opens a new tab and switches to the target session", async () => {
  const state = createInitialState("/repo");
  const active = createTab(1, "s-active", "/repo", { title: "Active" });
  state.tabs.push(active);
  state.activeTabId = "s-active";

  const switched: Array<{ id: string; path: string }> = [];
  const created: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
    hasOverlay: () => false,
  };
  const runtime = {
    extensionSwitchSession: async (sessionId: string, sessionPath: string) => {
      switched.push({ id: sessionId, path: sessionPath });
      const tab = state.tabs.find(
        (t) => t.sessionId === "session-a" || created.includes(t.sessionId),
      );
      if (tab) tab.sessionId = "session-a";
      return { cancelled: false };
    },
    createTab: async (tab: { sessionId: string }) => {
      created.push(tab.sessionId);
    },
    getTab: (sessionId: string) => {
      if (sessionId === "s-active") {
        return { session: { getSessionFile: () => "/sessions/current.jsonl" } };
      }
      return {
        session: {
          getSessionFile: () => "/sessions/session-a.jsonl",
          getSessionName: () => "My Session",
        },
      };
    },
    closeTab: async () => undefined,
  };

  resumeSelectedSession(
    state,
    tui as never,
    "/sessions/session-a.jsonl",
    "My Session",
    "/sessions/current.jsonl",
    runtime as never,
  );

  await Bun.sleep(30);

  assert.equal(switched.length, 1);
  assert.equal(switched[0]!.path, "/sessions/session-a.jsonl");
  const resumed = state.tabs.find((t) => t.sessionId === "session-a");
  assert.ok(resumed);
  assert.equal(resumed.title, "My Session");
  assert.equal(resumed.status, "idle");
});

test("resumeSelectedSession focuses an already-open tab instead of creating another", () => {
  const state = createInitialState("/repo");
  const a = createTab(1, "s1", "/repo", { title: "One" });
  const b = createTab(2, "s2", "/repo", { title: "Two" });
  state.tabs.push(a, b);
  state.activeTabId = "s1";

  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
  };
  const runtime = {
    extensionSwitchSession: async () => ({ cancelled: false }),
    createTab: async () => {
      throw new Error("must not create");
    },
    getTab: (sessionId: string) => ({
      session: {
        getSessionFile: () =>
          sessionId === "s2" ? "/sessions/session-b.jsonl" : "/sessions/session-a.jsonl",
        getSessionName: () => (sessionId === "s2" ? "Two" : "One"),
      },
    }),
    closeTab: async () => undefined,
  };

  resumeSelectedSession(
    state,
    tui as never,
    "/sessions/session-b.jsonl",
    "Two",
    null,
    runtime as never,
  );

  assert.equal(state.activeTabId, "s2");
  assert.equal(state.tabs.length, 2);
});

test("renameOpenSession updates title of any open tab, not only active", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-rename-pi-"));
  try {
    const otherSession = SessionManager.create(root, root);
    const otherPath = otherSession.getSessionFile()!;
    otherSession.appendSessionInfo("Old-Other-Name");

    const state = createInitialState("/repo");
    const active = createTab(1, "s-active", "/repo", { title: "Active-Tab" });
    const other = createTab(2, "s-other", "/repo", { title: "Old-Other-Name" });
    state.tabs.push(active, other);
    state.activeTabId = "s-active";

    const runtime = {
      getTab: (sessionId: string) => {
        if (sessionId !== "s-other") return undefined;
        return { session: { getSessionFile: () => otherPath } };
      },
    };

    await renameOpenSession(state, runtime as never, otherPath, "New-Other-Name");

    assert.equal(other.title, "New-Other-Name");
    assert.equal(active.title, "Active-Tab");
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});

test("renameOpenSession refuses a title already used by another open tab", async () => {
  const root = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-rename-taken-"));
  try {
    const otherSession = SessionManager.create(root, root);
    const otherPath = otherSession.getSessionFile()!;
    otherSession.appendSessionInfo("Old-Other-Name");

    const state = createInitialState("/repo");
    const active = createTab(1, "s-active", "/repo", { title: "Active-Tab" });
    const other = createTab(2, "s-other", "/repo", { title: "Old-Other-Name" });
    state.tabs.push(active, other);
    state.activeTabId = "s-active";

    const runtime = {
      getTab: (sessionId: string) => {
        if (sessionId !== "s-other") return undefined;
        return { session: { getSessionFile: () => otherPath } };
      },
    };

    await renameOpenSession(state, runtime as never, otherPath, "Active-Tab");

    assert.equal(other.title, "Old-Other-Name");
    assert.equal(active.title, "Active-Tab");
    assert.equal(other.toast?.type, "warning");
    assert.match(other.toast?.message ?? "", /already in use: Active-Tab/);
    assert.equal(otherSession.getSessionName(), "Old-Other-Name");
  } finally {
    await fsPromises.rm(root, { recursive: true, force: true });
  }
});
