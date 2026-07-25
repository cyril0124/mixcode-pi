import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createSessionSelectorState,
  createTab,
  formatSessionDate,
  getFilteredSessions,
  getSelectedSessionPath,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderSessionSelector,
  searchSessionsWithRegex,
  toggleSessionSelectorScope,
  cycleSessionSortMode,
  toggleSessionNameFilter,
  updateSessionSelectorQuery,
  UUIDV7_SESSION_ID_PATTERN,
} from "../src/index.js";
import type { MixCodeRuntime } from "../src/index.js";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

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

test("regex session search runs outside the event loop and times out pathological patterns", async () => {
  const sessions = makeSessions();
  sessions[0]!.allMessagesText = `${"a".repeat(30_000)}!`;

  const safe = searchSessionsWithRegex(sessions, "My\\s+Session", 500);
  const safeResults = await safe.promise;
  assert.deepEqual(safeResults, [
    {
      path: "/sessions/session-a.jsonl",
      index: 10,
      highlightIndex: 0,
      highlightLength: 10,
    },
  ]);

  const selector = createSessionSelectorState();
  selector.currentSessions = sessions;
  selector.query = "re:session";
  selector.regexQuery = selector.query;
  selector.regexStatus = "ready";
  selector.regexResults = {
    "/sessions/session-a.jsonl": 100,
    "/sessions/session-b.jsonl": 0,
  };
  selector.sortMode = "recent";
  assert.deepEqual(getFilteredSessions(selector).map((node) => node.session.id), [
    "session-a",
    "session-b",
  ]);
  selector.sortMode = "relevance";
  assert.deepEqual(getFilteredSessions(selector).map((node) => node.session.id), [
    "session-b",
    "session-a",
  ]);

  const pathological = searchSessionsWithRegex(sessions, "(a+)+$", 50);
  await assert.rejects(pathological.promise, /timed out after 50ms/);
});

test("submitted /resume opens session selector overlay", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let overlayContent = "";
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render: (width: number) => string[] }) => {
      overlayContent = component.render(80).join("\n");
      return { hide: () => undefined } as never;
    },
    hasOverlay: () => !!overlayContent,
    hideOverlay: () => {
      overlayContent = "";
    },
  };
  const sessions = makeSessions();
  const runtime = {
    appendSystemMessage: () => undefined,
    getTab: () => ({ session: { getSessionFile: () => "/sessions/current.jsonl" } }),
    listSessions: async () => sessions,
    listAllSessions: async () => sessions,
    extensionSwitchSession: async () => ({ cancelled: false }),
    closeTab: async () => undefined,
    closeAllTabs: async () => undefined,
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/resume", tui);

  assert.equal(state.sessionSelector.open, true);
  assert.equal(state.sessionSelector.currentSessions.length, 2);
  assert.ok(overlayContent.includes("Resume Session"));
  assert.ok(overlayContent.includes("My Session"));
});

test("submitted /resume throws when runtime lacks session listing support", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
  };
  const runtime = {
    getTab: () => undefined,
    closeTab: async () => undefined,
    closeAllTabs: async () => undefined,
    deleteTab: async () => undefined,
    deleteAllTabs: async () => undefined,
    compactSession: async () => undefined,
  } as unknown as MixCodeRuntime;

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/resume", tui),
    /Resume requires pi runtime session listing support/,
  );
});

test("session selector key handling: escape closes selector", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  let overlayHidden = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => !overlayHidden,
    hideOverlay: () => {
      overlayHidden = true;
    },
  };

  const result = handleMixCodeKeyInput(state, "\x1b", tui);
  assert.deepEqual(result, { consume: true });
  assert.equal(state.sessionSelector.open, false);
});

test("session selector key handling: tab toggles scope", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  assert.equal(state.sessionSelector.scope, "current");
  handleMixCodeKeyInput(state, "\t", tui, undefined, {
    listAllSessions: async () => makeSessions(),
  });
  assert.equal(state.sessionSelector.scope, "all");
});

