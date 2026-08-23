import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { activateTab, closeAgentTab } from "../src/core/tabs.js";
import { renderTabBar, themeForId } from "./helpers/mixcode.js";

const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, "");

test("activateTab records agent recency and ignores Home", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"), createTab(3, "s3", "/repo"));
  activateTab(state, "s1");
  activateTab(state, "s2");
  activateTab(state, "s3");
  activateTab(state, "home");
  assert.deepEqual(state.recentAgentTabIds, ["s3", "s2", "s1"]);
  activateTab(state, "s1");
  assert.deepEqual(state.recentAgentTabIds, ["s1", "s3", "s2"]);
});

test("closing a recent agent drops it and shifts the queue", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"), createTab(3, "s3", "/repo"));
  activateTab(state, "s1");
  activateTab(state, "s2");
  activateTab(state, "s3");
  closeAgentTab(state, "s2");
  assert.deepEqual(state.recentAgentTabIds, ["s3", "s1"]);
});

test("stale session ids do not occupy recency ranks", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Alpha" }),
    createTab(2, "s2", "/repo", { title: "Beta" }),
  );
  activateTab(state, "s1");
  activateTab(state, "s2");
  // /clear replaces the live tab id in place and then activates the new id.
  state.tabs[1]!.sessionId = "s2-cleared";
  activateTab(state, "s2-cleared");
  activateTab(state, "home");
  assert.deepEqual(state.recentAgentTabIds, ["s2-cleared", "s1"]);
});

test("on Home the most recent agent uses recentTab, not idle tab", () => {
  const state = createInitialState("/repo");
  state.theme = "terminal";
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Alpha" }),
    createTab(2, "s2", "/repo", { title: "Beta" }),
  );
  activateTab(state, "s1");
  activateTab(state, "s2");
  activateTab(state, "home");
  const line = renderTabBar(state, 80, themeForId("terminal"))[0] ?? "";
  const recent = themeForId("terminal").recentTab(" - Beta ");
  assert.ok(line.includes(recent), "last agent on Home should use recentTab paint");
  assert.match(stripAnsi(line), /Beta/);
});

test("working active tab keeps the title readable", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Worker", status: "running" }));
  activateTab(state, "s1");
  const line = renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "";
  const plain = stripAnsi(line);
  assert.match(plain, /● Worker/);
  assert.ok(plain.includes("● Worker "), "working displays the chip text after the focus mark");
});

test("waiting tab keeps a colored ? without washing out the title", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  const tab = createTab(1, "s1", "/repo", { title: "Asker" });
  tab.extensionUi.waitingForInputs = [{ id: "q", kind: "custom" }];
  state.tabs.push(tab);
  activateTab(state, "s1");
  const line = renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "";
  assert.match(stripAnsi(line), /\? Asker/);
  assert.ok(stripAnsi(line).includes("? Asker "), "waiting displays the chip text after the focus mark");
});

test("focused tab chip includes a left focus mark", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  state.tabs.push(createTab(1, "s1", "/repo", { title: "FocusMe" }));
  activateTab(state, "s1");
  const agentLine = stripAnsi(renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "");
  assert.match(agentLine, /▌- FocusMe/);
  activateTab(state, "home");
  const homeLine = stripAnsi(renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "");
  assert.match(homeLine, /▌MixCode Home/);
  assert.doesNotMatch(homeLine, /▌- FocusMe/);
});

test("focused working tab keeps the focus mark inside the leading pad", () => {
  const state = createInitialState("/repo");
  state.theme = "mixcode-dark";
  state.tabs.push(createTab(1, "s1", "/repo", { title: "FocusMe", status: "running" }));
  activateTab(state, "s1");
  const agentLine = stripAnsi(renderTabBar(state, 80, themeForId("mixcode-dark"))[0] ?? "");
  assert.match(agentLine, /▌● FocusMe/);
  assert.doesNotMatch(agentLine, /▌ ● FocusMe/);
});

test("Pi-derived theme maps recency paints without new Pi tokens", () => {
  const theme = themeForId("light");
  assert.equal(typeof theme.recentTab, "function");
  assert.equal(typeof theme.olderRecentTab, "function");
  assert.equal(typeof theme.activeTab, "function");
  const sample = theme.recentTab("x");
  assert.ok(sample.includes("x"));
});
