// Contract: pi-tui keybindings state is process-global (Symbol.for on
// globalThis), so duplicate module instances from bun --compile share one
// manager. Without this, /tree and /resume render blank key hints under mpi.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createRequire } from "node:module";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getKeybindings as getPkgKeybindings,
  setKeybindings as setPkgKeybindings,
  KeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";

import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../src/agent/runtime-extension-theme.js";
import { applyMixCodeKeybindings } from "../src/agent/runtime-pi-tui-bridge.js";

const KEY = Symbol.for("@earendil-works/pi-tui:keybindings");

test("setKeybindings stores manager on globalThis Symbol.for slot", () => {
  const previous = (globalThis as Record<symbol, unknown>)[KEY];
  const restore = applyMixCodeKeybindings();
  try {
    assert.strictEqual(
      (globalThis as Record<symbol, unknown>)[KEY],
      MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
    );
    assert.strictEqual(getPkgKeybindings(), MIXCODE_EXTENSION_KEYBINDINGS_MANAGER);
    assert.deepEqual(
      (getPkgKeybindings() as { getKeys: (id: never) => string[] }).getKeys(
        "app.tree.filter.cycleForward" as never,
      ),
      ["ctrl+o"],
    );
  } finally {
    restore();
    if (previous === undefined) {
      delete (globalThis as Record<symbol, unknown>)[KEY];
    } else {
      (globalThis as Record<symbol, unknown>)[KEY] = previous;
    }
  }
});

test("CJS require of keybindings.js sees the same global manager as package import", () => {
  // Simulates a second module evaluation path (absolute require) that still
  // must share state with the ESM package entry — the bun --compile failure mode.
  const require = createRequire(import.meta.url);
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const kbPath = path.join(repoRoot, "node_modules/@earendil-works/pi-tui/dist/keybindings.js");
  const cjs = require(kbPath) as {
    setKeybindings: (m: unknown) => void;
    getKeybindings: () => unknown;
  };

  const previous = (globalThis as Record<symbol, unknown>)[KEY];
  const marker = new KeybindingsManager({
    ...TUI_KEYBINDINGS,
    "app.tree.filter.all": { defaultKeys: "ctrl+a" },
  } as never);

  setPkgKeybindings(marker as never);
  try {
    assert.strictEqual(cjs.getKeybindings(), marker);
    assert.deepEqual(
      (cjs.getKeybindings() as { getKeys: (id: never) => string[] }).getKeys(
        "app.tree.filter.all" as never,
      ),
      ["ctrl+a"],
    );
    cjs.setKeybindings(MIXCODE_EXTENSION_KEYBINDINGS_MANAGER);
    assert.strictEqual(getPkgKeybindings(), MIXCODE_EXTENSION_KEYBINDINGS_MANAGER);
  } finally {
    if (previous === undefined) {
      delete (globalThis as Record<symbol, unknown>)[KEY];
    } else {
      (globalThis as Record<symbol, unknown>)[KEY] = previous;
      setPkgKeybindings(previous as never);
    }
  }
});
