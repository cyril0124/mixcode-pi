import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  renderCommandPalette,
  renderConfig,
  renderPickerOverlay,
  renderTabJumpOverlay,
} from "../src/index.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("config lists agents and surfaces package update notice", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  const config = stripAnsi(renderConfig(state, 100).join("\n"));
  assert.match(config, /Agents/);
  assert.match(config, /Agent-01/);
  assert.doesNotMatch(config, /Package Updates Available/);

  state.packageUpdates = ["@tintinweb/pi-tasks", "pi-codex-goal"];
  const updates = stripAnsi(renderConfig(state, 100).join("\n"));
  assert.match(updates, /Package Updates Available/);
  assert.match(updates, /pi update/);
  assert.match(updates, /@tintinweb\/pi-tasks/);
  assert.match(updates, /pi-codex-goal/);
});

test("command palette lists settings and reports empty search", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.commandPaletteOpen = true;

  const home = stripAnsi(renderCommandPalette(state, 100).join("\n"));
  assert.match(home, /Settings/);
  assert.match(home, /Extension Manager/);
  assert.match(home, /\/delete-all-sessions/);

  state.activeTabId = tab.sessionId;
  // Full list is taller than the first page; filter so the asserted rows are visible.
  state.commandPalette.query = "system prompt";
  assert.match(stripAnsi(renderCommandPalette(state, 100).join("\n")), /Open System Prompt/);
  state.commandPalette.query = "mark-done";
  assert.match(stripAnsi(renderCommandPalette(state, 100).join("\n")), /\/mark-done/);
  state.commandPalette.query = "";
  assert.doesNotMatch(stripAnsi(renderCommandPalette(state, 100).join("\n")), /Toggle Shell/);

  state.commandPalette.query = "missing";
  assert.match(stripAnsi(renderCommandPalette(state, 100).join("\n")), /No matching commands/);
});

test("closed overlays render nothing", () => {
  const state = createInitialState("/repo");
  assert.deepEqual(renderTabJumpOverlay(state, 80), []);
  assert.deepEqual(renderPickerOverlay(state, 80), []);
});
