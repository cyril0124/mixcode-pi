import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  const overlays: string[] = [];
  return {
    requestRender: () => {
      renders++;
    },
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string" ? component : (component.render?.(80).join("\n") ?? ""),
      );
      return { hide: () => undefined } as never;
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
    addToHistory: () => undefined,
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
  assert.equal(state.activeTabId, "config");
  assert.equal(state.homeSelectedTabIndex, 1); // s2 is at index 1
});

test("Left on empty input does NOT return to Home when extension UI interaction is pending", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.pendingUserInteractions.push({ id: "ext-1", kind: "custom" });
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
  assert.notDeepEqual(result, { consume: true });
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

test("Home Enter expands paste markers before sending", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const prompted: string[] = [];
  const runtime = {
    prompt: async (_sessionId: string, text: string) => {
      prompted.push(text);
    },
  };
  const editorActions = makeEditorActions(
    "[paste #1 +16 lines]",
    "PASTE-LINE-1\nPASTE-LINE-2\nPASTE-LINE-3",
  );

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, () => false, editorActions),
    { consume: true },
  );
  await Promise.resolve();
  assert.deepEqual(prompted, ["PASTE-LINE-1\nPASTE-LINE-2\nPASTE-LINE-3"]);
  assert.equal(editorActions.getText(), "");
});

test("Home Ctrl+J inserts newline instead of submitting", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted = false;
  const runtime = {
    prompt: async () => {
      prompted = true;
    },
  };
  const editorActions = makeEditorActions("line-one");

  // Ctrl+J is "\n", which also matchesKey("enter") — must not submit on Home.
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\n", tui, undefined, runtime, undefined, () => false, editorActions),
    { consume: true },
  );
  assert.equal(state.activeTabId, "config");
  assert.equal(prompted, false);
  assert.equal(editorActions.getText(), "line-one\n");
});

test("Home Enter with whitespace-only input does not clear the editor", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted = false;
  const runtime = {
    prompt: async () => {
      prompted = true;
    },
  };
  const editorActions = makeEditorActions("   \t  ");

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, () => false, editorActions),
    { consume: true },
  );
  assert.equal(state.activeTabId, "config");
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
    handleMixCodeKeyInput(state, "\t", tui, undefined, undefined, undefined, () => false, editorActions),
    { consume: true },
  );
  assert.equal(state.activeTabId, "config");
  assert.equal(state.homeSelectedTabIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
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

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[C", tui), { consume: true });
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

test("Home Enter with text sends message to selected agent and stays on Home", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }), createTab(2, "s2", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted: { sessionId: string; text: string } | undefined;
  const history: Array<{ text: string; sessionId?: string }> = [];
  let activeWhilePrompt: string | undefined;
  const runtime = {
    prompt: (sessionId: string, text: string) => {
      prompted = { sessionId, text };
      activeWhilePrompt = state.activeTabId;
      return Promise.resolve();
    },
  };
  const editorActions = makeEditorActions("fix the bug");
  editorActions.addToHistory = (text, sessionId) => {
    history.push({ text, sessionId });
  };

  const result = handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, () => false, editorActions);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "config");
  assert.equal(activeWhilePrompt, "config", "must not spoof activeTabId during Home send");
  assert.deepEqual(prompted, { sessionId: "s1", text: "fix the bug" });
  assert.deepEqual(history, [{ text: "fix the bug", sessionId: "s1" }]);
  assert.equal(editorActions.getText(), "");
});

test("Home Enter runs local slash commands on selected agent (not as model prompt)", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Worker" });
  state.tabs.push(tab);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  let prompted = false;
  const runtime = {
    prompt: async () => {
      prompted = true;
    },
  };
  const editorActions = makeEditorActions("/mark-done");

  const result = handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, () => false, editorActions);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "config");
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
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const runtime = {
    prompt: async () => undefined,
  };
  const editorActions = makeEditorActions("follow-up from home");

  handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, () => false, editorActions);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.equal(state.activeTabId, "config");
  assert.equal(tab.unreadDone, true);
  assert.equal(tab.status, "done");
});

test("Home Enter restores text and shows transient error when selected agent rejects prompt", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker" }), createTab(2, "s2", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const runtime = {
    prompt: () => Promise.reject(new Error("Cannot prompt while compaction is running")),
  };
  const editorActions = makeEditorActions("fix the bug");

  const result = handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, () => false, editorActions);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "config");
  assert.equal(editorActions.getText(), "fix the bug");
  assert.match(tui.overlays.at(-1) ?? "", /Cannot prompt while compaction is running/);
});

