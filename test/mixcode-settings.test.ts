import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { createInitialState, createTab, loadMixCodeSettings } from "./helpers/mixcode.js";
import { createSettingsPanel, selectSettingsItemByLabel } from "./helpers/settings-panel.js";

test("settings panel changes Pi mermaid mode and mirrors live state", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-mermaid-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  await fsPromises.writeFile(mixcodeFile, "{}\n");
  try {
    const state = createInitialState(dir);
    const settingsManager = SettingsManager.inMemory();
    const panel = createSettingsPanel(state, settingsManager, {
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
    });
    panel.selectedIndex = 8; // markdown.mermaid

    assert.match(stripAnsi(panel.render(80).join("\n")), /Mermaid diagrams/);
    // Open enum (default streaming), pick off, confirm.
    panel.handleInput("\r");
    panel.enumIndex = 0; // off
    panel.handleInput("\r");
    await Bun.sleep(30);

    assert.equal(settingsManager.getMermaidRenderingMode(), "off");
    assert.equal(state.mermaidRenderingMode, "off");
    // MixCode file is untouched — mermaid lives in Pi settings.json.
    assert.deepEqual(JSON.parse(await fsPromises.readFile(mixcodeFile, "utf8")), {});
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel toggles Pi cache miss notices through the runtime callback", async () => {
  const settingsManager = SettingsManager.inMemory();
  const applied: boolean[] = [];
  const panel = createSettingsPanel(createInitialState("/repo"), settingsManager, {
    setShowCacheMissNotices: async (show) => {
      applied.push(show);
      settingsManager.setShowCacheMissNotices(show);
    },
  });

  for (const char of "cache miss") panel.handleInput(char);
  assert.match(stripAnsi(panel.render(80).join("\n")), /Cache miss notices/);

  panel.handleInput("\r");
  await Bun.sleep(30);

  assert.deepEqual(applied, [true]);
  assert.equal(settingsManager.getShowCacheMissNotices(), true);
});

