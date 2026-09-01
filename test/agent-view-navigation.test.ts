import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  renderHome,
  clampHomeSelectedTabIndex,
  reindexWorkspaceTabs,
} from "./helpers/mixcode.js";
import { testOverlayHandle } from "./helpers/tui.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import type { ChatLine } from "../src/agent/runtime-types.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

function chatFor(chats: Record<string, ChatLine[]>): (sessionId: string) => ChatLine[] | undefined {
  return (sessionId) => chats[sessionId];
}

/**
 * RuntimeTab double: only the members the exercised production path reads are
 * supplied, but the `Partial` still checks their names and types against the
 * real RuntimeTab.
 */
function makeTui() {
  let renders = 0;
  const overlays: string[] = [];
  return {
    requestRender: () => {
      renders++;
    },
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string" ? component : (component.render?.(80).join("\n") ?? ""),
      );
      return testOverlayHandle();
    },
    hideOverlay: () => undefined,
    hasOverlay: () => false,
    get renders() {
      return renders;
    },
    get overlays() {
      return overlays;
    },
  };
}

function makeEditorActions(text = "", expanded?: string) {
  return {
    getText: () => text,
    getExpandedText: () => expanded ?? text,
    setText: (next: string) => {
      text = next;
    },
    insertTextAtCursor: (next: string) => {
      text += next;
    },
    addToHistory: (_text: string, _sessionId?: string) => undefined,
    submitCurrentText: () => undefined,
  };
}

// --- Left on empty input returns to Home ---

test("Left on empty input returns to MixCode Home and selects source agent", () => {
  const state = createInitialState("/repo");
  const tab1 = createTab(1, "s1", "/repo");
  const tab2 = createTab(2, "s2", "/repo");
  state.tabs.push(tab1, tab2);
  state.activeTabId = "s2";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D", // Left arrow
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(state.homeSelectedTabIndex, 1); // s2 is at index 1
});

test("Left on empty input does NOT return to Home when extension UI interaction is pending", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.waitingForInputs.push({ id: "ext-1", kind: "custom" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D", // Left arrow
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );

  assert.equal(result, undefined);
  assert.equal(state.activeTabId, "s1");
});

test("Left on non-empty input does NOT return to Home", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("hello");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D", // Left arrow
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );

  // Should not consume — let editor handle cursor movement
  assert.equal(result, undefined);
  assert.equal(state.activeTabId, "s1");
});

test("Left on empty input does NOT trigger when autocomplete is open", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D",
    tui,
    undefined,
    undefined,
    undefined,
    () => true, // autocomplete open
    editorActions,
  );

  assert.equal(result, undefined);
  assert.equal(state.activeTabId, "s1");
});

test("Left on empty input returns to MixCode Home and preserves vimMode", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D",
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(state.homeSelectedTabIndex, 0);
  assert.equal(tab.vimMode, true);
});

test("Left on non-empty input does NOT return to Home in vim mode", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("draft");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D",
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "s1");
  assert.equal(tab.vimMode, true);
});

test("Left on empty input does NOT trigger when already on config", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[D",
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );
  // On config, Up/Down/Right/Enter are handled but Left is not
  assert.notDeepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
});

// --- Home Agent View table navigation ---

test("Home Up/Down moves selected agent row", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo"),
    createTab(2, "s2", "/repo"),
    createTab(3, "s3", "/repo"),
  );
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();

  // Down
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 1);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 2);

  // Wrap at bottom
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 0);

  // Wrap at top
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 2);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 1);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 0);
});

