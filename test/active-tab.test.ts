import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { getActiveTab } from "../src/core/tabs.js";

test("getActiveTab returns the Home-selected agent", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.homeSelectedTabIndex = 1;

  assert.equal(getActiveTab(state)?.sessionId, "s2");
});

test("getActiveTab does not silently fall back for an unknown session", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "missing";

  assert.equal(getActiveTab(state), undefined);
});
