import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createPicker,
  createTab,
  filteredPickerItems,
  renderHome,
} from "./helpers/mixcode.js";
import { renderDeleteAllSessionsConfirm } from "../src/ui/app-overlays.js";
import { createSettingsPanel } from "./helpers/settings-panel.js";
import { themeForId } from "../src/ui/themes.js";
import { selectSettingsItemByLabel } from "./helpers/settings-panel.js";

test("home logo is hidden when terminal width cannot fit the banner", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  // Logo is ~55 columns; width 40 body should not paint the banner glyphs.
  const narrow = stripAnsi(renderHome(state, 40).join("\n"));
  assert.doesNotMatch(narrow, /███/);
  assert.match(narrow, /Agents|Agent-01|No agent sessions/);
});

test("home keeps navigation hints when height is short", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  // renderHome(state, width, theme, rowOffset, maxRows)
  const short = stripAnsi(renderHome(state, 80, undefined as never, 0, 10).join("\n"));
  assert.match(short, /↑\/↓: select|→: attach|Enter: send|Tab: cycle tabs/);
});

test("delete-all-sessions confirm names permanent session-file deletion", () => {
  const text = stripAnsi(renderDeleteAllSessionsConfirm(80, themeForId("claude-warm")).join("\n"));
  assert.match(text, /Delete All Sessions/);
  assert.match(text, /permanent|cannot resume|session files/i);
});

test("workdir picker lists more than 20 dirs with overflow affordance", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-many-"));
  try {
    for (let i = 0; i < 30; i++) {
      await fsPromises.mkdir(path.join(dir, `dir-${String(i).padStart(2, "0")}`));
    }
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    const picker = createPicker("workdir", state, tab);
    const items = filteredPickerItems(picker);
    assert.ok(items.length > 20, `expected >20 dirs, got ${items.length}`);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("theme enum opens on the effective default theme", () => {
  const state = createInitialState("/repo");
  state.theme = "claude-warm";
  const panel = createSettingsPanel(state, SettingsManager.inMemory());

  selectSettingsItemByLabel(panel, "Theme");
  panel.handleInput("\r");

  assert.equal(state.theme, "claude-warm");
  assert.match(stripAnsi(panel.render(80).join("\n")), /› claude-warm/);
});

test("theme enum browse applies live preview and Esc restores previous theme", () => {
  const state = createInitialState("/repo");
  state.theme = "claude-warm";
  const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
    mixcodeRaw: { theme: "claude-warm" },
  });

  selectSettingsItemByLabel(panel, "Theme");
  panel.handleInput("\r"); // open enum on the effective theme

  // Browse to another theme id.
  panel.handleInput("\x1b[B"); // down
  assert.notEqual(state.theme, "claude-warm");

  // Esc cancels without persisting: restore file/original theme.
  panel.handleInput("\x1b");
  assert.equal(panel.enumOpen, false);
  assert.equal(state.theme, "claude-warm");

  assert.match(stripAnsi(panel.render(80).join("\n")), /Theme/);
});

test("defaultModel enum only lists models for the selected defaultProvider", () => {
  const state = createInitialState("/repo");
  state.availableModels = [
    { provider: "openai", modelId: "gpt-4o", displayName: "openai/gpt-4o" },
    { provider: "openai", modelId: "o3", displayName: "openai/o3" },
    { provider: "anthropic", modelId: "claude-opus-4-5", displayName: "anthropic/claude-opus-4-5" },
  ];
  const settingsManager = SettingsManager.inMemory();
  settingsManager.setDefaultProvider("openai");
  settingsManager.setDefaultModel("gpt-4o");
  const panel = createSettingsPanel(state, settingsManager);
  panel.selectedIndex = 2; // defaultModel (hideThinking, defaultProvider, defaultModel)

  panel.handleInput("\r"); // open enum
  assert.equal(panel.enumOpen, true);
  const view = stripAnsi(panel.render(80).join("\n"));
  assert.match(view, /gpt-4o/);
  assert.match(view, /\bo3\b/);
  assert.doesNotMatch(view, /claude-opus-4-5/);
});
