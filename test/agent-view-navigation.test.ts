import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  renderConfig,
  restoreWorkspaceOrder,
} from "../src/index.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

function makeTui() {
  let renders = 0;
  return {
    requestRender: () => {
      renders++;
    },
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
    get renders() {
      return renders;
    },
  };
}

function makeEditorActions(text = "") {
  return {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    insertTextAtCursor: (next: string) => {
      text += next;
    },
    addToHistory: () => undefined,
    submitCurrentText: () => undefined,
  };
}

// --- Left on empty input returns to Home (vim mode only) ---

test("Left on empty input returns to MixCode Home and selects source agent in vim mode", () => {
  const state = createInitialState("/repo");
  const tab1 = createTab(1, "s1", "/repo");
  const tab2 = createTab(2, "s2", "/repo", { vimMode: true });
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
  assert.equal(state.activeTabId, "config");
  assert.equal(state.homeSelectedTabIndex, 1); // s2 is at index 1
});

test("Left on empty input does NOT return to Home without vim mode", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
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

test("Left on empty input does NOT trigger when preview is open", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { previewOpen: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions);
  assert.equal(state.activeTabId, "s1");
});

test("Left on empty input returns to MixCode Home in vim mode and preserves vimMode", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions);

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "config");
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

  const result = handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions);

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "s1");
  assert.equal(tab.vimMode, true);
});

test("Left on empty input does NOT trigger when already on config", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "config";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  const result = handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions);
  // On config, Up/Down/Right/Enter are handled but Left is not
  assert.equal(state.activeTabId, "config");
});

// --- Home Agent View table navigation ---

test("Home Up/Down moves selected agent row", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"), createTab(3, "s3", "/repo"));
  state.activeTabId = "config";
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

test("Home navigation takes priority over extension terminal input handlers", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let dispatches = 0;
  const runtime = {
    dispatchTerminalInput: () => {
      dispatches++;
      return { consume: true };
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(state.homeSelectedTabIndex, 1);
  assert.equal(dispatches, 0);
});

test("Home Right activates selected agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 1;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true }); // Right
  assert.equal(state.activeTabId, "s2");
});

test("Home Enter activates selected agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true }); // Enter
  assert.equal(state.activeTabId, "s1");
});

test("Home attach transfers vimMode to selected agent", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", {
    vimMode: true,
    vimPendingEscapeAt: 123,
    vimPendingHome: true,
  });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  const tui = makeTui();
  const editorActions = makeEditorActions("");

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions), {
    consume: true,
  });
  assert.equal(state.activeTabId, "config");
  assert.equal(first.vimMode, true);
  state.homeSelectedTabIndex = 1;

  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.vimMode, false);
  assert.equal(first.vimPendingEscapeAt, undefined);
  assert.equal(first.vimPendingHome, false);
  assert.equal(second.vimMode, true);
  assert.equal(second.vimPendingEscapeAt, undefined);
  assert.equal(second.vimPendingHome, false);
});

test("Home attach does not create vimMode when none is active", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo");
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 1;
  const tui = makeTui();

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.vimMode, false);
  assert.equal(second.vimMode, false);
});

test("Home Right/Enter does NOT consume when no tabs exist", () => {
  const state = createInitialState("/repo");
  state.activeTabId = "config";
  const tui = makeTui();

  const result = handleMixCodeKeyInput(state, "\x1b[C", tui); // Right
  // Should not consume because tabs.length === 0
  assert.notDeepEqual(result, { consume: true });
});

test("Home Up/Down does NOT consume when no tabs exist", () => {
  const state = createInitialState("/repo");
  state.activeTabId = "config";
  const tui = makeTui();

  const result = handleMixCodeKeyInput(state, "\x1b[B", tui); // Down
  assert.notDeepEqual(result, { consume: true });
});

// --- renderConfig shows Agent View table ---

test("renderConfig shows Agent View table with agent rows", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { status: "running", title: "Worker-01" }),
    createTab(2, "s2", "/repo", { status: "idle", title: "Research", unreadDone: true }),
  );
  state.homeSelectedTabIndex = 0;
  const output = renderConfig(state, 100).join("\n");

  assert.match(output, /Worker-01/);
  assert.match(output, /Research/);
  assert.match(output, /running/);
  assert.match(output, /No output yet/);
  assert.match(output, /Agents/);
});

