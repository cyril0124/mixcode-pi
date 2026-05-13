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
  toggleSessionSelectorScope,
  cycleSessionSortMode,
  toggleSessionNameFilter,
  updateSessionSelectorQuery,
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
    undoLastUserTurn: async () => undefined,
    compactSession: async () => undefined,
  } as unknown as MixCodeRuntime;

  await handleSubmittedInput(state, runtime, "/resume", tui);

  // Session selector should be open
  assert.equal(state.sessionSelector.open, true);
  assert.equal(state.sessionSelector.currentSessions.length, 2);
  // Overlay should show session selector content
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
    undoLastUserTurn: async () => undefined,
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

test("session selector key handling: enter resumes selected session", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  let switchedTo = "";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => state.sessionSelector.open,
    hideOverlay: () => undefined,
  };
  const runtime = {
    extensionSwitchSession: async (_sessionId: string, sessionPath: string) => {
      switchedTo = sessionPath;
      return { cancelled: false };
    },
  };

  handleMixCodeKeyInput(state, "\r", tui, undefined, runtime);
  // Wait for async switch
  await new Promise((resolve) => setTimeout(resolve, 50));

  assert.equal(switchedTo, "/sessions/session-a.jsonl");
  assert.equal(state.sessionSelector.open, false);
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
  // "My Session" should match, "Another session" should not
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.session.name, "My Session");
});

test("session selector state: scope toggle", () => {
  const selector = createSessionSelectorState();
  assert.equal(selector.scope, "current");
  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "all");
  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "current");
});

test("session selector state: sort mode cycling", () => {
  const selector = createSessionSelectorState();
  assert.equal(selector.sortMode, "threaded");
  cycleSessionSortMode(selector);
  assert.equal(selector.sortMode, "recent");
  cycleSessionSortMode(selector);
  assert.equal(selector.sortMode, "relevance");
  cycleSessionSortMode(selector);
  assert.equal(selector.sortMode, "threaded");
});

test("session selector state: name filter toggle", () => {
  const selector = createSessionSelectorState();
  assert.equal(selector.nameFilter, "all");
  toggleSessionNameFilter(selector);
  assert.equal(selector.nameFilter, "named");
  toggleSessionNameFilter(selector);
  assert.equal(selector.nameFilter, "all");
});

test("session selector state: name filter hides unnamed sessions", () => {
  const selector = createSessionSelectorState();
  selector.currentSessions = makeSessions();
  selector.nameFilter = "named";
  const nodes = getFilteredSessions(selector);
  // Only "My Session" has a name
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.session.name, "My Session");
});

test("session selector state: tree view shows parent-child relationships", () => {
  const selector = createSessionSelectorState();
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
  const nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0]!.session.name, "Parent");
  assert.equal(nodes[0]!.depth, 0);
  assert.equal(nodes[1]!.session.name, "Child");
  assert.equal(nodes[1]!.depth, 1);
});

test("session selector state: search query filters and sorts by relevance", () => {
  const selector = createSessionSelectorState();
  selector.sortMode = "relevance";
  selector.currentSessions = makeSessions();
  updateSessionSelectorQuery(selector, "Another");
  const nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.session.firstMessage, "Another session");
});

test("session selector state: getSelectedSessionPath returns correct path", () => {
  const selector = createSessionSelectorState();
  selector.currentSessions = makeSessions();
  selector.selectedIndex = 1;
  const nodes = getFilteredSessions(selector);
  // In threaded mode without search, sorted by modified desc
  const path = getSelectedSessionPath(selector);
  assert.equal(path, nodes[1]!.session.path);
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

test("session selector rendering includes scope and sort indicators", () => {
  const state = createInitialState("/repo");
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = makeSessions();
  const rendered = renderSessionSelector(state, 80).join("\n");
  assert.ok(rendered.includes("Resume Session"));
  assert.ok(rendered.includes("Current"));
  assert.ok(rendered.includes("Threaded"));
});

test("session selector rendering shows empty state for current folder", () => {
  const state = createInitialState("/repo");
  state.sessionSelector.open = true;
  state.sessionSelector.currentSessions = [];
  const rendered = renderSessionSelector(state, 80).join("\n");
  assert.ok(rendered.includes("No sessions in current folder"));
});
