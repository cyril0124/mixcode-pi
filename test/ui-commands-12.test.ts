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
    createTab: async () => undefined,
    getTab: () => undefined,
    closeTab: async () => undefined,
  };

  handleMixCodeKeyInput(state, "\r", tui, undefined, runtime);
  // Wait for async createTab + switch
  await new Promise((resolve) => setTimeout(resolve, 50));

  // Should have created a new tab and switched its session
  assert.equal(switchedTo, "/sessions/session-a.jsonl");
  assert.equal(state.sessionSelector.open, false);
  // A new tab should have been appended
  assert.equal(state.tabs.length, 2);
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
  assert.match(closedTab, /^session-/);
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

test("bug: named filter + scope toggle should still show named sessions", () => {
  const state = createInitialState("/repo");
  const selector = state.sessionSelector;
  selector.open = true;
  // "My Session" has a name, "Another session" does not
  selector.currentSessions = makeSessions();
  selector.allSessions = makeSessions();
  selector.allLoaded = true;

  // Switch to named filter
  toggleSessionNameFilter(selector);
  assert.equal(selector.nameFilter, "named");

  // Should see 1 named session in current scope
  let nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0]!.session.name, "My Session");

  // Toggle to "all" scope
  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "all");

  // Should still see 1 named session in all scope
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, `Expected 1 named session in 'all' scope, got ${nodes.length}`);
  assert.equal(nodes[0]!.session.name, "My Session");

  // Toggle back to "current" scope
  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "current");

  // Should still see 1 named session
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, `Expected 1 named session back in 'current' scope, got ${nodes.length}`);
  assert.equal(nodes[0]!.session.name, "My Session");
});

test("bug: named filter + scope toggle with allSessions not yet loaded shows empty", () => {
  const state = createInitialState("/repo");
  const selector = state.sessionSelector;
  selector.open = true;
  selector.currentSessions = makeSessions();
  // allSessions NOT loaded yet (default state)
  assert.equal(selector.allLoaded, false);
  assert.deepEqual(selector.allSessions, []);

  // Switch to named filter
  toggleSessionNameFilter(selector);
  assert.equal(selector.nameFilter, "named");

  // Current scope: 1 named session visible
  let nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1);

  // Toggle to "all" scope — allSessions is empty because not loaded
  toggleSessionSelectorScope(selector);
  nodes = getFilteredSessions(selector);
  // This is 0 because allSessions hasn't been loaded yet — expected behavior
  assert.equal(nodes.length, 0);

  // Toggle back to "current" — should recover and show the named session again
  toggleSessionSelectorScope(selector);
  assert.equal(selector.scope, "current");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, `Expected 1 named session after toggling back, got ${nodes.length}`);
});

test("bug: ctrl+n then tab via key handler reproduces empty list", async () => {
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
  // Runtime that provides listAllSessions (async, resolves with same sessions)
  const runtime = {
    listAllSessions: async () => makeSessions(),
    extensionSwitchSession: async () => ({ cancelled: false }),
  };

  // Ctrl+N: toggle named filter
  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime); // ctrl+n = 0x0e
  assert.equal(selector.nameFilter, "named");
  let nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, "Should see 1 named session after Ctrl+N");

  // Tab: toggle scope to "all" (triggers async load)
  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "all");

  // Wait for async loadAllSessions to complete
  await new Promise((resolve) => setTimeout(resolve, 50));

  // After load, allSessions should be populated
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, `Expected 1 named session in 'all' after load, got ${nodes.length}`);

  // Tab: toggle back to "current"
  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "current");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, `Expected 1 named session back in 'current', got ${nodes.length}`);
});

test("bug: named filter with no named sessions shows empty in both scopes", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const selector = state.sessionSelector;
  selector.open = true;
  // All sessions have NO name
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

  // Initially: 2 sessions visible
  let nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 2);

  // Ctrl+N: named filter
  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "named");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 0, "No named sessions, should be empty");

  // Tab: switch to all
  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  await new Promise((resolve) => setTimeout(resolve, 50));
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 0, "Still no named sessions in all scope");

  // Ctrl+N again: back to "all" filter
  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "all");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 2, `Should see all 2 sessions after toggling filter back, got ${nodes.length}`);

  // Tab: back to current
  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "current");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 2, `Should see all 2 sessions in current scope, got ${nodes.length}`);
});

test("bug: exact user scenario - named + tab + tab + ctrl+n still shows nothing", async () => {
  // Reproduce: open resume, ctrl+n, tab (see named), tab again (see nothing),
  // ctrl+n (still nothing)
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const selector = state.sessionSelector;
  selector.open = true;

  // Current folder has NO named sessions (only unnamed)
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
  // All scope has a named session from ANOTHER workdir
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

  // Step 1: Ctrl+N → named mode (current scope has 0 named sessions)
  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "named");
  assert.equal(selector.scope, "current");
  let nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 0, "Step 1: no named sessions in current");

  // Step 2: Tab → switch to all (triggers load, has 1 named session)
  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "all");
  await new Promise((resolve) => setTimeout(resolve, 50));
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, "Step 2: should see 1 named session in all scope");

  // Step 3: Tab → switch back to current (0 named sessions here)
  handleMixCodeKeyInput(state, "\t", tui, undefined, runtime);
  assert.equal(selector.scope, "current");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 0, "Step 3: no named sessions in current scope");

  // Step 4: Ctrl+N → disable named filter, should see ALL current sessions
  handleMixCodeKeyInput(state, "\x0e", tui, undefined, runtime);
  assert.equal(selector.nameFilter, "all");
  nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 1, `Step 4: should see 1 unnamed session in current, got ${nodes.length}`);
});

test("bug: shift+tab should not corrupt search query", () => {
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

  // Shift+Tab sends ESC [ Z in most terminals
  handleMixCodeKeyInput(state, "\x1b[Z", tui);

  // Query should remain empty (shift+tab should not be treated as text input)
  assert.equal(selector.query, "", "shift+tab should not be appended to query");
  // Sessions should still be visible
  const nodes = getFilteredSessions(selector);
  assert.equal(nodes.length, 2, `Should still see all sessions, got ${nodes.length}`);
});
