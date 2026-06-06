import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/index.js";
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
