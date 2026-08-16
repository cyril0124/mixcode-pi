import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { createInitialState, createTab, loadMixCodeSettings, stripAnsi } from "../src/index.js";
import { addAgentTab } from "../src/core/tabs.js";
import { handleSettingsPanelKey, renderSettingsPanel } from "../src/ui/settings-panel.js";

test("settings panel changes Pi mermaid mode and mirrors live state", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-mermaid-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  await fsPromises.writeFile(mixcodeFile, "{}\n");
  try {
    const state = createInitialState(dir);
    const settingsManager = SettingsManager.inMemory();
    state.settingsPanel = {
      open: true,
      selectedIndex: 8, // markdown.mermaid
      editMode: false,
      editText: "",
      enumOpen: false,
      enumIndex: 0,
      mixcodeRaw: {},
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
      settingsManager,
    };
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => true,
      hideOverlay: () => undefined,
    };

    assert.match(stripAnsi(renderSettingsPanel(state, 80).join("\n")), /Mermaid diagrams/);
    // Open enum (default streaming), pick off, confirm.
    handleSettingsPanelKey(state, "\r", tui);
    state.settingsPanel.enumIndex = 0; // off
    handleSettingsPanelKey(state, "\r", tui);
    await Bun.sleep(30);

    assert.equal(settingsManager.getMermaidRenderingMode(), "off");
    assert.equal(state.mermaidRenderingMode, "off");
    // MixCode file is untouched — mermaid lives in Pi settings.json.
    assert.deepEqual(JSON.parse(await fsPromises.readFile(mixcodeFile, "utf8")), {});
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings default history and oversized assistant message policy", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-history-settings-"));
  try {
    assert.deepEqual(await loadMixCodeSettings(path.join(dir, "missing.json")), {
      history: { maxBytes: 5 * 1024 * 1024 },
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        icons: { mode: "nerd" },
        inlineWidgets: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
    await fsPromises.writeFile(
      path.join(dir, "mixcode_settings.json"),
      JSON.stringify({
        history: { persistence: "none", maxBytes: 128 },
        ui: {
          oversizedAssistantMessage: { enabled: false, maxLines: 42, maxBytes: 2048 },
          // Legacy ui.renderMermaid is ignored (Pi markdown.mermaid owns mermaid now).
          renderMermaid: false,
          icons: { mode: "ascii" },
        },
      }),
      "utf8",
    );
    assert.deepEqual(await loadMixCodeSettings(path.join(dir, "mixcode_settings.json")), {
      history: { maxBytes: 128 },
      ui: {
        oversizedAssistantMessage: { enabled: false, maxLines: 42, maxBytes: 2048 },
        icons: { mode: "ascii" },
        inlineWidgets: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings accept jsonc comments and trailing commas", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-history-jsonc-settings-"));
  try {
    await fsPromises.writeFile(
      path.join(dir, "mixcode_settings.json"),
      `{
        // Keep at most 256 bytes of prompt history.
        "history": {
          "maxBytes": 256,
        },
      }`,
      "utf8",
    );

    assert.deepEqual(await loadMixCodeSettings(path.join(dir, "mixcode_settings.json")), {
      history: { maxBytes: 256 },
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        icons: { mode: "nerd" },
        inlineWidgets: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings reject invalid oversized assistant message policy", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-ui-settings-invalid-"));
  const file = path.join(dir, "mixcode_settings.json");
  try {
    for (const [value, message] of [
      [{ maxLines: "many" }, /ui\.oversizedAssistantMessage\.maxLines must be a positive integer/],
      [{ maxBytes: 0 }, /ui\.oversizedAssistantMessage\.maxBytes must be a positive integer/],
      [{ enabled: "yes" }, /ui\.oversizedAssistantMessage\.enabled must be a boolean/],
      ["bad", /ui\.oversizedAssistantMessage must be an object/],
    ] as const) {
      await fsPromises.writeFile(file, JSON.stringify({ ui: { oversizedAssistantMessage: value } }), "utf8");
      await assert.rejects(() => loadMixCodeSettings(file), message);
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("legacy ui.renderMermaid in mixcode_settings is ignored", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-render-mermaid-legacy-"));
  const file = path.join(dir, "mixcode_settings.json");
  try {
    await fsPromises.writeFile(file, JSON.stringify({ ui: { renderMermaid: "yes" } }), "utf8");
    // Unknown / obsolete fields must not throw.
    assert.deepEqual(await loadMixCodeSettings(file), {
      history: { maxBytes: 5 * 1024 * 1024 },
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        icons: { mode: "nerd" },
        inlineWidgets: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings reject invalid icons.mode", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-icons-mode-invalid-"));
  const file = path.join(dir, "mixcode_settings.json");
  try {
    await fsPromises.writeFile(file, JSON.stringify({ ui: { icons: { mode: "emoji" } } }), "utf8");
    await assert.rejects(
      () => loadMixCodeSettings(file),
      /ui\.icons\.mode must be one of auto, nerd, ascii/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel cycles icons.mode and persists it", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-icons-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  await fsPromises.writeFile(mixcodeFile, "{}\n");
  try {
    const state = createInitialState(dir);
    state.settingsPanel = {
      open: true,
      selectedIndex: 11, // icons.mode
      editMode: false,
      editText: "",
      enumOpen: false,
      enumIndex: 0,
      mixcodeRaw: {},
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
      settingsManager: SettingsManager.inMemory(),
    };
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => true,
      hideOverlay: () => undefined,
    };

    assert.match(stripAnsi(renderSettingsPanel(state, 80).join("\n")), /Icon mode/);
    // Open enum, pick ascii (index 2), confirm.
    handleSettingsPanelKey(state, "\r", tui);
    state.settingsPanel.enumIndex = 2;
    handleSettingsPanelKey(state, "\r", tui);
    await Bun.sleep(30);

    assert.equal(state.settingsPanel.mixcodeRaw.ui?.icons?.mode, "ascii");
    assert.equal(state.ui?.icons?.mode, "ascii");
    assert.deepEqual(JSON.parse(await fsPromises.readFile(mixcodeFile, "utf8")), {
      ui: { icons: { mode: "ascii" } },
    });
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel restores Pi values when persistence fails", async () => {
  const storage = {
    withLock(
      scope: "global" | "project",
      update: (current: string | undefined) => string | undefined,
    ) {
      const next = update(scope === "global" ? "{}" : undefined);
      if (next !== undefined) throw new Error("settings disk is read-only");
    },
  };
  const settingsManager = SettingsManager.fromStorage(storage as never);
  const state = createInitialState("/repo");
  state.settingsPanel = {
    open: true,
    selectedIndex: 0, // hideThinkingBlock
    editMode: false,
    editText: "",
    enumOpen: false,
    enumIndex: 0,
    mixcodeRaw: {},
    mixcodeFile: "/tmp/unused-mixcode-settings.json",
    piSettingsFile: "/tmp/unused-pi-settings.json",
    settingsManager,
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  handleSettingsPanelKey(state, "\r", tui);
  await Bun.sleep(30);

  assert.match(state.settingsPanel.editError ?? "", /settings disk is read-only/);
  assert.equal(settingsManager.getHideThinkingBlock(), false);
  assert.equal(state.hideThinkingBlock ?? false, false);
});

test("settings panel surfaces write failures without applying the new value", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-write-error-"));
  try {
    const state = createInitialState(dir);
    state.settingsPanel = {
      open: true,
      selectedIndex: 11, // icons.mode
      editMode: false,
      editText: "",
      enumOpen: false,
      enumIndex: 0,
      mixcodeRaw: {},
      mixcodeFile: dir, // Writing JSON to a directory must fail.
      piSettingsFile: path.join(dir, "settings.json"),
      settingsManager: SettingsManager.inMemory(),
    };
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => true,
      hideOverlay: () => undefined,
    };

    handleSettingsPanelKey(state, "\r", tui);
    state.settingsPanel.enumIndex = 2;
    handleSettingsPanelKey(state, "\r", tui);
    await Bun.sleep(30);

    assert.match(state.settingsPanel.editError ?? "", /Failed to save Icon mode/);
    assert.equal(state.settingsPanel.enumOpen, true);
    assert.equal(state.settingsPanel.mixcodeRaw.ui?.icons?.mode, undefined);
    assert.equal(state.ui?.icons.mode, "nerd");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel wraps selection from the first item to the last", () => {
  const state = createInitialState("/repo");
  state.settingsPanel = {
    open: true,
    selectedIndex: 0,
    editMode: false,
    editText: "",
    enumOpen: false,
    enumIndex: 0,
    mixcodeRaw: {},
    mixcodeFile: "/tmp/unused-mixcode-settings.json",
    piSettingsFile: "/tmp/unused-pi-settings.json",
    settingsManager: SettingsManager.inMemory(),
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  handleSettingsPanelKey(state, "\x1b[A", tui);
  assert.ok(state.settingsPanel.selectedIndex > 0);
  const last = state.settingsPanel.selectedIndex;
  handleSettingsPanelKey(state, "\x1b[B", tui);
  assert.equal(state.settingsPanel.selectedIndex, 0);
  handleSettingsPanelKey(state, "\x1b[A", tui);
  assert.equal(state.settingsPanel.selectedIndex, last);
});

test("settings panel filters the main list and activates the selected match", () => {
  const state = createInitialState("/repo");
  state.settingsPanel = {
    ...state.settingsPanel,
    open: true,
    mixcodeFile: "/tmp/unused-mixcode-settings.json",
    piSettingsFile: "/tmp/unused-pi-settings.json",
    settingsManager: SettingsManager.inMemory(),
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  for (const char of "image") handleSettingsPanelKey(state, char, tui);

  const filtered = stripAnsi(renderSettingsPanel(state, 100).join("\n"));
  assert.match(filtered, /filter: image/i);
  assert.match(filtered, /Show images/);
  assert.match(filtered, /Image width \(cells\)/);
  assert.match(filtered, /Block images to model/);
  assert.doesNotMatch(filtered, /Hide thinking blocks/);

  handleSettingsPanelKey(state, "\x1b[B", tui);
  handleSettingsPanelKey(state, "\r", tui);
  assert.equal(state.settingsPanel.editMode, true);
  assert.equal(state.settingsPanel.selectedIndex, 6); // imageWidthCells in ITEMS

  handleSettingsPanelKey(state, "\x1b", tui);
  assert.equal(state.settingsPanel.editMode, false);
  handleSettingsPanelKey(state, "\x7f", tui);
  assert.equal(state.settingsPanel.filterQuery, "imag");
  handleSettingsPanelKey(state, "\x1b", tui);
  assert.equal(state.settingsPanel.filterQuery, "");
  assert.equal(state.settingsPanel.open, true);

  for (const char of "markdown.mermaid") handleSettingsPanelKey(state, char, tui);
  const keyFiltered = stripAnsi(renderSettingsPanel(state, 100).join("\n"));
  assert.match(keyFiltered, /Mermaid diagrams/);
  assert.doesNotMatch(keyFiltered, /Show images/);

  handleSettingsPanelKey(state, "\x1b", tui);
  handleSettingsPanelKey(state, "\x1b", tui);
  assert.equal(state.settingsPanel.open, false);
});

test("settings panel handles a filter with no matching settings", () => {
  const state = createInitialState("/repo");
  state.settingsPanel = {
    ...state.settingsPanel,
    open: true,
    mixcodeFile: "/tmp/unused-mixcode-settings.json",
    piSettingsFile: "/tmp/unused-pi-settings.json",
    settingsManager: SettingsManager.inMemory(),
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  for (const char of "zzzzz") handleSettingsPanelKey(state, char, tui);
  assert.match(stripAnsi(renderSettingsPanel(state, 100).join("\n")), /No matching settings/);

  handleSettingsPanelKey(state, "\x1b[A", tui);
  handleSettingsPanelKey(state, "\r", tui);
  assert.equal(state.settingsPanel.editMode, false);
  assert.equal(state.settingsPanel.enumOpen, false);
  assert.equal(state.settingsPanel.open, true);
});

test("mixcode settings load ui.inlineWidgets and reject non-booleans", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-inline-widgets-settings-"));
  try {
    const file = path.join(dir, "mixcode_settings.json");
    await fsPromises.writeFile(file, JSON.stringify({ ui: { inlineWidgets: true } }), "utf8");
    assert.equal((await loadMixCodeSettings(file)).ui.inlineWidgets, true);
    await fsPromises.writeFile(file, JSON.stringify({ ui: { inlineWidgets: "yes" } }), "utf8");
    await assert.rejects(() => loadMixCodeSettings(file), /ui\.inlineWidgets must be a boolean/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel toggles inlineWidgets on live tabs and new tabs", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-inline-widgets-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  await fsPromises.writeFile(mixcodeFile, "{}\n");
  try {
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.settingsPanel = {
      open: true,
      selectedIndex: 17, // inlineWidgets
      editMode: false,
      editText: "",
      enumOpen: false,
      enumIndex: 0,
      mixcodeRaw: {},
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
      settingsManager: SettingsManager.inMemory(),
    };
    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => true,
      hideOverlay: () => undefined,
    };

    assert.match(stripAnsi(renderSettingsPanel(state, 80).join("\n")), /Inline widgets/);
    handleSettingsPanelKey(state, "\r", tui);
    await Bun.sleep(30);

    assert.equal(JSON.parse(await fsPromises.readFile(mixcodeFile, "utf8")).ui.inlineWidgets, true);
    assert.equal(state.ui?.inlineWidgets, true);
    assert.equal(tab.inlineWidgets, true);
    assert.equal(addAgentTab(state, "s2", dir).inlineWidgets, true);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