test("Home Ctrl+F toggles non-idle filter and walks only matching agents", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Idle-A", status: "idle" }),
    createTab(2, "s2", "/repo", { title: "Busy", status: "running" }),
    createTab(3, "s3", "/repo", { title: "Idle-B", status: "idle" }),
    createTab(4, "s4", "/repo", { title: "Done", status: "idle", unreadDone: true }),
  );
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\x06", tui), { consume: true });
  assert.equal(state.homeNonIdleOnly, true);
  assert.equal(state.homeSelectedTabIndex, 1);

  const filteredRaw = renderHome(state, 100).join("\n");
  const filtered = stripAnsi(filteredRaw);
  const chipLine =
    filteredRaw.split("\n").find((line) => {
      const text = stripAnsi(line);
      return text.includes("non-idle") && !text.includes("Ctrl+F");
    }) ?? "";
  assert.match(chipLine, /\x1b\[48;/);
  assert.match(filtered, /Agents {2}· /);
  assert.match(filtered, /non-idle/);
  assert.match(filtered, /Busy/);
  assert.match(filtered, /Done/);
  assert.doesNotMatch(filtered, /Idle-A/);
  assert.doesNotMatch(filtered, /Idle-B/);
  assert.match(filtered, /Ctrl\+F: all/);
  assert.doesNotMatch(filtered, /Ctrl\+F: non-idle/);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 3);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 1);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x06", tui), { consume: true });
  assert.equal(state.homeNonIdleOnly, false);
  assert.equal(state.homeSelectedTabIndex, 1);
  assert.match(stripAnsi(renderHome(state, 100).join("\n")), /Idle-A/);
});

test("Home Ctrl+F empty filter still toggles off", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Idle-A", status: "idle" }),
    createTab(2, "s2", "/repo", { title: "Idle-B", status: "idle" }),
  );
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 1;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\x06", tui), { consume: true });
  assert.equal(state.homeNonIdleOnly, true);
  assert.equal(state.homeSelectedTabIndex, 1);
  const empty = stripAnsi(renderHome(state, 100).join("\n"));
  assert.match(empty, /No non-idle agents/);
  assert.doesNotMatch(empty, /Idle-A/);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.homeSelectedTabIndex, 1);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x06", tui), { consume: true });
  assert.equal(state.homeNonIdleOnly, false);
  assert.match(stripAnsi(renderHome(state, 100).join("\n")), /Idle-B/);
});

test("Home navigation takes priority over extension terminal input handlers", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let dispatches = 0;
  const runtime = testRuntime({
    dispatchTerminalInput: () => {
      dispatches++;
      return { consume: true };
    },
  });

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.homeSelectedTabIndex, 1);
  assert.equal(dispatches, 0);
});

test("Home Right activates selected agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 1;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true }); // Right
  assert.equal(state.activeTabId, "s2");
});

test("Home Enter expands paste markers before sending", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const prompted: string[] = [];
  const runtime = testRuntime({
    prompt: async (_sessionId: string, text: string) => {
      prompted.push(text);
    },
  });
  const editorActions = makeEditorActions(
    "[paste #1 +16 lines]",
    "PASTE-LINE-1\nPASTE-LINE-2\nPASTE-LINE-3",
  );

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    { consume: true },
  );
  await Promise.resolve();
  assert.deepEqual(prompted, ["PASTE-LINE-1\nPASTE-LINE-2\nPASTE-LINE-3"]);
  assert.equal(editorActions.getText(), "");
});

test("Home Ctrl+J inserts newline instead of submitting", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted = false;
  const runtime = testRuntime({
    prompt: async () => {
      prompted = true;
    },
  });
  const editorActions = makeEditorActions("line-one");

  // Ctrl+J is "\n", which also matchesKey("enter") — must not submit on Home.
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\n",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(state.activeTabId, "home");
  assert.equal(prompted, false);
  assert.equal(editorActions.getText(), "line-one\n");
});

test("Home Enter with whitespace-only input does not clear the editor", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted = false;
  const runtime = testRuntime({
    prompt: async () => {
      prompted = true;
    },
  });
  const editorActions = makeEditorActions("   \t  ");

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(state.activeTabId, "home");
  assert.equal(prompted, false);
  assert.equal(editorActions.getText(), "   \t  ");
});

test("Tab to Home selects the agent you left (not a stale homeSelectedTabIndex)", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s2";
  state.homeSelectedTabIndex = 0; // would wrongly target Agent-01
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  // Tab cycles config → s1 → s2 → config; from s2 next is config.
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\t",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(state.activeTabId, "home");
  assert.equal(state.homeSelectedTabIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
});

