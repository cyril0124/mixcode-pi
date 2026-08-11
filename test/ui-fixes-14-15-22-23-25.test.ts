import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  createInitialState,
  createPicker,
  createTab,
  filteredPickerItems,
  renderConfig,
  stripAnsi,
} from "../src/index.js";
import { renderDeleteAllSessionsConfirm } from "../src/ui/app-overlays.js";
import { handleSettingsPanelKey, renderSettingsPanel } from "../src/ui/settings-panel.js";
import { themeForId } from "../src/ui/themes.js";
import { selectSettingsItemByLabel } from "./helpers/settings-panel.js";

test("home logo is hidden when terminal width cannot fit the banner", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  // Logo is ~55 columns; width 40 body should not paint the banner glyphs.
  const narrow = stripAnsi(renderConfig(state, 40).join("\n"));
  assert.doesNotMatch(narrow, /███/);
  assert.match(narrow, /Agents|Agent-01|No agent sessions/);
});

test("home keeps navigation hints when height is short", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  // renderConfig(state, width, theme, rowOffset, maxRows)
  const short = stripAnsi(renderConfig(state, 80, undefined as never, 0, 10).join("\n"));
  assert.match(short, /↑\/↓: select|→: attach|Enter: send|Tab: cycle tabs/);
});

test("delete-all-sessions confirm names permanent session-file deletion", () => {
  const text = stripAnsi(renderDeleteAllSessionsConfirm(80, themeForId("claude-warm")).join("\n"));
  assert.match(text, /Delete All Sessions/);
  assert.match(text, /permanent|cannot resume|session files/i);
});

test("workdir picker lists more than 20 dirs with overflow affordance", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-many-"));
  try {
    for (let i = 0; i < 30; i++) {
      await mkdir(join(dir, `dir-${String(i).padStart(2, "0")}`));
    }
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    const picker = createPicker("workdir", state, tab);
    const items = filteredPickerItems(picker);
    assert.ok(items.length > 20, `expected >20 dirs, got ${items.length}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("theme enum opens on the effective default theme", () => {
  const state = createInitialState("/repo");
  state.theme = "claude-warm";
  state.settingsPanel = {
    open: true,
    selectedIndex: 0,
    editMode: false,
    editText: "",
    enumOpen: false,
    enumIndex: 0,
    mixcodeRaw: {},
    mixcodeFile: "/tmp/mixcode_settings.json",
    piSettingsFile: "/tmp/settings.json",
    settingsManager: SettingsManager.inMemory(),
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  selectSettingsItemByLabel(state, "Theme");
  handleSettingsPanelKey(state, "\r", tui);

  assert.equal(state.theme, "claude-warm");
  assert.match(stripAnsi(renderSettingsPanel(state, 80).join("\n")), /› claude-warm/);
});

test("theme enum browse applies live preview and Esc restores previous theme", () => {
  const state = createInitialState("/repo");
  state.theme = "claude-warm";
  state.settingsPanel = {
    open: true,
    selectedIndex: 0,
    editMode: false,
    editText: "",
    enumOpen: false,
    enumIndex: 0,
    mixcodeRaw: { theme: "claude-warm" },
    mixcodeFile: "/tmp/mixcode_settings.json",
    piSettingsFile: "/tmp/settings.json",
    settingsManager: SettingsManager.inMemory(),
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  selectSettingsItemByLabel(state, "Theme");
  handleSettingsPanelKey(state, "\r", tui); // open enum on the effective theme

  // Browse to another theme id.
  handleSettingsPanelKey(state, "\x1b[B", tui); // down
  assert.notEqual(state.theme, "claude-warm");

  // Esc cancels without persisting: restore file/original theme.
  handleSettingsPanelKey(state, "\x1b", tui);
  assert.equal(state.settingsPanel.enumOpen, false);
  assert.equal(state.theme, "claude-warm");

  assert.match(stripAnsi(renderSettingsPanel(state, 80).join("\n")), /Theme/);
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
  state.settingsPanel = {
    open: true,
    selectedIndex: 2, // defaultModel (hideThinking, defaultProvider, defaultModel)
    editMode: false,
    editText: "",
    enumOpen: false,
    enumIndex: 0,
    mixcodeRaw: {},
    mixcodeFile: "/tmp/mixcode_settings.json",
    piSettingsFile: "/tmp/settings.json",
    settingsManager,
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  handleSettingsPanelKey(state, "\r", tui); // open enum
  assert.equal(state.settingsPanel.enumOpen, true);
  const view = stripAnsi(renderSettingsPanel(state, 80).join("\n"));
  assert.match(view, /gpt-4o/);
  assert.match(view, /\bo3\b/);
  assert.doesNotMatch(view, /claude-opus-4-5/);
});
