import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  nextAvailableAgentTitle,
  stripAnsi,
} from "../src/index.js";
import { commandPaletteEntriesWithExtensions } from "../src/core/overlays.js";
import { clearPendingEscape } from "../src/core/escape.js";
import { handleEscapeKey } from "../src/ui/app-key-handlers.js";
import { renderInputMeta } from "../src/ui/rendering.js";

test("palette ranks contiguous/prefix matches above sparse subsequence", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.commandPaletteOpen = true;
  state.commandPalette = { query: "new", selectedIndex: 0 };
  const entries = commandPaletteEntriesWithExtensions(state, []);
  const commands = entries.map((e) => e.command);
  const newIdx = commands.indexOf("/new-session");
  const workdirIdx = commands.indexOf("/workdir");
  assert.ok(newIdx >= 0, "new-session present");
  if (workdirIdx >= 0) {
    assert.ok(newIdx < workdirIdx, `new-session (${newIdx}) should rank before workdir (${workdirIdx})`);
  }
  assert.equal(entries[0]?.command, "/new-session");
});

test("nextAvailableAgentTitle reuses lowest free Agent-NN", () => {
  const tabs = [
    createTab(1, "a", "/repo", { title: "Agent-02" }),
    createTab(2, "b", "/repo", { title: "Agent-03" }),
  ];
  assert.equal(nextAvailableAgentTitle(tabs), "Agent-01");
  tabs.push(createTab(3, "c", "/repo", { title: "Agent-01" }));
  assert.equal(nextAvailableAgentTitle(tabs), "Agent-04");
});

test("clearPendingEscape cancels double-Esc tree arm", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.lastEscapeTime = Date.now();
  clearPendingEscape(tab, "abort-agent");
  assert.equal(tab.lastEscapeTime, undefined);
});

test("vim mode does not arm empty-editor double-Esc tree", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.vimMode = true;
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    hasOverlay: () => false,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hideOverlay: () => undefined,
  };
  const editor = { getText: () => "", setText: () => undefined };
  const first = handleEscapeKey(state, tab, tui, undefined, editor, () => false);
  assert.equal(first, undefined);
  assert.equal(tab.lastEscapeTime, undefined);
});

test("input meta shows Esc again: tree while double-Esc is armed", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.lastEscapeTime = Date.now();
  const plain = stripAnsi(renderInputMeta(tab, 120).join("\n"));
  assert.match(plain, /Esc again: tree/);
});
