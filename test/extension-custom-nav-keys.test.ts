import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { createTab } from "../src/core/defaults.js";

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    if (predicate()) return;
    await Bun.sleep(25);
  }
  throw new Error("timed out");
}

test("custom() editor receives application-cursor and kitty arrows as CSI", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-custom-nav-"));
  const received: string[] = [];
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("nav-probe", {
      description: "Record custom handleInput bytes",
      handler: async (_args, ctx) => {
        await ctx.ui.custom((_tui, _theme, _keys, done) => ({
          render: () => ["nav-probe"],
          handleInput(data: string) {
            received.push(data);
            if (data === "\x1b") done(undefined);
          },
        }));
      },
    });
  };
  type EditorComponentLike = { handleInput(data: string): void };
  let editor: EditorComponentLike | undefined;
  const mockEditorHost = {
    tui: { terminal: { rows: 24, columns: 80 }, requestRender: () => undefined },
    editor: {
      getText: () => "",
      getExpandedText: () => "",
      setText: () => undefined,
      pasteToEditor: () => undefined,
      setEditorComponent: (factory: (() => EditorComponentLike) | undefined) => {
        editor = factory?.();
      },
      getEditorComponent: () => undefined,
    },
  };

  try {
    const runtime = new MixCodeRuntime({ sessionsRoot: dir, extensionFactories: [extension] });
    runtime.setExtensionUiHost(mockEditorHost as never);
    await runtime.createTab(createTab(1, "s1", process.cwd()), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const prompt = runtime.prompt("s1", "/nav-probe");
    await waitFor(() => editor !== undefined);
    editor!.handleInput("\x1bOB");
    editor!.handleInput("\x1bOA");
    editor!.handleInput("\x1b[1;1:1B");
    editor!.handleInput("\x1b");
    await prompt;
    assert.deepEqual(received, ["\x1b[B", "\x1b[A", "\x1b[B", "\x1b"]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
