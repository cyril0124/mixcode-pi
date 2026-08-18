// Header keyboard-shortcut hints (Pi's builtin-header analogue): a compact
// one-liner by default, expanded to the full global keymap when the user
// presses ctrl+o (tools-expand), sharing tab.extensionUi.toolsExpanded like
// Pi's setToolsExpanded which flips header and chat blocks together.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab } from "./helpers/mixcode.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { renderHeaderKeyHints } from "../src/ui/rendering/header-hints.js";

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

const WIDTH = 100;

function tabWithSummary(toolsExpanded = false) {
  const tab = createTab(1, "s1", "/repo");
  tab.startupSummary = "[Context]\n  ~/AGENTS.md\n";
  tab.extensionUi.toolsExpanded = toolsExpanded;
  return tab;
}

test("collapsed header hints stay compact and omit expanded keymap descriptions", () => {
  const lines = renderHeaderKeyHints(tabWithSummary(false), WIDTH).map(stripAnsi);
  const joined = lines.join("\n");
  assert.match(joined, /esc interrupt/);
  assert.match(joined, /ctrl\+p commands/);
  assert.match(joined, /ctrl\+o more/);
  assert.doesNotMatch(joined, /Open command palette/);
  assert.ok(lines.length <= 3, `compact block stays short, got ${lines.length} lines`);
});

test("expanded header hints list keymap rows and point at /hotkeys", () => {
  const lines = renderHeaderKeyHints(tabWithSummary(true), WIDTH).map(stripAnsi);
  const joined = lines.join("\n");
  assert.match(joined, /ctrl\+p\s+Open command palette/);
  assert.match(joined, /!!\s+Run bash command/);
  assert.match(joined, /\/hotkeys/);
  assert.ok(lines.length > 5, "expanded form is a multi-line list");
});

test("header hints require startup summary and sit above it on the agent surface", () => {
  const bare = createTab(1, "s1", "/repo");
  assert.deepEqual(renderHeaderKeyHints(bare, WIDTH), []);

  const tab = tabWithSummary(false);
  const surface = renderAgentSurface(tab, { chat: [] } as never, WIDTH, undefined).map(stripAnsi);
  const hintIndex = surface.findIndex((line) => line.includes("esc interrupt"));
  const contextIndex = surface.findIndex((line) => line.includes("[Context]"));
  assert.ok(hintIndex >= 0, "hint line rendered");
  assert.ok(contextIndex > hintIndex, "hints render above the startup summary");

  tab.extensionUi.toolsExpanded = true;
  const expanded = renderAgentSurface(tab, { chat: [] } as never, WIDTH, undefined)
    .map(stripAnsi)
    .join("\n");
  assert.match(expanded, /Open command palette/);
  assert.doesNotMatch(expanded, /ctrl\+o more/);
});
