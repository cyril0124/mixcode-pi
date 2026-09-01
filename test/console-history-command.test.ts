import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { installConsoleTuiBridge } from "../src/cli/console-tui-bridge.js";
import {
  dispatchAppOverlayInput,
  setDefaultExternalEditorResolver,
} from "../src/ui/app-overlays.js";
import {
  createInitialState,
  createTab,
  handleSubmittedInput,
  type MixCodeRuntime,
} from "./helpers/mixcode.js";

test("/console-history chooses an available editor and keeps the Pi fallback read-only", async () => {
  const originalConsole = {
    log: console.log,
    info: console.info,
    debug: console.debug,
    warn: console.warn,
    error: console.error,
  };
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-console-history-"));
  const captureFile = path.join(dir, "captured.log");
  const editorScript = path.join(dir, "editor.sh");
  const failingEditorScript = path.join(dir, "failing-editor.sh");
  let component: Component | undefined;
  let hidden = 0;
  const lifecycle: string[] = [];
  const tui = {
    terminal: { rows: 20, columns: 100 },
    requestRender: () => undefined,
    showOverlay: (next: Component) => {
      component = next;
      return { hide: () => hidden++ } as never;
    },
    pause: () => lifecycle.push("pause"),
    resume: () => lifecycle.push("resume"),
  };
  const state = createInitialState("/repo");
  const runtime = {} as MixCodeRuntime;

  try {
    setDefaultExternalEditorResolver(() => path.join(dir, "missing-editor"));
    await handleSubmittedInput(state, runtime, "/console-history", tui);
    assert.match(component?.render(80).join("\n") ?? "", /No console history in this process/);
    assert.equal(dispatchAppOverlayInput(tui, "q"), true);

    installConsoleTuiBridge();
    for (let index = 0; index < 12; index++) console.log(`line-${index}`);
    await fs.writeFile(
      editorScript,
      `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then exit 0; fi\ncp "$1" "${captureFile}"\n`,
      { mode: 0o755 },
    );
    await fs.writeFile(
      failingEditorScript,
      `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then exit 0; fi\nexit 7\n`,
      { mode: 0o755 },
    );

    setDefaultExternalEditorResolver(() => editorScript);
    await handleSubmittedInput(state, runtime, "/console-history", tui);
    const captured = await fs.readFile(captureFile, "utf8");
    assert.match(captured, /\[console\.log\]: line-0/);
    assert.match(captured, /\[console\.log\]: line-11/);
    assert.deepEqual(lifecycle, ["pause", "resume"]);

    setDefaultExternalEditorResolver(() => failingEditorScript);
    await assert.rejects(
      () => handleSubmittedInput(state, runtime, "/console-history", tui),
      /External editor exited with 7/,
    );
    assert.deepEqual(lifecycle, ["pause", "resume", "pause", "resume"]);

    setDefaultExternalEditorResolver(() => path.join(dir, "missing-editor"));
    await handleSubmittedInput(state, runtime, "/console-history", tui);
    const bottom = component?.render(80).join("\n") ?? "";
    assert.doesNotMatch(bottom, /\[console\.log\]: line-0(?:\D|$)/);
    assert.match(bottom, /\[console\.log\]: line-11/);

    assert.equal(dispatchAppOverlayInput(tui, "x"), true);
    assert.equal(component?.render(80).join("\n") ?? "", bottom);

    assert.equal(dispatchAppOverlayInput(tui, "\x1b[A"), true);
    assert.notEqual(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "\x1b[B"), true);
    assert.equal(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "\x1b[D"), true);
    assert.notEqual(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "\x1b[C"), true);
    assert.equal(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "k"), true);
    assert.notEqual(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "j"), true);
    assert.equal(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "\x15"), true);
    assert.notEqual(component?.render(80).join("\n") ?? "", bottom);
    assert.equal(dispatchAppOverlayInput(tui, "\x04"), true);
    assert.match(component?.render(80).join("\n") ?? "", /\[console\.log\]: line-11/);
    assert.equal(dispatchAppOverlayInput(tui, "g"), true);
    assert.match(component?.render(80).join("\n") ?? "", /\[console\.log\]: line-0/);
    assert.equal(dispatchAppOverlayInput(tui, "G"), true);
    assert.doesNotMatch(component?.render(80).join("\n") ?? "", /\[console\.log\]: line-0(?:\D|$)/);
    assert.equal(dispatchAppOverlayInput(tui, "q"), true);

    const tab = createTab(1, "s1", "/repo", { status: "done" });
    state.tabs.push(tab);
    state.activeTabId = tab.sessionId;
    await handleSubmittedInput(state, runtime, "/console-history", tui);
    assert.match(component?.render(80).join("\n") ?? "", /\[console\.log\]: line-11/);
    assert.equal(dispatchAppOverlayInput(tui, "\x1b"), true);
    assert.equal(hidden, 3);
  } finally {
    Object.assign(console, originalConsole);
    setDefaultExternalEditorResolver(undefined);
    await fs.rm(dir, { recursive: true, force: true });
  }
});
