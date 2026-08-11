import assert from "node:assert/strict";
import { test } from "node:test";
import { bindLiveExtensionRedraw, createInitialState, createTab } from "../src/index.js";

async function waitFor(predicate: () => boolean, attempts = 25): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

test("live extension redraw requests renders for active time-dependent UI", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  tab.extensionUi.widgets.push({
    key: "clock",
    placement: "aboveEditor",
    lines: [],
    render: () => [`tick:${Date.now()}`],
  });

  let renders = 0;
  const tui = {
    requestRender: () => {
      renders += 1;
    },
    stop: () => undefined,
  };

  const stop = bindLiveExtensionRedraw(state, tui, 5);
  await waitFor(() => renders > 0);
  const beforeStop = renders;
  stop();
  await Bun.sleep(20);

  assert.equal(renders, beforeStop);
});

test("live extension redraw stays idle when active tab has only static extension UI", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  tab.extensionUi.widgets.push({
    key: "static",
    placement: "aboveEditor",
    lines: ["static"],
  });

  let renders = 0;
  const stop = bindLiveExtensionRedraw(
    state,
    {
      requestRender: () => {
        renders += 1;
      },
      stop: () => undefined,
    },
    5,
  );
  await Bun.sleep(20);
  stop();

  assert.equal(renders, 0);
});