test("mixcode settings defaults, oversized policy, and ignored unknown keys", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-defaults-"));
  try {
    assert.deepEqual(await loadMixCodeSettings(path.join(dir, "missing.json")), {
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        icons: { mode: "nerd" },
        inlineWidgets: false,
        boxedHiddenThinking: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
    await fsPromises.writeFile(
      path.join(dir, "mixcode_settings.json"),
      JSON.stringify({
        // history moved to the mpi-prompt-history package; a stale key is ignored.
        history: { maxBytes: 128 },
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
      ui: {
        oversizedAssistantMessage: { enabled: false, maxLines: 42, maxBytes: 2048 },
        icons: { mode: "ascii" },
        inlineWidgets: false,
        boxedHiddenThinking: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("mixcode settings accept jsonc comments and trailing commas", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-jsonc-settings-"));
  try {
    await fsPromises.writeFile(
      path.join(dir, "mixcode_settings.json"),
      `{
        // Cap oversized assistant messages.
        "ui": {
          "oversizedAssistantMessage": {
            "maxLines": 256,
          },
        },
      }`,
      "utf8",
    );

    const file = path.join(dir, "mixcode_settings.json");
    assert.deepEqual(await loadMixCodeSettings(file), {
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 256, maxBytes: 128 * 1024 },
        icons: { mode: "nerd" },
        inlineWidgets: false,
        boxedHiddenThinking: false,
      },
      disabledProviders: [],
      disabledModels: [],
    });
    await fsPromises.writeFile(file, "[]", "utf8");
    await assert.rejects(() => loadMixCodeSettings(file), /Expected JSON object/);
    await fsPromises.writeFile(file, '{"a":1,', "utf8");
    await assert.rejects(() => loadMixCodeSettings(file), SyntaxError);
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
      await fsPromises.writeFile(
        file,
        JSON.stringify({ ui: { oversizedAssistantMessage: value } }),
        "utf8",
      );
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
      ui: {
        oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 128 * 1024 },
        icons: { mode: "nerd" },
        inlineWidgets: false,
        boxedHiddenThinking: false,
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
    const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
    });
    selectSettingsItemByLabel(panel, "Icon mode");

    assert.match(stripAnsi(panel.render(80).join("\n")), /Icon mode/);
    // Open enum, pick ascii (index 2), confirm.
    panel.handleInput("\r");
    panel.enumIndex = 2;
    panel.handleInput("\r");
    await Bun.sleep(30);

    assert.equal(panel.mixcodeRaw.ui?.icons?.mode, "ascii");
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
  const panel = createSettingsPanel(state, settingsManager, {
    mixcodeFile: "/tmp/unused-mixcode-settings.json",
    piSettingsFile: "/tmp/unused-pi-settings.json",
  });

  panel.handleInput("\r"); // hideThinkingBlock at index 0
  await Bun.sleep(30);

  assert.match(panel.editError ?? "", /settings disk is read-only/);
  assert.equal(settingsManager.getHideThinkingBlock(), false);
  assert.equal(state.hideThinkingBlock ?? false, false);
});

test("settings panel surfaces write failures without applying the new value", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-write-error-"));
  try {
    const state = createInitialState(dir);
    const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
      mixcodeFile: dir, // Writing JSON to a directory must fail.
      piSettingsFile: path.join(dir, "settings.json"),
    });
    selectSettingsItemByLabel(panel, "Icon mode");

    panel.handleInput("\r");
    panel.enumIndex = 2;
    panel.handleInput("\r");
    await Bun.sleep(30);

    assert.match(panel.editError ?? "", /Failed to save Icon mode/);
    assert.equal(panel.enumOpen, true);
    assert.equal(panel.mixcodeRaw.ui?.icons?.mode, undefined);
    assert.equal(state.ui?.icons.mode, "nerd");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel wraps selection from the first item to the last", () => {
  const state = createInitialState("/repo");
  const panel = createSettingsPanel(state, SettingsManager.inMemory());

  panel.handleInput("\x1b[A");
  assert.ok(panel.selectedIndex > 0);
  const last = panel.selectedIndex;
  panel.handleInput("\x1b[B");
  assert.equal(panel.selectedIndex, 0);
  panel.handleInput("\x1b[A");
  assert.equal(panel.selectedIndex, last);
});

test("settings panel filters the main list and activates the selected match", () => {
  const state = createInitialState("/repo");
  state.settingsPanel.open = true;
  const panel = createSettingsPanel(state, SettingsManager.inMemory());

  for (const char of "image") panel.handleInput(char);

  const filtered = stripAnsi(panel.render(100).join("\n"));
  assert.match(filtered, /filter: image/i);
  assert.match(filtered, /Show images/);
  assert.match(filtered, /Image width \(cells\)/);
  assert.match(filtered, /Block images to model/);
  assert.doesNotMatch(filtered, /Hide thinking blocks/);

  panel.handleInput("\x1b[B");
  panel.handleInput("\r");
  assert.equal(panel.editMode, true);
  assert.equal(panel.selectedIndex, 6); // imageWidthCells in ITEMS

  panel.handleInput("\x1b");
  assert.equal(panel.editMode, false);
  panel.handleInput("\x7f");
  assert.equal(panel.filterQuery, "imag");
  panel.handleInput("\x1b");
  assert.equal(panel.filterQuery, "");
  assert.equal(state.settingsPanel.open, true);

  for (const char of "markdown.mermaid") panel.handleInput(char);
  const keyFiltered = stripAnsi(panel.render(100).join("\n"));
  assert.match(keyFiltered, /Mermaid diagrams/);
  assert.doesNotMatch(keyFiltered, /Show images/);

  panel.handleInput("\x1b");
  panel.handleInput("\x1b");
  assert.equal(state.settingsPanel.open, false);
});

test("settings panel handles a filter with no matching settings", () => {
  const state = createInitialState("/repo");
  state.settingsPanel.open = true;
  const panel = createSettingsPanel(state, SettingsManager.inMemory());

  for (const char of "zzzzz") panel.handleInput(char);
  assert.match(stripAnsi(panel.render(100).join("\n")), /No matching settings/);

  panel.handleInput("\x1b[A");
  panel.handleInput("\r");
  assert.equal(panel.editMode, false);
  assert.equal(panel.enumOpen, false);
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

test("mixcode settings load ui.boxedHiddenThinking and reject non-booleans", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-boxed-thinking-settings-"));
  try {
    const file = path.join(dir, "mixcode_settings.json");
    assert.equal((await loadMixCodeSettings(file)).ui.boxedHiddenThinking, false);
    await fsPromises.writeFile(file, JSON.stringify({ ui: { boxedHiddenThinking: true } }), "utf8");
    assert.equal((await loadMixCodeSettings(file)).ui.boxedHiddenThinking, true);
    await fsPromises.writeFile(
      file,
      JSON.stringify({ ui: { boxedHiddenThinking: "yes" } }),
      "utf8",
    );
    await assert.rejects(
      () => loadMixCodeSettings(file),
      /ui\.boxedHiddenThinking must be a boolean/,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("settings panel toggles boxedHiddenThinking live and persists to disk", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-boxed-thinking-panel-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  await fsPromises.writeFile(mixcodeFile, "{}\n");
  try {
    const state = createInitialState(dir);
    const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
    });
    selectSettingsItemByLabel(panel, "Thinking tail preview");

    panel.handleInput("\r");
    await Bun.sleep(30);

    assert.equal(
      JSON.parse(await fsPromises.readFile(mixcodeFile, "utf8")).ui.boxedHiddenThinking,
      true,
    );
    assert.equal(state.ui?.boxedHiddenThinking, true);
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
    const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
    });
    selectSettingsItemByLabel(panel, "Inline widgets");

    assert.match(stripAnsi(panel.render(80).join("\n")), /Inline widgets/);
    panel.handleInput("\r");
    await Bun.sleep(30);

    assert.equal(JSON.parse(await fsPromises.readFile(mixcodeFile, "utf8")).ui.inlineWidgets, true);
    assert.equal(state.ui?.inlineWidgets, true);
    assert.equal(tab.inlineWidgets, true);
    const next = createTab(state.tabs.length + 1, "s2", dir, {
      inlineWidgets: state.ui?.inlineWidgets === true,
    });
    state.tabs.push(next);
    assert.equal(next.inlineWidgets, true);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
