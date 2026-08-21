import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { editTextInExternalEditor } from "./helpers/mixcode.js";
import { editTextWithTuiPaused } from "../src/ui/app-overlays.js";
import type { OverlayTui } from "../src/ui/app-types.js";

/** OverlayTui spy: records pause/resume and the shutdown stop()/start() path. */
function createPauseSpyTui(): { tui: OverlayTui; calls: string[] } {
  const calls: string[] = [];
  const tui = {
    requestRender: () => {},
    showOverlay: () => {},
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    pause: () => calls.push("pause"),
    resume: () => calls.push("resume"),
  } as unknown as OverlayTui;
  return { tui, calls };
}

test("external editor edits text through a real temporary file", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-editor-"));
  try {
    const script = path.join(dir, "editor.sh");
    await fsPromises.writeFile(script, "#!/bin/sh\nprintf 'edited text\\n' > \"$1\"\n", "utf8");
    await fsPromises.chmod(script, 0o755);
    assert.equal(
      await editTextInExternalEditor("initial", { editor: script, tempRoot: dir }),
      "edited text\n",
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("external-editor pause uses pause/resume, never the shutdown stop/start", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-editor-"));
  try {
    const script = path.join(dir, "editor.sh");
    await fsPromises.writeFile(script, "#!/bin/sh\nprintf 'paused edit\\n' > \"$1\"\n", "utf8");
    await fsPromises.chmod(script, 0o755);
    const { tui, calls } = createPauseSpyTui();
    assert.equal(await editTextWithTuiPaused(tui, "initial", script), "paused edit\n");
    // stop() is the app-shutdown path (tears down ctl server + heartbeat);
    // the editor handoff must only pause and resume the renderer.
    assert.deepEqual(calls, ["pause", "resume"]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("external-editor pause resumes the renderer when the editor fails", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-editor-"));
  try {
    const script = path.join(dir, "fail.sh");
    await fsPromises.writeFile(script, "#!/bin/sh\nexit 7\n", "utf8");
    await fsPromises.chmod(script, 0o755);
    const { tui, calls } = createPauseSpyTui();
    await assert.rejects(
      () => editTextWithTuiPaused(tui, "initial", script),
      /External editor exited with 7/,
    );
    assert.deepEqual(calls, ["pause", "resume"]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("external editor reports missing configuration and non-zero exits", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-editor-"));
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
    const script = path.join(dir, "fail.sh");
    await fsPromises.writeFile(script, "#!/bin/sh\nexit 7\n", "utf8");
    await fsPromises.chmod(script, 0o755);
    await assert.rejects(
      () => editTextInExternalEditor("initial", { editor: script, tempRoot: dir }),
      /External editor exited with 7/,
    );
    const signalScript = path.join(dir, "signal.sh");
    await fsPromises.writeFile(signalScript, "#!/bin/sh\nkill -TERM $$\n", "utf8");
    await fsPromises.chmod(signalScript, 0o755);
    await assert.rejects(
      () => editTextInExternalEditor("initial", { editor: signalScript, tempRoot: dir }),
      /External editor exited with SIGTERM/,
    );
  } finally {
    if (oldVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = oldVisual;
    if (oldEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = oldEditor;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
