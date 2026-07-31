// Tests for runtime-pi-tui-bridge.
//
// Layout is package-manager dependent:
// - npm + upstream shrinkwrap may install a second pi-tui under
//   pi-coding-agent/node_modules (two module instances).
// - bun (and some npm trees) dedupe to a single top-level pi-tui.
//
// Contract under both: applyMixCodeKeybindings always installs the mixcode
// manager on the top-level instance. When a distinct nested instance exists,
// it is mirrored too so upstream renderers do not show blank key hints.

import assert from "node:assert/strict";
import { test } from "node:test";

import { getKeybindings as getOuterKeybindings } from "@earendil-works/pi-tui";

import { applyMixCodeKeybindings, loadNestedPiTui } from "../src/agent/runtime-pi-tui-bridge.js";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../src/agent/runtime-extension-theme.js";

test("applyMixCodeKeybindings installs mixcode manager on top-level pi-tui", () => {
  const previousOuter = getOuterKeybindings();
  const restore = applyMixCodeKeybindings();
  try {
    assert.strictEqual(
      getOuterKeybindings(),
      MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
      "top-level pi-tui must point at the mixcode manager",
    );
    const expandKeys = (
      getOuterKeybindings() as { getKeys: (id: never) => string[] }
    ).getKeys("app.tools.expand" as never);
    assert.deepEqual(expandKeys, ["ctrl+o"]);
  } finally {
    restore();
  }
  assert.strictEqual(getOuterKeybindings(), previousOuter);
});

test("when nested pi-tui exists, applyMixCodeKeybindings mirrors onto it", async () => {
  const nested = await loadNestedPiTui();
  if (!nested) {
    // bun (or any deduped install): single instance is correct; nothing to mirror.
    return;
  }

  const outer = await import("@earendil-works/pi-tui");
  assert.notStrictEqual(
    nested.setKeybindings,
    outer.setKeybindings,
    "nested pi-tui must be a separate module instance when present",
  );

  const previousOuter = getOuterKeybindings();
  const previousNested = nested.getKeybindings();
  const restore = applyMixCodeKeybindings();
  try {
    assert.strictEqual(getOuterKeybindings(), MIXCODE_EXTENSION_KEYBINDINGS_MANAGER);
    assert.strictEqual(
      nested.getKeybindings(),
      MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
      "nested pi-tui must point at the same mixcode manager",
    );
    const expandKeys = (
      nested.getKeybindings() as { getKeys: (id: never) => string[] }
    ).getKeys("app.tools.expand" as never);
    assert.deepEqual(expandKeys, ["ctrl+o"]);
  } finally {
    restore();
  }
  assert.strictEqual(getOuterKeybindings(), previousOuter);
  assert.strictEqual(nested.getKeybindings(), previousNested);
});