test("renderConfig colors Agent View glyph and title together for notable states", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      status: "idle",
      title: "Question",
      pendingDialogs: [
        {
          requestId: "q",
          sessionId: "s1",
          questions: [],
          currentQuestionIndex: 0,
          highlightedOptionIndices: [],
          selectedAnswers: [],
          customAnswers: [],
          dirty: false,
        },
      ],
    }),
    createTab(2, "s2", "/repo", { status: "running", title: "Working" }),
    createTab(3, "s3", "/repo", { status: "idle", title: "Idle" }),
  );
  const output = renderConfig(state, 120).join("\n");

  assert.match(output, /\x1b\[[0-9;:]*m\? Question\x1b\[39m/);
  assert.match(output, /\x1b\[[0-9;:]*m\* Working\x1b\[39m/);
  assert.doesNotMatch(output, /\x1b\[[0-9;:]*m- Idle\x1b\[39m/);
});

test("renderConfig mirrors Agent Tab glyphs in Agent View cards", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { status: "error", title: "Broken" }),
    createTab(2, "s2", "/repo", {
      status: "idle",
      title: "Question",
      pendingDialogs: [
        {
          requestId: "q",
          sessionId: "s2",
          questions: [],
          currentQuestionIndex: 0,
          highlightedOptionIndices: [],
          selectedAnswers: [],
          customAnswers: [],
          dirty: false,
        },
      ],
    }),
    createTab(3, "s3", "/repo", { status: "running", title: "Working" }),
    createTab(4, "s4", "/repo", { status: "idle", title: "Done", unreadDone: true }),
    createTab(5, "s5", "/repo", { status: "idle", title: "Idle" }),
  );
  const output = stripAnsi(renderConfig(state, 120).join("\n"));

  assert.match(output, /x Broken/);
  assert.match(output, /\? Question/);
  assert.match(output, /\* Working/);
  assert.match(output, /! Done/);
  assert.match(output, /- Idle/);
});

test("renderConfig shows empty state when no tabs", () => {
  const state = createInitialState("/repo");
  const output = renderConfig(state, 100).join("\n");

  assert.match(output, /No agent sessions/);
});

test("renderConfig marks selected card without selection background", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "First" }),
    createTab(2, "s2", "/repo", { title: "Second" }),
  );
  state.homeSelectedTabIndex = 1;
  const output = renderConfig(state, 100).join("\n");
  const plain = stripAnsi(output);

  // The selected card should use only the › marker plus an accent border, not any background fill.
  assert.match(plain, /› - Second/);
  const selectedLine = output.split("\n").find((line) => stripAnsi(line).includes("› - Second")) ?? "";
  assert.doesNotMatch(selectedLine, /\x1b\[48;/);
});

test("renderConfig shows spinner for working agent cards", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      status: "running",
      title: "Worker",
      workingStartedAt: new Date().toISOString(),
    }),
    createTab(2, "s2", "/repo", { status: "idle", title: "Idle" }),
  );
  const plain = stripAnsi(renderConfig(state, 100).join("\n"));

  assert.match(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \[running\]/);
  assert.match(plain, /Idle .*\[idle\]/);
  assert.doesNotMatch(plain, /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] \[idle\]/);
});

test("renderConfig shows latest assistant preview in agent card", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      title: "Previewer",
      previewMessages: [
        { role: "user", text: "please explain" },
        { role: "assistant", text: "Here is the latest assistant output\nwith details" },
      ],
    }),
  );
  const output = renderConfig(state, 100).join("\n");

  assert.match(output, /⎿ Here is the latest assistant output with details/);
});

test("renderConfig dynamically windows agent cards around selection", () => {
  const state = createInitialState("/repo");
  for (let i = 1; i <= 6; i++) {
    state.tabs.push(createTab(i, `s${i}`, "/repo", { title: `Agent-${i}` }));
  }
  state.homeSelectedTabIndex = 5;
  const output = stripAnsi(renderConfig(state, 100, undefined, 0, 18).join("\n"));

  assert.match(output, /› - Agent-6/);
  assert.doesNotMatch(output, /Agent-1/);
});

test("renderConfig lists all package updates without a hidden-count summary", () => {
  const state = createInitialState("/repo");
  state.packageUpdates = ["one", "two", "three", "four"];
  const output = renderConfig(state, 100).join("\n");

  assert.match(output, /- one/);
  assert.match(output, /- two/);
  assert.match(output, /- three/);
  assert.match(output, /- four/);
  assert.doesNotMatch(output, /more/);
  const updateLine = output.split("\n").find((line) => line.includes("Package Updates Available")) ?? "";
  assert.doesNotMatch(updateLine, /\x1b\[48;/);
});

// --- Selection clamping ---

test("homeSelectedTabIndex clamps when tab is closed", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 1;

  // Import closeAgentTab
  const { closeAgentTab } = await import("../src/index.js");
  closeAgentTab(state, "s2");

  assert.equal(state.homeSelectedTabIndex, 0);
});

test("homeSelectedTabIndex clamps when workspace restore removes selected tab", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo"),
    createTab(2, "s2", "/repo"),
    createTab(3, "s3", "/repo"),
  );
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 2;

  restoreWorkspaceOrder(state, {
    name: "small",
    children: ["s1"],
    startupWorkdir: "/repo",
    updatedAt: new Date().toISOString(),
  });

  assert.equal(state.homeSelectedTabIndex, 0);
  state.activeTabId = "config";
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", makeTui()), { consume: true });
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
  handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions);
  assert.equal(state.activeTabId, "config");
  assert.equal(state.homeSelectedTabIndex, 1);

  // Right from Home
  handleMixCodeKeyInput(state, "\x1b[C", tui);
  assert.equal(state.activeTabId, "s2");
});
