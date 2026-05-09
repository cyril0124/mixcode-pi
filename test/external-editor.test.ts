import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { editTextInExternalEditor } from "../src/index.js";

test("external editor edits text through a real temporary file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-editor-"));
  try {
    const script = join(dir, "editor.sh");
    await writeFile(script, "#!/bin/sh\nprintf 'edited text\\n' > \"$1\"\n", "utf8");
    await chmod(script, 0o755);
    assert.equal(
      await editTextInExternalEditor("initial", { editor: script, tempRoot: dir }),
      "edited text\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external editor reports missing configuration and non-zero exits", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-editor-"));
  const oldVisual = process.env.VISUAL;
  const oldEditor = process.env.EDITOR;
  try {
    delete process.env.VISUAL;
    delete process.env.EDITOR;
    await assert.rejects(
      () => editTextInExternalEditor("initial", { tempRoot: dir }),
      /External editor is not configured/,
    );
    await assert.rejects(
      () => editTextInExternalEditor("initial", { editor: "   ", tempRoot: dir }),
      /External editor command is empty/,
    );
    const script = join(dir, "fail.sh");
    await writeFile(script, "#!/bin/sh\nexit 7\n", "utf8");
    await chmod(script, 0o755);
    await assert.rejects(
      () => editTextInExternalEditor("initial", { editor: script, tempRoot: dir }),
      /External editor exited with 7/,
    );
    const signalScript = join(dir, "signal.sh");
    await writeFile(signalScript, "#!/bin/sh\nkill -TERM $$\n", "utf8");
    await chmod(signalScript, 0o755);
    await assert.rejects(
      () => editTextInExternalEditor("initial", { editor: signalScript, tempRoot: dir }),
      /External editor exited with SIGTERM/,
    );
  } finally {
    if (oldVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = oldVisual;
    if (oldEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = oldEditor;
    await rm(dir, { recursive: true, force: true });
  }
});
