// Tests for runtime-pi-tui-bridge: ensure mixcode keybindings are mirrored
// onto both the top-level and the nested pi-tui copy that
// @earendil-works/pi-coding-agent ships via its npm-shrinkwrap. Without the
// bridge, upstream renderers (read/skill compact lines, etc.) resolve
// keyText("app.tools.expand") from an empty manager and emit blank labels
// like "( to expand)".

import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

import { getKeybindings as getOuterKeybindings } from "@earendil-works/pi-tui";

import { applyMixCodeKeybindings, loadNestedPiTui } from "../src/agent/runtime-pi-tui-bridge.js";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../src/agent/runtime-extension-theme.js";

test("nested pi-tui module is exposed and is a distinct module instance", async () => {
  const nested = await loadNestedPiTui();
  assert.ok(nested, "nested pi-tui must be discoverable when pi-coding-agent is installed");
  // The nested copy ships under pi-coding-agent's own node_modules/.
  // Confirm it's not the same module object as the top-level pi-tui.
  const outer = await import("@earendil-works/pi-tui");
  assert.notStrictEqual(
    nested.setKeybindings,
    outer.setKeybindings,
    "nested pi-tui must be a separate module instance — that is the bug we're guarding against",
  );
  // Sanity: both expose the same shape.
  assert.equal(typeof nested.setKeybindings, "function");
  assert.equal(typeof nested.getKeybindings, "function");
});

test("applyMixCodeKeybindings mirrors mixcode bindings onto the nested pi-tui copy", async () => {
  const nested = await loadNestedPiTui();
  assert.ok(nested);

  const previousOuter = getOuterKeybindings();
  const previousNested = nested.getKeybindings();

  const restore = applyMixCodeKeybindings();
  try {
    // Both copies see the mixcode manager; identity equality is the
    // strongest contract — it proves there is no divergent global state.
    assert.strictEqual(
      getOuterKeybindings(),
      MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
      "top-level pi-tui must point at the mixcode manager",
    );
    assert.strictEqual(
      nested.getKeybindings(),
      MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
      "nested pi-tui must point at the same mixcode manager",
    );
    // Resolved keys must match: this is the property upstream `keyText`
    // depends on for the "(ctrl+o to expand)" hint.
    const expandKeys = nested.getKeybindings().getKeys("app.tools.expand" as never);
    assert.deepEqual(expandKeys, ["ctrl+o"]);
  } finally {
    restore();
  }

  // Restore must reset both copies back to their previous managers.
  assert.strictEqual(getOuterKeybindings(), previousOuter);
  assert.strictEqual(nested.getKeybindings(), previousNested);
});