test("Home attach transfers vimMode to selected agent", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", {
    vimMode: true,
    vimPendingHome: true,
  });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[D",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editorActions,
    ),
    {
      consume: true,
    },
  );
  assert.equal(state.activeTabId, "home");
  assert.equal(first.vimMode, true);
  state.homeSelectedTabIndex = 1;

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.vimMode, false);
  assert.equal(first.vimPendingHome, false);
  assert.equal(second.vimMode, true);
  assert.equal(second.vimPendingHome, false);
});

test("Home attach does not create vimMode when none is active", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo");
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 1;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.vimMode, false);
  assert.equal(second.vimMode, false);
});

test("Home Enter with text sends message to selected agent and stays on Home", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }), createTab(2, "s2", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted: { sessionId: string; text: string } | undefined;
  const history: Array<{ text: string; sessionId?: string }> = [];
  let activeWhilePrompt: string | undefined;
  const runtime = testRuntime({
    prompt: (sessionId: string, text: string) => {
      prompted = { sessionId, text };
      activeWhilePrompt = state.activeTabId;
      return Promise.resolve();
    },
  });
  const editorActions = makeEditorActions("fix the bug");
  editorActions.addToHistory = (text, sessionId) => {
    history.push({ text, sessionId });
  };

  const result = handleMixCodeKeyInput(
    state,
    "\r",
    tui,
    undefined,
    runtime,
    undefined,
    () => false,
    editorActions,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(activeWhilePrompt, "home", "must not spoof activeTabId during Home send");
  assert.deepEqual(prompted, { sessionId: "s1", text: "fix the bug" });
  assert.deepEqual(history, [{ text: "fix the bug", sessionId: "s1" }]);
  assert.equal(editorActions.getText(), "");
});

test("Home Enter opens settings with the app configuration", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }));
  state.activeTabId = "home";
  const tui = makeTui();
  const editorActions = makeEditorActions("/settings");
  const settingsDeps = {
    settingsManager: SettingsManager.inMemory(),
    mixcodeFile: path.join(os.tmpdir(), "mixcode-home-settings.json"),
    piSettingsFile: path.join(os.tmpdir(), "pi-home-settings.json"),
  };

  const result = handleMixCodeKeyInput(
    state,
    "\r",
    tui,
    undefined,
    testRuntime({
      setHideThinkingBlock: async () => undefined,
      setShowCacheMissNotices: async () => undefined,
    }),
    undefined,
    () => false,
    editorActions,
    undefined,
    { settingsDeps },
  );
  await Bun.sleep(50);

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(state.settingsPanel.open, true);
  // The injected piSettingsFile proves the panel is wired to settingsDeps
  // rather than to a default settings location.
  assert.match(stripAnsi(tui.overlays.at(-1) ?? ""), /Settings[\s\S]*pi-home-settings\.json/);
});

test("Home Enter runs local slash commands on selected agent (not as model prompt)", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Worker" });
  state.tabs.push(tab);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted = false;
  const runtime = testRuntime({
    prompt: async () => {
      prompted = true;
    },
  });
  const editorActions = makeEditorActions("/mark-done");

  const result = handleMixCodeKeyInput(
    state,
    "\r",
    tui,
    undefined,
    runtime,
    undefined,
    () => false,
    editorActions,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(prompted, false);
  assert.equal(tab.status, "done");
  assert.equal(tab.unreadDone, true);
  assert.equal(editorActions.getText(), "");
});

test("Home Enter send does not clear unread ! badge without viewing the tab", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    title: "Worker",
    status: "done",
    unreadDone: true,
  });
  state.tabs.push(tab);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const runtime = testRuntime({
    prompt: async () => undefined,
  });
  const editorActions = makeEditorActions("follow-up from home");

  handleMixCodeKeyInput(
    state,
    "\r",
    tui,
    undefined,
    runtime,
    undefined,
    () => false,
    editorActions,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(state.activeTabId, "home");
  assert.equal(tab.unreadDone, true);
  assert.equal(tab.status, "done");
});