test("Home Enter passes workspaceFile so /save-workspace works", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-home-ws-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    state.activeTabId = "config";
    state.homeSelectedTabIndex = 0;
    const tui = makeTui();
    const runtime = {
      prompt: async () => undefined,
      getTab: () => undefined,
    };
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
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(result, { consume: true });
    assert.equal(state.activeTabId, "config");
    // Must not surface "Workspace file is not configured".
    assert.equal(
      tui.overlays.some((o) => o.includes("Workspace file is not configured")),
      false,
    );
    const saved = JSON.parse(await readFile(workspaceFile, "utf8")) as unknown[];
    assert.ok(Array.isArray(saved) && saved.length >= 1);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
});

test("Home /clear stays on Home after session replacement", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const runtime = {
    prompt: async () => undefined,
    clearTab: async (sessionId: string) => {
      assert.equal(sessionId, "s1");
      tab.sessionId = "s1-cleared";
      return { tab };
    },
  };
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
  await new Promise<void>((resolve) => setTimeout(resolve, 50));

  assert.equal(state.activeTabId, "config");
  assert.equal(tab.sessionId, "s1-cleared");
  assert.equal(state.homeSelectedTabIndex, 0);
});

test("Home Right does NOT attach when editor has text", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  const tui = makeTui();
  const editorActions = makeEditorActions("some text");

  const result = handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, undefined, undefined, () => false, editorActions);

  // Leave Right to the editor for cursor movement when input is non-empty.
  assert.notDeepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "config");
  assert.equal(editorActions.getText(), "some text");
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

test("renderConfig paints the selected agent toast", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.toast = { type: "info", message: "Hidden extension messages shown", createdAt: Date.now() };
  state.tabs.push(tab);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;

  const output = renderConfig(state, 100).join("\n");
  assert.match(output, /Hidden extension messages shown/);
});

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

test("renderConfig shows preview panel below card list for selected agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      title: "Previewer",
      previewMessages: [
        { role: "user", text: "please explain" },
        { role: "tool", text: "read file" },
        { role: "assistant", text: "Here is the latest assistant output\nwith details" },
      ],
    }),
  );
  state.homeSelectedTabIndex = 0;
  const output = stripAnsi(renderConfig(state, 100).join("\n"));

  // Preview panel shows user/assistant below card list, not tool messages.
  assert.match(output, /user:.*please explain/);
  assert.match(output, /assistant:.*Here is the latest assistant output with details/);
  assert.doesNotMatch(output, /tool:/);
});

test("renderConfig respects row budget for compact Agent View", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      title: "Previewer",
      previewMessages: [{ role: "assistant", text: "Long preview ".repeat(50) }],
    }),
  );
  state.homeSelectedTabIndex = 0;

  const lines = renderConfig(state, 100, undefined, 0, 9);
  const output = stripAnsi(lines.join("\n"));

  assert.equal(lines.length, 9);
  assert.match(output, /Agents/);
  assert.match(output, /⎿ Long preview/);
  assert.doesNotMatch(output, /^\.\.\.$/m);
  assert.doesNotMatch(output, /newer below/);
});

test("renderConfig preserves full selected-agent preview when it fits", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      title: "Previewer",
      previewMessages: Array.from({ length: 7 }, (_, index) => ({
        role: "assistant" as const,
        text: `message ${index + 1}`,
      })),
    }),
  );
  state.homeSelectedTabIndex = 0;

  const output = stripAnsi(renderConfig(state, 100, undefined, 0, 26).join("\n"));

  for (let index = 1; index <= 7; index++) {
    assert.match(output, new RegExp(`assistant: message ${index}`));
  }
  assert.doesNotMatch(output, /newer below/);
});

test("renderConfig shows compact preview for all cards including selected", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      title: "First",
      previewMessages: [
        { role: "assistant", text: "First output" },
      ],
    }),
    createTab(2, "s2", "/repo", {
      title: "Second",
      previewMessages: [
        { role: "assistant", text: "Second output" },
      ],
    }),
  );
  state.homeSelectedTabIndex = 0;
  const output = stripAnsi(renderConfig(state, 100).join("\n"));

  // Both cards show compact ⎿ preview
  assert.match(output, /⎿ First output/);
  assert.match(output, /⎿ Second output/);
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

test("closing an earlier tab keeps the Home-selected agent", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "a", "/repo", { title: "A" }),
    createTab(2, "b", "/repo", { title: "B" }),
    createTab(3, "c", "/repo", { title: "C" }),
  );
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 1; // B

  const { closeAgentTab, getActiveTab } = await import("../src/index.js");
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
  handleMixCodeKeyInput(state, "\x1b[D", tui, undefined, undefined, undefined, () => false, editorActions);
  assert.equal(state.activeTabId, "config");
  assert.equal(state.homeSelectedTabIndex, 1);

  // Right from Home
  handleMixCodeKeyInput(state, "\x1b[C", tui);
  assert.equal(state.activeTabId, "s2");
});
