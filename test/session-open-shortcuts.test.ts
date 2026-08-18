import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  MIXCODE_EXTENSION_KEYBINDINGS_MANAGER,
  reloadMixCodeUserKeybindings,
} from "../src/agent/runtime-extension-theme.js";

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

test("legacy keybindings.json names are migrated like Pi", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-keybindings-"));
  const previousEnv = process.env.PI_CODING_AGENT_DIR;
  try {
    await fsPromises.writeFile(
      path.join(dir, "keybindings.json"),
      JSON.stringify({ treeFoldOrUp: "ctrl+alt+f" }),
    );
    process.env.PI_CODING_AGENT_DIR = dir;
    reloadMixCodeUserKeybindings();
    // Pi migrates the legacy name to app.tree.foldOrUp; the user chord must
    // replace the MixCode defaults (ctrl+left / alt+left).
    assert.deepEqual(MIXCODE_EXTENSION_KEYBINDINGS_MANAGER.getKeys("app.tree.foldOrUp" as never), [
      "ctrl+alt+f",
    ]);
  } finally {
    if (previousEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousEnv;
    reloadMixCodeUserKeybindings();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