test("Home Enter restores text and shows transient error when selected agent rejects prompt", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }), createTab(2, "s2", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const runtime = testRuntime({
    prompt: () => Promise.reject(new Error("Cannot prompt while compaction is running")),
  });
  const editorActions = makeEditorActions("fix the bug");

  const result = handleMixCodeKeyInput(
    state,
    "\r",
    tui,
    undefined,
    runtime,
    undefined,
    () => false,
    editorActions,
  );
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(editorActions.getText(), "fix the bug");
  assert.match(tui.overlays.at(-1) ?? "", /Cannot prompt while compaction is running/);
});

test("Home Enter passes workspaceFile so /save-workspace works", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-home-ws-"));
  const workspaceFile = path.join(dir, "workspaces.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    state.activeTabId = "home";
    state.homeSelectedTabIndex = 0;
    const tui = makeTui();
    const runtime = testRuntime({
      prompt: async () => undefined,
      getTab: () => undefined,
    });
    const editorActions = makeEditorActions("/save-workspace from-home");

    const result = handleMixCodeKeyInput(
      state,
      "\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
      undefined,
      { workspaceFile },
    );
    await Bun.sleep(50);

    assert.deepEqual(result, { consume: true });
    assert.equal(state.activeTabId, "home");
    // Must not surface "Workspace file is not configured".
    assert.equal(
      tui.overlays.some((o) => o.includes("Workspace file is not configured")),
      false,
    );
    const saved = JSON.parse(await fsPromises.readFile(workspaceFile, "utf8")) as unknown[];
    assert.ok(Array.isArray(saved) && saved.length >= 1);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("Home /clear stays on Home after session replacement", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const runtime = testRuntime({
    prompt: async () => undefined,
    getTab: () => undefined,
    clearTab: async (sessionId: string) => {
      assert.equal(sessionId, "s1");
      tab.sessionId = "s1-cleared";
      return testRuntimeTab({ tab });
    },
  });
  const editorActions = makeEditorActions("/clear");

  handleMixCodeKeyInput(
    state,
    "\r",
    tui,
    undefined,
    runtime,
    undefined,
    () => false,
    editorActions,
  );
  await Bun.sleep(50);

  assert.equal(state.activeTabId, "home");
  assert.equal(tab.sessionId, "s1-cleared");
  assert.equal(state.homeSelectedTabIndex, 0);
});

test("Home Right does NOT attach when editor has text", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const editorActions = makeEditorActions("some text");

  const result = handleMixCodeKeyInput(
    state,
    "\x1b[C",
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );

  // Leave Right to the editor for cursor movement when input is non-empty.
  assert.notDeepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(editorActions.getText(), "some text");
});

test("Home Right/Enter does NOT consume when no tabs exist", () => {
  const state = createInitialState("/repo");
  state.activeTabId = "home";
  const tui = makeTui();

  const result = handleMixCodeKeyInput(state, "\x1b[C", tui); // Right
  // Should not consume because tabs.length === 0
  assert.notDeepEqual(result, { consume: true });
});

test("Home submit with no agent tabs throws Error: No agent to send to", async () => {
  const state = createInitialState("/repo");
  state.activeTabId = "home";
  await assert.rejects(
    () => handleSubmittedInput(state, testRuntime(), "hello", makeTui()),
    /Error: No agent to send to/,
  );
});

test("Home Up/Down does NOT consume when no tabs exist", () => {
  const state = createInitialState("/repo");
  state.activeTabId = "home";
  const tui = makeTui();

  const result = handleMixCodeKeyInput(state, "\x1b[B", tui); // Down
  assert.notDeepEqual(result, { consume: true });
});

// --- renderHome shows Agent View table ---

test("renderHome shows the app version on the Home panel border", async () => {
  const pkg = (await import("../package.json", { with: { type: "json" } })).default;
  const state = createInitialState("/repo");
  state.activeTabId = "home";

  // Wide terminal (logo shown) and narrow terminal (logo hidden) both show it.
  assert.ok(stripAnsi(renderHome(state, 100).join("\n")).includes(`v${pkg.version}`));
  assert.ok(stripAnsi(renderHome(state, 50).join("\n")).includes(`v${pkg.version}`));
});