test("session selector cannot delete a session open in another tab", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "current", "/repo", { title: "Current" }),
    createTab(2, "other", "/repo", { title: "Other" }),
  );
  state.activeTabId = "current";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessionPath = "/sessions/current.jsonl";
  state.sessionSelector.currentSessions = makeSessions();
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };
  let otherOpen = true;
  const runtime = {
    getTab: (sessionId: string) => {
      if (sessionId === "other" && !otherOpen) return undefined;
      return {
        session: {
          getSessionFile: () =>
            sessionId === "current"
              ? "/sessions/current.jsonl"
              : "/sessions/session-a.jsonl",
        },
      };
    },
  };

  handleMixCodeKeyInput(state, "\x04", tui, undefined, runtime);

  assert.equal(state.sessionSelector.confirmingDeletePath, null);
  assert.equal(state.sessionSelector.statusType, "error");
  assert.match(state.sessionSelector.statusMessage, /Other/);

  otherOpen = false;
  handleMixCodeKeyInput(state, "\x04", tui, undefined, runtime);
  assert.equal(state.sessionSelector.confirmingDeletePath, "/sessions/session-a.jsonl");

  otherOpen = true;
  handleMixCodeKeyInput(state, "\r", tui, undefined, runtime);
  assert.equal(state.sessionSelector.confirmingDeletePath, null);
  assert.equal(state.sessionSelector.statusType, "error");
  assert.match(state.sessionSelector.statusMessage, /Other/);
});

test("session selector key handling: enter resumes selected session", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  let switchedTo = "";
  let switchInputId = "";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => state.sessionSelector.open,
    hideOverlay: () => undefined,
  };
  const runtime = {
    extensionSwitchSession: async (sessionId: string, sessionPath: string) => {
      switchInputId = sessionId;
      switchedTo = sessionPath;
      const tab = state.tabs.find((item) => item.sessionId === sessionId);
      if (tab) tab.sessionId = "session-a";
      return { cancelled: false };
    },
    createTab: async () => undefined,
    getTab: () => undefined,
    closeTab: async () => undefined,
  };

  handleMixCodeKeyInput(state, "\r", tui, undefined, runtime);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(switchedTo, "/sessions/session-a.jsonl");
  assert.match(switchInputId, UUIDV7_SESSION_ID_PATTERN);
  assert.equal(state.sessionSelector.open, false);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.tabs[1]!.sessionId, "session-a");
  assert.equal(state.activeTabId, "session-a");
  assert.equal(state.tabs[1]!.title, "My Session");
});

test("session selector key handling: cancelled resume removes transient tab", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  let closedTab = "";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => state.sessionSelector.open,
    hideOverlay: () => undefined,
  };
  const runtime = {
    extensionSwitchSession: async () => ({ cancelled: true }),
    createTab: async () => undefined,
    getTab: () => undefined,
    closeTab: async (sessionId: string) => {
      closedTab = sessionId;
    },
  };

  handleMixCodeKeyInput(state, "\r", tui, undefined, runtime);
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(state.tabs.length, 1);
  assert.equal(state.tabs[0]!.sessionId, "s1");
  assert.equal(state.activeTabId, "s1");
  assert.match(closedTab, UUIDV7_SESSION_ID_PATTERN);
  assert.equal(state.sessionSelector.statusMessage, "Resume cancelled");
});

test("session selector key handling: typing filters sessions", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  handleMixCodeKeyInput(state, "M", tui);
  handleMixCodeKeyInput(state, "y", tui);
  assert.equal(state.sessionSelector.query, "My");

  const nodes = getFilteredSessions(state.sessionSelector);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.session.name, "My Session");
});

