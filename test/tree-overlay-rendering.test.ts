import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab, setTheme } from "../src/index.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import {
  createTreeSelectorState,
  initTreeSelector,
  type SessionTreeNode,
} from "../src/core/tree-selector.js";
import {
  attachTreeSelectorDisplayHost,
  handleTreeSelectorKey,
  openTreeSelector,
} from "../src/ui/tree-selector.js";
import { renderTreeSelector } from "../src/ui/tree-selector-render.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function messageNode(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  children: SessionTreeNode[] = [],
): SessionTreeNode {
  return {
    entry: {
      type: "message",
      id,
      parentId,
      timestamp: "2026-05-14T00:00:00.000Z",
      message: { role, content: [{ type: "text", text }] },
    },
    children,
  } as SessionTreeNode;
}

function sampleTree(): SessionTreeNode[] {
  return [
    messageNode("root", null, "user", "start", [
      messageNode("assistant", "root", "assistant", "answer", [
        messageNode("active", "assistant", "user", "current branch"),
        messageNode("other", "assistant", "user", "side branch"),
      ]),
    ]),
  ];
}

test("tree selector renders pi-agent style full-width bordered surface", () => {
  const previousRows = process.stdout.rows;
  process.stdout.rows = 24;
  try {
    const state = createInitialState("/repo");
    setTheme(state, "terminal");
    initTreeSelector(state.treeSelector, sampleTree(), "active");

    const lines = renderTreeSelector(state, 100).map(stripAnsi);
    assert.equal(lines[0], "");
    assert.equal(lines[1], "─".repeat(100));
    assert.equal(lines[2], "  Session Tree");
    assert.match(lines[3] ?? "", /↑\/↓: move\. ←\/→: page\./);
    assert.match(lines[3] ?? "", /shift\+l: label/);
    assert.equal(lines[4], "  Type to search:");
    assert.equal(lines[5], "─".repeat(100));
    assert.equal(lines[6], "");
    assert.ok(lines.some((line) => line.includes("• user: start")));
    assert.ok(lines.some((line) => line.includes("assistant: answer")));
    assert.ok(lines.some((line) => line.includes("(3/4)")));
    assert.equal(lines.at(-1), "─".repeat(100));
    assert.doesNotMatch(lines.join("\n"), /┌|┐|┘|Filter:|Enter: navigate/);
  } finally {
    process.stdout.rows = previousRows;
  }
});

test("tree selector opens in the editor input area instead of an overlay", () => {
  const state = createInitialState("/repo");
  state.tabs.push({ ...state.tabs[0]!, sessionId: "s1" });
  state.activeTabId = "s1";
  const openedSessions: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      throw new Error("tree selector must not use overlay rendering");
    },
    treeSelectorDisplay: {
      open: (sessionId: string) => openedSessions.push(sessionId),
      refresh: () => undefined,
      close: () => undefined,
    },
  };
  const runtime = {
    getTab: () => ({
      session: {
        getTree: () => sampleTree(),
        getLeafId: () => "active",
        appendLabelChange: () => "",
      },
      agentSession: { abortBranchSummary: () => undefined },
    }),
    extensionNavigateTree: async () => ({ cancelled: false }),
    appendSystemMessage: () => undefined,
  };

  openTreeSelector(state, runtime, tui, "s1");

  assert.deepEqual(openedSessions, ["s1"]);
});

test("attached tree selector editor handles focused TUI input directly", () => {
  const state = createInitialState("/repo");
  initTreeSelector(state.treeSelector, sampleTree(), "active");
  let factory: (() => { handleInput?: (data: string) => void }) | undefined;
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
    showOverlay: () => {
      throw new Error("tree selector key handling must not use overlay rendering");
    },
  };
  attachTreeSelectorDisplayHost(tui, state, (nextFactory) => {
    factory = nextFactory;
  });

  tui.treeSelectorDisplay?.open("s1");
  factory?.().handleInput?.("\x0f");

  assert.equal(state.treeSelector.filterMode, "no-tools");
  assert.ok(renders >= 1);
});

test("attached tree selector editor ignores Kitty key release events", () => {
  const state = createInitialState("/repo");
  initTreeSelector(state.treeSelector, sampleTree(), "active");
  let factory: (() => { handleInput?: (data: string) => void }) | undefined;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      throw new Error("tree selector key handling must not use overlay rendering");
    },
  };
  attachTreeSelectorDisplayHost(tui, state, (nextFactory) => {
    factory = nextFactory;
  });

  tui.treeSelectorDisplay?.open("s1");
  factory?.().handleInput?.("\x1b[111;5:3u");

  assert.equal(state.treeSelector.filterMode, "default");
});

