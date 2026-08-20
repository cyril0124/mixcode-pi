import assert from "node:assert/strict";
import { test } from "node:test";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { createInitialState, createPicker } from "./helpers/mixcode.js";
import { renderPickerOverlay } from "../src/ui/rendering/overlays.js";
import { createSettingsPanel, selectSettingsItemByLabel } from "./helpers/settings-panel.js";

function manyModels(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    provider: "faux",
    modelId: `m${String(i).padStart(2, "0")}`,
    displayName: `m${String(i).padStart(2, "0")}`,
    contextWindow: 1_000,
  }));
}

test("model picker windows long lists so the selected item stays visible", () => {
  const state = createInitialState("/repo");
  state.availableModels = manyModels(40);
  state.picker = createPicker("models", state);
  state.picker!.selectedIndex = 30;

  const plain = stripAnsi(renderPickerOverlay(state, 80).join("\n"));
  const body = plain.split("\n");

  assert.match(plain, /> m30\b/);
  // Full list must not dump every model row into the overlay body.
  const modelRows = body.filter((line) => /\bm\d{2}\b/.test(line)).length;
  assert.ok(modelRows < 40, `expected windowed rows, got ${modelRows}`);
  assert.ok(
    /more above|more below|\(\d+\/\d+\)/.test(plain),
    "windowed picker must show overflow affordance",
  );
  // Far-from-selection head item should be scrolled out.
  assert.doesNotMatch(plain, /> m00\b/);
  assert.ok(!body.some((line) => line.includes("m00") && !line.includes("filter")), "m00 scrolled out");
});

test("thinking picker windows long lists around the selection", () => {
  const state = createInitialState("/repo");
  state.picker = {
    kind: "thinking",
    title: "Choose Thinking",
    query: "",
    selectedIndex: 25,
    items: Array.from({ length: 40 }, (_, i) => ({
      id: `t${i}`,
      label: `tier-${i}`,
      description: "thinking tier",
    })),
  };

  const plain = stripAnsi(renderPickerOverlay(state, 80).join("\n"));
  assert.match(plain, /> tier-25\b/);
  const rows = plain.split("\n").filter((line) => /tier-\d+/.test(line)).length;
  assert.ok(rows < 40, `expected windowed thinking rows, got ${rows}`);
  assert.match(plain, /more above|more below|\(\d+\/\d+\)/);
});

test("settings enum options window around enumIndex", () => {
  const state = createInitialState("/repo");
  state.availableModels = manyModels(40);
  const panel = createSettingsPanel(state, SettingsManager.inMemory());
  panel.selectedIndex = 2; // Default model enum item
  panel.enumOpen = true;
  panel.enumIndex = 30;

  const plain = stripAnsi(panel.render(80).join("\n"));
  assert.match(plain, /› m30\b|m30/);
  const optionRows = plain.split("\n").filter((line) => /\bm\d{2}\b/.test(line)).length;
  assert.ok(optionRows < 40, `expected windowed enum options, got ${optionRows}`);
  assert.ok(
    /more above|more below|\(\d+\/\d+\)/.test(plain),
    "enum list must show overflow affordance",
  );
});

test("settings enum open keeps panel short so selection is not head-clipped", () => {
  // Regression for #5: windowing options alone still dumped every other settings
  // row into the overlay; TUI maxHeight then sliced the head and hid the caret.
  const state = createInitialState("/repo");
  state.availableModels = manyModels(40);
  const panel = createSettingsPanel(state, SettingsManager.inMemory());
  panel.selectedIndex = 2;
  panel.enumOpen = true;
  panel.enumIndex = 30;

  const lines = panel.render(80);
  const plain = stripAnsi(lines.join("\n"));
  assert.doesNotMatch(plain, /History max bytes/);
  assert.doesNotMatch(plain, /Collapse oversized messages/);
  assert.match(plain, /Default model/);
  assert.match(plain, /m30/);
  assert.ok(lines.length <= 20, `enum panel too tall for short terminals: ${lines.length}`);
});

test("settings main list keeps the selected section visible on a very short terminal", () => {
  const previousRows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 10, configurable: true });
  try {
    const state = createInitialState("/repo");
    const panel = createSettingsPanel(state, SettingsManager.inMemory());
    panel.selectedIndex = 15; // disabledProviders, in the Mixcode section

    const plain = stripAnsi(panel.render(80).join("\n"));
    assert.match(plain, /Mixcode/);
    assert.match(plain, /› Disabled providers|Disabled providers/);
    assert.match(plain, /type to filter/);
  } finally {
    Object.defineProperty(process.stdout, "rows", {
      value: previousRows,
      configurable: true,
    });
  }
});

test("settings main list windows so deep selection stays under overlay maxHeight", () => {
  // 20-line settings panel is head-clipped by TUI maxHeight on short terminals,
  // so selectedIndex near the bottom must not rely on a full static dump.
  const previousRows = process.stdout.rows;
  Object.defineProperty(process.stdout, "rows", { value: 14, configurable: true });
  try {
    const state = createInitialState("/repo");
    const panel = createSettingsPanel(state, SettingsManager.inMemory());

    selectSettingsItemByLabel(panel, "Oversized max bytes");
    const lines = panel.render(80);
    const plain = stripAnsi(lines.join("\n"));
    assert.match(plain, /› Oversized max bytes|Oversized max bytes/);
    assert.match(plain, /↑↓ select/);
    assert.match(plain, /more above/);
    // Must fit under a short-terminal 80% overlay budget (14 rows → ~11 body+borders).
    assert.ok(lines.length <= 14, `main list too tall: ${lines.length}`);
  } finally {
    Object.defineProperty(process.stdout, "rows", {
      value: previousRows,
      configurable: true,
    });
  }
});