test("session selector filters, sorts, scopes, and selects sessions", () => {
  const selector = createSessionSelectorState();
  assert.equal(selector.scope, "current");
  assert.equal(selector.sortMode, "threaded");
  assert.equal(selector.nameFilter, "all");

  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "all");
  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "current");
  cycleSessionSortMode(selector);
  assert.equal(selector.sortMode, "recent");
  cycleSessionSortMode(selector);
  assert.equal(selector.sortMode, "relevance");
  cycleSessionSortMode(selector);
  assert.equal(selector.sortMode, "threaded");
  toggleSessionNameFilter(selector);
  assert.equal(selector.nameFilter, "named");

  selector.currentSessions = makeSessions();
  assert.equal(getFilteredSessions(selector).length, 1);
  assert.equal(getFilteredSessions(selector)[0]!.session.name, "My Session");

  selector.nameFilter = "all";
  selector.sortMode = "relevance";
  updateSessionSelectorQuery(selector, "Another");
  const relevance = getFilteredSessions(selector);
  assert.equal(relevance.length, 1);
  assert.equal(relevance[0]!.session.firstMessage, "Another session");

  selector.query = "";
  selector.sortMode = "threaded";
  selector.selectedIndex = 1;
  const nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 2);
  assert.equal(getSelectedSessionPath(selector), nodes[1]!.session.path);

  selector.currentSessions = [
    {
      path: "/sessions/parent.jsonl",
      id: "parent",
      cwd: "/repo",
      name: "Parent",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-03"),
      messageCount: 5,
      firstMessage: "parent msg",
      allMessagesText: "parent msg",
    },
    {
      path: "/sessions/child.jsonl",
      id: "child",
      cwd: "/repo",
      name: "Child",
      parentSessionPath: "/sessions/parent.jsonl",
      created: new Date("2025-01-02"),
      modified: new Date("2025-01-02"),
      messageCount: 3,
      firstMessage: "child msg",
      allMessagesText: "child msg",
    },
  ];
  const tree = getFilteredSessions(selector);
  assert.equal(tree.length, 2);
  assert.equal(tree[0]!.session.name, "Parent");
  assert.equal(tree[0]!.depth, 0);
  assert.equal(tree[1]!.session.name, "Child");
  assert.equal(tree[1]!.depth, 1);
});

test("formatSessionDate formats relative times correctly", () => {
  const now = Date.now();
  assert.equal(formatSessionDate(new Date(now - 30_000)), "now");
  assert.equal(formatSessionDate(new Date(now - 5 * 60_000)), "5m");
  assert.equal(formatSessionDate(new Date(now - 3 * 3_600_000)), "3h");
  assert.equal(formatSessionDate(new Date(now - 2 * 86_400_000)), "2d");
  assert.equal(formatSessionDate(new Date(now - 14 * 86_400_000)), "2w");
  assert.equal(formatSessionDate(new Date(now - 60 * 86_400_000)), "2mo");
});

test("session selector rendering includes scope, sort, and empty-state text", () => {
  const state = createInitialState("/repo");
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  const populated = renderSessionSelector(state, 80).join("\n");
  assert.ok(populated.includes("Resume Session"));
  assert.ok(populated.includes("Current"));
  assert.ok(populated.includes("Threaded"));

  state.sessionSelector.currentSessions = [];
  const empty = renderSessionSelector(state, 80).join("\n");
  assert.ok(empty.includes("No sessions in current folder"));
});

test("named filter survives scope toggles once all sessions are loaded", () => {
  const state = createInitialState("/repo");
  const selector = state.sessionSelector;
  selector.open = true;
  selector.currentSessions = makeSessions();
  selector.allSessions = makeSessions();
  selector.allLoaded = true;

  toggleSessionNameFilter(selector);
  assert.equal(selector.nameFilter, "named");
  assert.equal(getFilteredSessions(selector).length, 1);
  assert.equal(getFilteredSessions(selector)[0]!.session.name, "My Session");

  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "all");
  assert.equal(getFilteredSessions(selector).length, 1);
  assert.equal(getFilteredSessions(selector)[0]!.session.name, "My Session");

  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "current");
  assert.equal(getFilteredSessions(selector).length, 1);
});