test("renderHome hides the MIXCODE logo when it would dominate the Home viewport", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const banner = /███╗ {3}███╗/;

  assert.match(stripAnsi(renderHome(state, 100, undefined, 0, 40).join("\n")), banner);
  assert.doesNotMatch(stripAnsi(renderHome(state, 100, undefined, 0, 20).join("\n")), banner);
  assert.doesNotMatch(stripAnsi(renderHome(state, 50).join("\n")), banner);
});

test("renderHome paints the selected agent toast", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.toast = { type: "info", message: "Hidden extension messages shown", createdAt: Date.now() };
  state.tabs.push(tab);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;

  const output = renderHome(state, 100).join("\n");
  assert.match(output, /Hidden extension messages shown/);
});

test("renderHome shows Agent View table with agent rows", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { status: "running", title: "Worker-01" }),
    createTab(2, "s2", "/repo", { status: "idle", title: "Research", unreadDone: true }),
  );
  state.homeSelectedTabIndex = 0;
  const output = renderHome(state, 100).join("\n");

  assert.match(output, /Worker-01/);
  assert.match(output, /Research/);
  assert.match(output, /running/);
  assert.match(output, /No output yet/);
  assert.match(output, /Agents/);
});

test("renderHome colors Agent View glyph and title together for notable states", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      status: "idle",
      title: "Question",
      extensionUi: {
        statuses: [],
        widgets: [],
        toolsExpanded: false,
        waitingForInputs: [{ id: "q", kind: "custom" }],
        workingVisible: true,
      },
    }),
    createTab(2, "s2", "/repo", { status: "running", title: "Working" }),
    createTab(3, "s3", "/repo", { status: "idle", title: "Idle" }),
  );
  const output = renderHome(state, 120).join("\n");

  assert.match(output, /\x1b\[[0-9;:]*m\? Question\x1b\[39m/);
  assert.match(stripAnsi(output), /Question .*\[input\]/);
  assert.doesNotMatch(stripAnsi(output), /Question .*\[idle\]/);
  assert.match(output, /\x1b\[[0-9;:]*m● Working\x1b\[39m/);
  assert.doesNotMatch(output, /\x1b\[[0-9;:]*m- Idle\x1b\[39m/);
});

test("renderHome mirrors Agent Tab glyphs in Agent View cards", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { status: "error", title: "Broken" }),
    createTab(2, "s2", "/repo", {
      status: "idle",
      title: "Question",
      extensionUi: {
        statuses: [],
        widgets: [],
        toolsExpanded: false,
        waitingForInputs: [{ id: "q", kind: "custom" }],
        workingVisible: true,
      },
    }),
    createTab(3, "s3", "/repo", { status: "running", title: "Working" }),
    createTab(4, "s4", "/repo", { status: "idle", title: "Done", unreadDone: true }),
    createTab(5, "s5", "/repo", { status: "idle", title: "Idle" }),
  );
  const output = stripAnsi(renderHome(state, 120).join("\n"));

  assert.match(output, /x Broken/);
  assert.match(output, /\? Question/);
  assert.match(output, /● Working/);
  assert.match(output, /! Done/);
  assert.match(output, /- Idle/);
});

test("renderHome shows empty state when no tabs", () => {
  const state = createInitialState("/repo");
  const output = renderHome(state, 100).join("\n");

  assert.match(output, /No agent sessions/);
});

test("renderHome fills the selected card with selection background", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "First" }),
    createTab(2, "s2", "/repo", { title: "Second" }),
  );
  state.homeSelectedTabIndex = 1;
  const output = renderHome(state, 100).join("\n");
  const plain = stripAnsi(output);

  assert.match(plain, /› - Second/);
  const selectedLine =
    output.split("\n").find((line) => stripAnsi(line).includes("› - Second")) ?? "";
  assert.match(selectedLine, /\x1b\[48;/);
  const unselectedLine =
    output.split("\n").find((line) => {
      const text = stripAnsi(line);
      return text.includes("First") && !text.includes("›");
    }) ?? "";
  assert.doesNotMatch(unselectedLine, /\x1b\[48;/);
});