test("navigate mode consumes Left so app-input cannot leave to Home", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active", "navigate");
  state.treeSelector.open = true;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({} as never),
    hideOverlay: () => undefined,
  };

  // handleTreeSelectorKey must eat Left (empty-editor Left would activate Home).
  assert.equal(handleTreeSelectorKey(state, "\x1b[D", tui), true);
  assert.equal(state.treeSelector.open, true);
  assert.equal(state.activeTabId, "s1");

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[D", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
  assert.equal(state.treeSelector.open, true);
});

test("tree selector uses pi-agent key labels and shortcuts", () => {
  const state = createInitialState("/repo");
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active");
  let refreshes = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      throw new Error("tree selector key handling must not use overlay rendering");
    },
    hideOverlay: () => undefined,
    treeSelectorDisplay: {
      open: () => undefined,
      refresh: () => {
        refreshes++;
      },
      close: () => undefined,
    },
  };

  assert.equal(handleTreeSelectorKey(state, "\x0f", tui), true);
  assert.equal(refreshes, 1);
  assert.equal(state.treeSelector.filterMode, "no-tools");

  assert.equal(handleTreeSelectorKey(state, "L", tui), true);
  assert.equal(state.treeSelector.labelEditEntryId, "active");
  assert.equal(refreshes, 2);
});

test("tree selector input listener handles tree keys when no editor host is attached", () => {
  const state = createInitialState("/repo");
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active");
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
    showOverlay: () => {
      throw new Error("tree selector key handling must not use overlay rendering");
    },
  };

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x0f",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      {
        getText: () => "",
        setText: () => undefined,
      },
    ),
    { consume: true },
  );
  assert.equal(state.treeSelector.filterMode, "no-tools");
  assert.equal(renders, 1);
});

test("attached tree selector refresh requests a differential render", () => {
  const state = createInitialState("/repo");
  let rendered = false;
  const tui = {
    requestRender: () => {
      rendered = true;
    },
    showOverlay: () => {
      throw new Error("tree selector key handling must not use overlay rendering");
    },
  };
  attachTreeSelectorDisplayHost(tui, state, () => undefined);

  tui.treeSelectorDisplay?.refresh();

  assert.equal(rendered, true);
});

test("tree selector keeps key priority over extension terminal input handlers before editor host attachment", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active", "root");
  let dispatches = 0;
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
    showOverlay: () => {
      throw new Error("tree selector key handling must not use overlay rendering");
    },
    hasOverlay: () => false,
  };
  const runtime = {
    dispatchTerminalInput: () => {
      dispatches++;
      return { consume: true };
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui, undefined, runtime), {
    consume: true,
  });

  assert.equal(dispatches, 0);
  assert.equal(state.treeSelector.selectedIndex, 1);
  assert.equal(renders, 1);
});

test("openQuitConfirm unloads navigate tree so cancel does not leave a dead editor", async () => {
  const { openQuitConfirm } = await import("../src/ui/app-actions.js");
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active", "navigate");
  state.treeSelector.open = true;
  let editorClosed = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hideOverlay: () => undefined,
    treeSelectorDisplay: {
      open: () => undefined,
      refresh: () => undefined,
      close: () => {
        editorClosed = true;
      },
    },
  };

  openQuitConfirm(state, tui);
  assert.equal(state.treeSelector.open, false);
  assert.equal(editorClosed, true);
  assert.equal(state.quitConfirmOpen, true);
});

test("Ctrl+T closes navigate before opening Tab Jump", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active", undefined, undefined, "navigate");
  state.treeSelector.open = true;
  let editorClosed = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => true,
    treeSelectorDisplay: {
      open: () => undefined,
      refresh: () => undefined,
      close: () => {
        editorClosed = true;
      },
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true }); // ctrl+t
  assert.equal(state.treeSelector.open, false);
  assert.equal(editorClosed, true);
  assert.equal(state.tabJumpOpen, true);
});


test("Tab switch closes tree so destination accepts typing", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, sampleTree(), "active", undefined, undefined, "tree");
  state.treeSelector.open = true;
  state.treeSelector.ownerSessionId = "s1";
  let closedOwner: string | undefined;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hideOverlay: () => undefined,
    treeSelectorDisplay: {
      open: () => undefined,
      refresh: () => undefined,
      close: (sessionId?: string) => {
        closedOwner = sessionId;
      },
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.treeSelector.open, false);
  assert.equal(closedOwner, "s1");
  assert.equal(state.activeTabId, "s2");
});