test("named filter with unloaded allSessions is empty in all scope and recovers", () => {
  const state = createInitialState("/repo");
  const selector = state.sessionSelector;
  selector.open = true;
  selector.currentSessions = makeSessions();
  assert.equal(selector.allLoaded, false);
  assert.deepEqual(selector.allSessions, []);

  toggleSessionNameFilter(selector);
  assert.equal(getFilteredSessions(selector).length, 1);

  toggleSessionSelectorScope(selector);
  assert.equal(getFilteredSessions(selector).length, 0);

  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "current");
  assert.equal(getFilteredSessions(selector).length, 1);
});

test("ctrl+n then tab via key handler loads all sessions under named filter", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const selector = state.sessionSelector;
  selector.open = true;
  selector.currentSessions = makeSessions();

  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };
  const runtime = {
    listAllSessions: async () => makeSessions(),
    extensionSwitchSession: async () => ({ cancelled: false }),
  };

  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "named");
  assert.equal(getFilteredSessions(selector).length, 1);

  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "all");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(getFilteredSessions(selector).length, 1);

  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "current");
  assert.equal(getFilteredSessions(selector).length, 1);
});

test("named filter with no named sessions is empty until filter is cleared", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const selector = state.sessionSelector;
  selector.open = true;
  const unnamedSessions: SessionInfo[] = [
    {
      path: "/sessions/s1.jsonl",
      id: "s1",
      cwd: "/repo",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-02"),
      messageCount: 10,
      firstMessage: "Hello",
      allMessagesText: "Hello",
    },
    {
      path: "/sessions/s2.jsonl",
      id: "s2",
      cwd: "/repo",
      created: new Date("2025-01-01"),
      modified: new Date("2025-01-01"),
      messageCount: 5,
      firstMessage: "World",
      allMessagesText: "World",
    },
  ];
  selector.currentSessions = unnamedSessions;

  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };
  const runtime = {
    listAllSessions: async () => [...unnamedSessions],
    extensionSwitchSession: async () => ({ cancelled: false }),
  };

  assert.equal(getFilteredSessions(selector).length, 2);

  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "named");
  assert.equal(getFilteredSessions(selector).length, 0);

  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(getFilteredSessions(selector).length, 0);

  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "all");
  assert.equal(getFilteredSessions(selector).length, 2);

  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "current");
  assert.equal(getFilteredSessions(selector).length, 2);
});

test("named filter can be cleared after visiting all-scope empty current folder", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const selector = state.sessionSelector;
  selector.open = true;

  const unnamedSession: SessionInfo = {
    path: "/sessions/unnamed.jsonl",
    id: "unnamed",
    cwd: "/repo",
    created: new Date("2025-01-01"),
    modified: new Date("2025-01-01"),
    messageCount: 5,
    firstMessage: "World",
    allMessagesText: "World",
  };
  const namedSession: SessionInfo = {
    path: "/sessions/named.jsonl",
    id: "named",
    cwd: "/other-repo",
    name: "My Named Session",
    created: new Date("2025-01-01"),
    modified: new Date("2025-01-02"),
    messageCount: 10,
    firstMessage: "Hello",
    allMessagesText: "Hello",
  };
  selector.currentSessions = [unnamedSession];

  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };
  const runtime = {
    listAllSessions: async () => [namedSession, unnamedSession],
    extensionSwitchSession: async () => ({ cancelled: false }),
  };

  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "named");
  assert.equal(selector.scope, "current");
  assert.equal(getFilteredSessions(selector).length, 0);

  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "all");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(getFilteredSessions(selector).length, 1);

  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "current");
  assert.equal(getFilteredSessions(selector).length, 0);

  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "all");
  assert.equal(getFilteredSessions(selector).length, 1);
});

test("shift+tab does not corrupt search query", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const selector = state.sessionSelector;
  selector.open = true;
  selector.currentSessions = makeSessions();

  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  handleMixCodeKeyInput(state, "\x1b[Z", tui);

  assert.equal(selector.query, "");
  assert.equal(getFilteredSessions(selector).length, 2);
});