test("renderHome shows spinner for working agent cards", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      status: "running",
      title: "Worker",
      workingStartedAt: new Date(Date.now() - 65_000).toISOString(),
    }),
    createTab(2, "s2", "/repo", { status: "idle", title: "Idle" }),
  );
  const plain = stripAnsi(renderHome(state, 100).join("\n"));

  assert.match(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \[running\]/);
  assert.match(plain, /faux-1 · \?\/200k · running 1m 0[5-9]s/);
  assert.doesNotMatch(plain, / · now/);
  assert.match(plain, /Idle .*\[idle\]/);
  assert.doesNotMatch(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \[idle\]/);
});

test("renderHome shows preview panel below card list for selected agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Previewer" }));
  state.homeSelectedTabIndex = 0;
  const output = stripAnsi(
    renderHome(
      state,
      100,
      undefined,
      0,
      undefined,
      chatFor({
        s1: [
          { role: "user", text: "please explain" },
          { role: "tool", text: "read file" },
          { role: "tool", text: "run tests" },
          { role: "assistant", text: "Here is the latest assistant output\nwith details" },
          { role: "tool", text: "check diff" },
        ],
      }),
    ).join("\n"),
  );

  // Consecutive tool calls collapse to middle dots plus an exact count.
  assert.match(output, /user:.*please explain/);
  assert.match(output, /tools: ·· {2}2/);
  assert.match(output, /assistant:.*Here is the latest assistant output with details/);
  assert.match(output, /tools: · {2}1/);
  assert.doesNotMatch(output, /read file|run tests|check diff|tool-call:/);
});

test("renderHome respects row budget for compact Agent View", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Previewer" }));
  state.homeSelectedTabIndex = 0;

  const lines = renderHome(
    state,
    100,
    undefined,
    0,
    9,
    chatFor({ s1: [{ role: "assistant", text: "Long preview ".repeat(50) }] }),
  );
  const output = stripAnsi(lines.join("\n"));

  assert.equal(lines.length, 9);
  assert.match(output, /Agents/);
  // Tight budgets keep the navigation hint; card/preview text may be clipped.
  assert.match(output, /↑\/↓: select|→: attach|Enter: send|Tab: cycle tabs/);
  assert.doesNotMatch(output, /^\.\.\.$/m);
  assert.doesNotMatch(output, /newer below/);
});

test("renderHome fills a short viewport so the editor is not separated by a blank gap", () => {
  const state = createInitialState("/repo");
  for (let i = 1; i <= 8; i++) {
    state.tabs.push(createTab(i, `s${i}`, "/repo", { title: `Agent-${i}` }));
  }
  state.homeSelectedTabIndex = 3;
  const lines = renderHome(state, 80, undefined, 0, 16);
  assert.equal(lines.length, 16);
  const plain = stripAnsi(lines.join("\n"));
  assert.match(plain, /↑\/↓: select/);
  assert.doesNotMatch(plain, /user:/);
});

test("renderHome hides the message preview on a short viewport and keeps the hint", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Previewer" }));
  state.homeSelectedTabIndex = 0;

  const output = stripAnsi(
    renderHome(
      state,
      100,
      undefined,
      0,
      12,
      chatFor({
        s1: [
          { role: "user", text: "please explain" },
          { role: "assistant", text: "Here is the latest assistant output" },
        ],
      }),
    ).join("\n"),
  );
  assert.match(output, /Previewer/);
  assert.match(output, /↑\/↓: select|Ctrl\+F/);
  assert.doesNotMatch(output, /user:.*please explain/);
  assert.doesNotMatch(output, /assistant:.*Here is the latest assistant output/);
});

test("renderHome pins the message preview above the hint when the viewport is tall", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Previewer" }));
  state.homeSelectedTabIndex = 0;

  const lines = renderHome(
    state,
    100,
    undefined,
    0,
    48,
    chatFor({
      s1: Array.from({ length: 7 }, (_, index) => ({
        role: "assistant" as const,
        text: `message ${index + 1}`,
      })),
    }),
  ).map((line) => stripAnsi(line));
  const output = lines.join("\n");
  const hintIndex = lines.findIndex((line) => line.includes("↑/↓: select"));
  const previewIndex = lines.findIndex((line) => line.includes("assistant: message"));
  assert.ok(hintIndex > 0);
  assert.ok(previewIndex >= 0);
  assert.ok(previewIndex < hintIndex);
  assert.match(output, /assistant: message 7/);
  assert.doesNotMatch(output, /newer below/);
  assert.ok(!/┘\s*\n(?:\s*│\s*│\s*\n)+\s*─/.test(output));
});

