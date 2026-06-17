import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/index.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import { handleMouseInput } from "../src/ui/app-mouse.js";

function setup() {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 20, height: 3 };
  tab.lastRenderedChatLines = ["hello world", "again there", "done"];
  let renders = 0;
  const tui = { requestRender: () => renders++ };
  return { state, tab, tui, renders: () => renders };
}

test("handleMouseInput drags and copies visible chat selection", async () => {
  const { state, tab, tui, renders } = setup();
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;7;5M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;6;6M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;6;6m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["world\nagain"]);
  assert.equal(tab.toast?.message, "Copied 11 chars.");
  assert.equal(tab.chatSelection, undefined);
  assert.ok(renders() >= 3);
});

test("handleMouseInput keeps wheel scrolling separate from selection", () => {
  const { state, tab, tui } = setup();
  assert.equal(
    handleMouseInput(state, tab, "\x1b[<64;2;6M", tui, undefined, undefined, async () => undefined),
    true,
  );
  assert.equal(tab.chatSelection, undefined);
});

test("handleMouseInput scrolls chat wheel during extension user interaction overlays", () => {
  const { state, tab } = setup();
  tab.extensionUi.pendingUserInteractions.push({ id: "ask-user-question", kind: "custom" });
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
  };

  assert.equal(
    handleMouseInput(state, tab, "\x1b[<64;2;6M", tui, undefined, undefined, async () => undefined),
    true,
  );
  assert.equal(tab.chatScrollOffset, 3);
  assert.equal(renders, 1);
});

test("handleMixCodeKeyInput lets input selection run before extension terminal mouse handling", () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 30, height: 3 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────",
    " draft text                   ",
    "──────────────────────────────",
  ];
  const consumedByRuntime: string[] = [];
  const result = handleMixCodeKeyInput(
    state,
    "\x1b[<0;1;9M",
    tui,
    undefined,
    {
      dispatchTerminalInput: (_sessionId, data) => {
        consumedByRuntime.push(data);
        return { consume: true };
      },
    },
  );

  assert.deepEqual(result, { consume: true });
  assert.deepEqual(consumedByRuntime, []);
  assert.equal(tab.inputSelection?.dragging, true);
});

test("handleMouseInput drags and copies home input editor body", async () => {
  const { state, tab, tui } = setup();
  state.activeTabId = "config";
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 30, height: 3 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────",
    " home draft                   ",
    "──────────────────────────────",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;30;11M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;30;11m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["home draft"]);
  assert.equal(tab.inputSelection, undefined);
});

test("handleMouseInput drags and copies default input editor body", async () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 30, height: 4 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────",
    " hello world                  ",
    " second line                  ",
    "──────────────────────────────",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;30;12M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;30;12m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["hello world\nsecond line"]);
  assert.equal(tab.toast?.message, "Copied 23 chars.");
  assert.equal(tab.inputSelection, undefined);
});

test("handleMouseInput preserves meaningful input body formatting", async () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 34, height: 6 };
  tab.lastRenderedInputLines = [
    "──────────────────────────────────",
    "     indented code                ",
    " ---                             ",
    " enter | accept are words        ",
    " scroll · marker is text         ",
    "──────────────────────────────────",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;34;14M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;34;14m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["    indented code\n---\nenter | accept are words\nscroll · marker is text"]);
});

test("handleMouseInput drags and copies btw-style editor visible body", async () => {
  const { state, tab, tui } = setup();
  tab.inputSurfaceBounds = { top: 9, left: 1, width: 34, height: 5 };
  tab.lastRenderedInputLines = [
    "┌─ BTW answer ─────────────────┐",
    "│ visible one                  │",
    "│ visible two                  │",
    "│ ↑↓ scroll · enter accept     │",
    "└──────────────────────────────┘",
  ];
  const copied: string[] = [];

  assert.equal(handleMouseInput(state, tab, "\x1b[<0;1;9M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<32;34;13M", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);
  assert.equal(handleMouseInput(state, tab, "\x1b[<0;34;13m", tui, undefined, undefined, async (text) => {
    copied.push(text);
  }), true);

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(copied, ["visible one\nvisible two"]);
  assert.equal(tab.toast?.message, "Copied 23 chars.");
  assert.equal(tab.inputSelection, undefined);
});
