// Header keyboard-shortcut hints (Pi's builtin-header analogue): a compact
// one-liner by default, expanded to the full global keymap when the user
// presses ctrl+o (tools-expand), sharing tab.extensionUi.toolsExpanded like
// Pi's setToolsExpanded which flips header and chat blocks together.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab } from "../src/index.js";
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

test("collapsed hints render a compact line with the core key set", () => {
  const lines = renderHeaderKeyHints(tabWithSummary(false), WIDTH).map(stripAnsi);
  const joined = lines.join("\n");
  assert.match(joined, /esc interrupt/);
  assert.match(joined, /esc esc tree/);
  assert.match(joined, /tab tabs/);
  assert.match(joined, /ctrl\+p commands/);
  assert.match(joined, /ctrl\+t jump/);
  assert.match(joined, /ctrl\+e editor/);
  assert.match(joined, /ctrl\+u dequeue/);
  assert.match(joined, /! bash/);
  assert.match(joined, /ctrl\+o more/);
  // Compact form must not include the expanded-only per-key descriptions.
  assert.doesNotMatch(joined, /command palette/i);
  // Stays a short block (wraps, but nowhere near the expanded list height).
  assert.ok(lines.length <= 3, `compact block stays short, got ${lines.length} lines`);
});

test("expanded hints list the global keymap one per line and point at /hotkeys", () => {
  const lines = renderHeaderKeyHints(tabWithSummary(true), WIDTH).map(stripAnsi);
  const joined = lines.join("\n");
  // Real keymap entries (descriptions from MIXCODE_KEYMAP, keys merged by action).
  assert.match(joined, /ctrl\+p\s+Open command palette/);
  assert.match(joined, /ctrl\+t\s+Open tab jump overlay/);
  assert.match(joined, /alt\+up\/ctrl\+u\s+Pop last queued message/);
  assert.match(joined, /ctrl\+o\s+/);
  // Bash / slash-command rows.
  assert.match(joined, /!!\s+Run bash command/);
  // Full list escape hatch.
  assert.match(joined, /\/hotkeys/);
  assert.ok(lines.length > 5, "expanded form is a multi-line list");
});

test("hints are absent without a startup summary and ride above it in the surface", () => {
  const bare = createTab(1, "s1", "/repo");
  assert.deepEqual(renderHeaderKeyHints(bare, WIDTH), []);

  const tab = tabWithSummary(false);
  const surface = renderAgentSurface(tab, { chat: [] } as never, WIDTH, undefined).map(stripAnsi);
  const joined = surface.join("\n");
  const hintIndex = surface.findIndex((line) => line.includes("esc interrupt"));
  const contextIndex = surface.findIndex((line) => line.includes("[Context]"));
  assert.ok(hintIndex >= 0, `hint line rendered:\n${joined}`);
  assert.ok(contextIndex > hintIndex, "hints render above the startup summary");
});

test("toggling toolsExpanded switches the surface between compact and expanded hints", () => {
  const tab = tabWithSummary(false);
  const collapsed = renderAgentSurface(tab, { chat: [] } as never, WIDTH, undefined)
    .map(stripAnsi)
    .join("\n");
  assert.match(collapsed, /ctrl\+o more/);
  assert.doesNotMatch(collapsed, /Open command palette/);

  tab.extensionUi.toolsExpanded = true;
  const expanded = renderAgentSurface(tab, { chat: [] } as never, WIDTH, undefined)
    .map(stripAnsi)
    .join("\n");
  assert.match(expanded, /Open command palette/);
  assert.doesNotMatch(expanded, /ctrl\+o more/);
});