test("renderHome does not leave a blank gap between windowed cards and preview", () => {
  const state = createInitialState("/repo");
  const chats: Record<string, ChatLine[]> = {};
  for (let i = 1; i <= 8; i++) {
    state.tabs.push(createTab(i, `s${i}`, "/repo", { title: `Agent-${i}` }));
    chats[`s${i}`] = [{ role: "assistant", text: `message ${i}` }];
  }
  state.homeSelectedTabIndex = 3;

  const lines = renderHome(state, 100, undefined, 0, 48, chatFor(chats)).map((line) =>
    stripAnsi(line).trim(),
  );
  const newer = lines.findIndex((line) => line.includes("newer below"));
  const older = lines.findIndex((line) => line.includes("older above"));
  const preview = lines.findIndex((line) => line.includes("assistant: message"));
  const listEnd = Math.max(newer, ...lines.map((line, index) => (line.includes("┘") ? index : -1)));
  assert.ok(older >= 0 || newer >= 0);
  assert.ok(preview > listEnd);
  const gap = lines.slice(listEnd + 1, preview).filter((line) => line === "│" || line === "");
  assert.equal(gap.length, 0);
});

test("renderHome shows compact preview for all cards including selected", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "First" }),
    createTab(2, "s2", "/repo", { title: "Second" }),
  );
  state.homeSelectedTabIndex = 0;
  const output = stripAnsi(
    renderHome(
      state,
      100,
      undefined,
      0,
      undefined,
      chatFor({
        s1: [{ role: "assistant", text: "First output" }],
        s2: [{ role: "assistant", text: "Second output" }],
      }),
    ).join("\n"),
  );

  // Both cards show compact ⎿ preview
  assert.match(output, /⎿ First output/);
  assert.match(output, /⎿ Second output/);
});

test("renderHome uses the same 4-row card for selected and unselected agents", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      title: "First",
      currentContextTokens: 21_000,
      lastWorkedAt: new Date(Date.now() - 5_000).toISOString(),
    }),
    createTab(2, "s2", "/repo", {
      title: "Second",
      model: {
        provider: "x",
        modelId: "grok-4.6",
        displayName: "x/grok-4.6",
        contextWindow: 500_000,
      },
      contextLimit: 500_000,
      currentContextTokens: 8_000,
    }),
  );
  state.homeSelectedTabIndex = 0;
  const rendered = renderHome(
    state,
    100,
    undefined,
    0,
    undefined,
    chatFor({
      s1: [{ role: "assistant", text: "First output" }],
      s2: [{ role: "assistant", text: "Second output" }],
    }),
  );
  const plainLines = rendered.map((line) => stripAnsi(line));
  const plain = plainLines.join("\n");

  assert.doesNotMatch(plain, /Project /);
  assert.doesNotMatch(plain, /Updated/);

  const selected = plainLines.findIndex((line) => line.includes("›") && line.includes("First"));
  assert.ok(selected >= 0);
  assert.match(plainLines[selected]!, /\[idle\]/);
  assert.match(plainLines[selected + 1]!, /faux-1 · 21k\/200k · [0-5]s ago/);
  assert.match(plainLines[selected + 2]!, /⎿ First output/);
  assert.match(plainLines[selected + 3]!, /┘/);
  assert.match(rendered[selected]!, /\x1b\[48;/);

  const unselected = plainLines.findIndex((line) => line.includes("Second") && line.includes("┌"));
  assert.ok(unselected >= 0);
  assert.match(plainLines[unselected]!, /\[idle\]/);
  assert.match(plainLines[unselected + 1]!, /grok-4\.6 · 8k\/500k/);
  assert.match(plainLines[unselected + 2]!, /⎿ Second output/);
  assert.match(plainLines[unselected + 3]!, /┘/);
  assert.doesNotMatch(rendered[unselected]!, /\x1b\[48;/);
});

