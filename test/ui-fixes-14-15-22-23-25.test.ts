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

test("theme enum browse applies live preview and Esc restores previous theme", () => {
  const state = createInitialState("/repo");
  state.theme = "claude-warm";
  state.settingsPanel = {
    open: true,
    selectedIndex: 5, // Theme item
    editMode: false,
    editText: "",
    enumOpen: true,
    enumIndex: 1, // claude-warm in THEMES order: mixcode-dark, claude-warm, ...
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

  // Browse to another theme id.
  handleSettingsPanelKey(state, "\x1b[B", tui); // down
  assert.notEqual(state.theme, "claude-warm");

  // Esc cancels without persisting: restore file/original theme.
  handleSettingsPanelKey(state, "\x1b", tui);
  assert.equal(state.settingsPanel.enumOpen, false);
  assert.equal(state.theme, "claude-warm");

  assert.match(stripAnsi(renderSettingsPanel(state, 80).join("\n")), /Theme/);
});
