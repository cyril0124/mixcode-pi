import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Component, Terminal } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createMixCodeTui,
  createTab,
  type MixCodeRuntime,
} from "../src/index.js";

async function waitForRuntime(predicate: () => boolean, attempts = 25): Promise<void> {
  for (let index = 0; index < attempts; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(predicate());
}

function silentTerminal(): Terminal {
  return {
    columns: 120,
    rows: 40,
    write: () => undefined,
    onData: () => () => undefined,
    start: () => undefined,
    stop: () => undefined,
    setRawMode: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[ -/]*[@-~]/g, "");
}

test("createMixCodeTui rescans at-completion files after workdir changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-completion-workdir-"));
  try {
    const oldDir = join(dir, "old");
    const newDir = join(dir, "new");
    await mkdir(oldDir, { recursive: true });
    await mkdir(newDir, { recursive: true });
    await writeFile(join(oldDir, "old-only.ts"), "");
    await writeFile(join(newDir, "new-only.ts"), "");
    const state = createInitialState(oldDir);
    const tab = createTab(1, "s1", oldDir);
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = {
      onChange: () => () => undefined,
      getTab: () => ({ tab, chat: [], reasoning: [] }),
      getExtensionCommands: () => [],
      getAllExtensionCommands: () => [],
      updateTabWorkdir: async (_sessionId: string, workdir: string) => {
        tab.workdir = workdir;
      },
    } as unknown as MixCodeRuntime;
    const tui = createMixCodeTui(state, runtime, {
      terminal: silentTerminal(),
      completionSources: { skills: [], files: ["old-only.ts"] },
    });
    try {
      const layout = (
        tui as unknown as {
          children: Array<{
            editor: {
              current: Component;
              setText: (text: string) => void;
              handleInput: (data: string) => void;
              isShowingAutocomplete: () => boolean;
            };
          }>;
        }
      ).children[0]!;

      layout.editor.handleInput("@");
      await waitForRuntime(() => layout.editor.isShowingAutocomplete());
      assert.match(stripAnsi(layout.editor.current.render(80).join("\n")), /old-only\.ts/);

      layout.editor.setText(`/workdir ${newDir}`);
      layout.editor.handleInput("\r");
      await waitForRuntime(() => tab.workdir === newDir);
      layout.editor.handleInput("@");
      await waitForRuntime(() =>
        /new-only\.ts/.test(stripAnsi(layout.editor.current.render(80).join("\n"))),
      );
      const rendered = stripAnsi(layout.editor.current.render(80).join("\n"));
      assert.match(rendered, /new-only\.ts/);
      assert.doesNotMatch(rendered, /old-only\.ts/);
    } finally {
      tui.stop();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
