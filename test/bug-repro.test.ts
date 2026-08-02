import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  editTextInExternalEditor,
  runLuaScript,
} from "../src/index.js";

const execFileAsync = promisify(execFile);

test("runLuaScript rejects non-string open_tab fields with clear field errors", async () => {
  await assert.rejects(
    () => runLuaScript("mixcode.open_tab({ name = 123, prompt = 'p' })", "bad.lua"),
    /name.*string/,
  );
  await assert.rejects(
    () => runLuaScript("mixcode.open_tab({ name = 'n', prompt = false })", "bad.lua"),
    /prompt.*string/,
  );
});

test("external editor supports executable paths containing spaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-editor-space-"));
  try {
    const editorDir = join(dir, "editor dir");
    await mkdir(editorDir);
    const script = join(editorDir, "editor.sh");
    await writeFile(script, "#!/bin/sh\nprintf 'edited through spaced path\\n' > \"$1\"\n", "utf8");
    await chmod(script, 0o755);
    assert.equal(
      await editTextInExternalEditor("initial", { editor: script, tempRoot: dir }),
      "edited through spaced path\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Photon wasm materialization is covered by binary-assets.test.ts via
// materializeBinaryRuntimeAssets (runtime write of photon_rs_bg.wasm).

test("package bin symlink starts the CLI instead of silently exiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bin-link-"));
  try {
    const linkPath = join(dir, "mixcode-pi");
    await symlink(join(process.cwd(), "src", "cli", "main.ts"), linkPath);
    // Bun runs .ts natively; --import tsx was the Node-era loader and fails
    // under Bun with an unrelated cjs resolution error.
    const { stdout } = await execFileAsync(process.execPath, [linkPath, "--help"], {
      timeout: 20_000,
      env: { ...process.env, NODE_OPTIONS: "", NODE_V8_COVERAGE: "" },
    });
    assert.match(stdout, /Usage: mixcode-pi \[options\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
