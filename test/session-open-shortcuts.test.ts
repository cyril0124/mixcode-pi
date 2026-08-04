import assert from "node:assert/strict";
import { test } from "node:test";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../src/agent/runtime-extension-theme.js";

// MixCode no longer ships default global chords for session open actions
// (new/resume/fork/tree). Open them via slash commands or keybindings.json.

test("session open actions have no MixCode default keys", () => {
  const kb = MIXCODE_EXTENSION_KEYBINDINGS_MANAGER;
  // tree/resume/fork/new: either unbound here or empty defaults from Pi merge.
  for (const id of [
    "app.session.tree",
    "app.session.resume",
    "app.session.fork",
    "app.session.new",
  ] as const) {
    const keys = kb.getKeys(id as never);
    assert.deepEqual(keys, [], `${id} must not have a MixCode default chord`);
  }
  // Palette / tab jump still own ctrl+p / ctrl+t.
  assert.deepEqual(kb.getKeys("app.model.cycleForward" as never), ["ctrl+p"]);
  assert.deepEqual(kb.getKeys("app.model.cycleBackward" as never), ["ctrl+t"]);
});
