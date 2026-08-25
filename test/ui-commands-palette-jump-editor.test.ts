import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { createInitialState, createTab, handleSubmittedInput } from "./helpers/mixcode.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";

function overlayTui() {
  const overlays: string[] = [];
  return {
    overlays,
    tui: {
      requestRender: () => undefined,
      showOverlay: (component: { render: (width: number) => string[] }) => {
        overlays.push(component.render(120).join("\n"));
        return { hide: () => undefined } as never;
      },
      hideOverlay: () => undefined,
      hasOverlay: () => overlays.length > 0,
      pause: () => undefined,
      resume: () => undefined,
    },
  };
}

function commandRuntime(): MixCodeRuntime {
  return {
    getExtensionCommands: () => [],
    getAllExtensionCommands: () => [],
    getTab: () => undefined,
  } as unknown as MixCodeRuntime;
}

test("/palette opens the command palette overlay", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const { overlays, tui } = overlayTui();

  await handleSubmittedInput(state, commandRuntime(), "/palette", tui);

  assert.equal(state.commandPaletteOpen, true);
  assert.match(stripAnsi(overlays.at(-1) ?? ""), /Command Palette|Settings|\/settings/);
});

test("/jump opens the tab jump overlay", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "Alpha" }));
  state.activeTabId = "s1";
  const { overlays, tui } = overlayTui();

  await handleSubmittedInput(state, commandRuntime(), "/jump", tui);

  assert.equal(state.tabJumpOpen, true);
  assert.match(stripAnsi(overlays.at(-1) ?? ""), /Alpha/);
});

test("/palette and /jump reject extra arguments", async () => {
  const state = createInitialState("/repo");
  const { tui } = overlayTui();
  const runtime = commandRuntime();

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/palette extra", tui),
    /Error: Usage: \/palette/,
  );
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/jump extra", tui),
    /Error: Usage: \/jump/,
  );
});

test("/editor writes the draft back from $EDITOR", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-editor-cmd-"));
  const editorScript = path.join(dir, "editor.sh");
  const previousEditor = process.env.EDITOR;
  const previousVisual = process.env.VISUAL;
  try {
    await fsPromises.writeFile(editorScript, `#!/bin/sh\nprintf 'from-editor\\n' > "$1"\n`, {
      mode: 0o755,
    });
    delete process.env.VISUAL;
    process.env.EDITOR = editorScript;

    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    state.activeTabId = "s1";
    const { tui } = overlayTui();
    let draft = "hello";
    await handleSubmittedInput(state, commandRuntime(), "/editor", tui, undefined, undefined, undefined, undefined, undefined, {
      getText: () => draft,
      setText: (next) => {
        draft = next;
      },
    });
    assert.equal(draft, "from-editor\n");
  } finally {
    if (previousEditor === undefined) delete process.env.EDITOR;
    else process.env.EDITOR = previousEditor;
    if (previousVisual === undefined) delete process.env.VISUAL;
    else process.env.VISUAL = previousVisual;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("/editor requires the input editor and rejects extra arguments", async () => {
  const state = createInitialState("/repo");
  const { tui } = overlayTui();
  const runtime = commandRuntime();

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/editor", tui),
    /Error: \/editor requires the input editor/,
  );
  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/editor extra", tui),
    /Error: Usage: \/editor/,
  );
});
