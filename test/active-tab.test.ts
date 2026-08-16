import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { activateTab, getActiveTab } from "../src/core/tabs.js";
import { tabStatusGlyph } from "../src/ui/rendering/chrome.js";

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

test("activateTab clears /mark-done badge so ! does not stick after focus", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "done", unreadDone: true });
  state.tabs.push(tab);
  state.activeTabId = "home";
  assert.equal(tabStatusGlyph(tab), "!");

  activateTab(state, tab.sessionId);

  assert.equal(tab.unreadDone, false);
  assert.equal(tab.status, "idle");
  assert.equal(tabStatusGlyph(tab), "-");
});

test("activateTab to Home selects the agent you left", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s2";
  state.homeSelectedTabIndex = 0; // stale (Agent-01)

  activateTab(state, "home");

  assert.equal(state.activeTabId, "home");
  assert.equal(state.homeSelectedTabIndex, 1);
  assert.equal(getActiveTab(state)?.sessionId, "s2");
});