test("renderHome dynamically windows agent cards around selection", () => {
  const state = createInitialState("/repo");
  for (let i = 1; i <= 6; i++) {
    state.tabs.push(createTab(i, `s${i}`, "/repo", { title: `Agent-${i}` }));
  }
  state.homeSelectedTabIndex = 5;
  const output = stripAnsi(renderHome(state, 100, undefined, 0, 18).join("\n"));

  assert.match(output, /› - Agent-6/);
  assert.doesNotMatch(output, /Agent-1/);
});

test("renderHome shows older above / newer below when agent cards are windowed", () => {
  const state = createInitialState("/repo");
  for (let i = 1; i <= 6; i++) {
    state.tabs.push(createTab(i, `s${i}`, "/repo", { title: `Agent-${i}` }));
  }

  state.homeSelectedTabIndex = 5;
  const bottom = stripAnsi(renderHome(state, 100, undefined, 0, 26).join("\n"));
  assert.match(bottom, /↑ older above/);
  assert.match(bottom, /› - Agent-6/);
  assert.doesNotMatch(bottom, /Agent-1/);
  assert.doesNotMatch(bottom, /↓ newer below/);

  state.homeSelectedTabIndex = 0;
  const top = stripAnsi(renderHome(state, 100, undefined, 0, 26).join("\n"));
  assert.match(top, /↓ newer below/);
  assert.match(top, /› - Agent-1/);
  assert.doesNotMatch(top, /Agent-6/);
  assert.doesNotMatch(top, /↑ older above/);
});

test("renderHome lists all package updates without a hidden-count summary", () => {
  const state = createInitialState("/repo");
  state.packageUpdates = ["one", "two", "three", "four"];
  const output = renderHome(state, 100).join("\n");

  assert.match(output, /- one/);
  assert.match(output, /- two/);
  assert.match(output, /- three/);
  assert.match(output, /- four/);
  assert.doesNotMatch(output, /more/);
  const updateLine =
    output.split("\n").find((line) => line.includes("Package Updates Available")) ?? "";
  assert.doesNotMatch(updateLine, /\x1b\[48;/);
});

// --- Selection clamping ---

test("homeSelectedTabIndex clamps when tab is closed", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 1;

  // Import closeAgentTab
  const { closeAgentTab } = await import("./helpers/mixcode.js");
  closeAgentTab(state, "s2");

  assert.equal(state.homeSelectedTabIndex, 0);
});

test("closing an earlier tab keeps the Home-selected agent", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "a", "/repo", { title: "A" }),
    createTab(2, "b", "/repo", { title: "B" }),
    createTab(3, "c", "/repo", { title: "C" }),
  );
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 1; // B

  const { closeAgentTab, getActiveTab } = await import("./helpers/mixcode.js");
  closeAgentTab(state, "a");

  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["b", "c"],
  );
  assert.equal(state.homeSelectedTabIndex, 0);
  assert.equal(getActiveTab(state)?.sessionId, "b");
});

test("homeSelectedTabIndex clamps when workspace restore removes selected tab", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo"),
    createTab(2, "s2", "/repo"),
    createTab(3, "s3", "/repo"),
  );
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 2;

  state.tabs = state.tabs.filter((tab) => tab.sessionId === "s1");
  reindexWorkspaceTabs(state);
  clampHomeSelectedTabIndex(state);

  assert.equal(state.homeSelectedTabIndex, 0);
  state.activeTabId = "home";
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", makeTui()), { consume: true });
  assert.equal(state.activeTabId, "s1");
});

// --- Round-trip: Left from agent, then Right back ---

test("Left from agent then Right from Home returns to same agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo", { vimMode: true }));
  state.activeTabId = "s2";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  // Left from s2 (vim mode)
  handleMixCodeKeyInput(
    state,
    "\x1b[D",
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    editorActions,
  );
  assert.equal(state.activeTabId, "home");
  assert.equal(state.homeSelectedTabIndex, 1);

  // Right from Home
  handleMixCodeKeyInput(state, "\x1b[C", tui);
  assert.equal(state.activeTabId, "s2");
});
