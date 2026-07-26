import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  renderCommandPalette,
  renderTabJumpOverlay,
  stripAnsi,
} from "../src/index.js";

test("command palette windows long lists so the selected item stays visible", () => {
  const state = createInitialState("/repo");
  // Agent scope has many more palette entries than Home/config.
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.commandPaletteOpen = true;
  state.commandPalette = { query: "", selectedIndex: 35 };
  const extensionCommands = Array.from({ length: 40 }, (_, i) => ({
    name: `cmd-${String(i).padStart(2, "0")}`,
    description: `desc ${i}`,
  }));

  const plain = stripAnsi(renderCommandPalette(state, 100, extensionCommands).join("\n"));
  const rows = plain.split("\n").filter((line) => /\/cmd-\d{2}|cmd-\d{2}/.test(line)).length;
  assert.ok(rows < 40, `expected windowed palette rows, got ${rows}`);
  assert.match(plain, /more above|more below/);
  assert.match(plain, /›/);
});

test("tab jump windows long lists around tabJumpIndex", () => {
  const state = createInitialState("/repo");
  for (let i = 1; i <= 30; i++) {
    state.tabs.push(
      createTab(i, `s${i}`, "/repo", { title: `Agent-${String(i).padStart(2, "0")}` }),
    );
  }
  state.tabJumpOpen = true;
  state.tabJumpQuery = "";
  state.tabJumpIndex = 25;

  const plain = stripAnsi(renderTabJumpOverlay(state, 80).join("\n"));
  const agentRows = plain.split("\n").filter((line) => /Agent-\d{2}/.test(line)).length;
  assert.ok(agentRows < 30, `expected windowed tab jump rows, got ${agentRows}`);
  assert.match(plain, /more above|more below/);
  assert.match(plain, /Agent-2[5-9]|Agent-30/);
  assert.doesNotMatch(plain, /Agent-01/);
});
