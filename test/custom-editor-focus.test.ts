import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, type Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeRuntime,
  createInitialState,
  createMixCodeTui,
  createTab,
} from "../src/index.js";

// Regression: a ctx.ui.custom editor replacement looked like its input row was
// missing because focus never reached the nested Focusable component, so
// CURSOR_MARKER was never emitted between the editor borders.

async function waitFor(predicate: () => boolean, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (predicate()) return;
    await Bun.sleep(10);
  }
  assert.equal(predicate(), true);
}

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

test("ctx.ui.custom editor replacement forwards focus so nested cursor is visible", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-custom-editor-focus-"));
  let nestedFocused = false;
  let closeCustom: ((value: string) => void) | undefined;
  const extension: ExtensionFactory = (pi) => {
    pi.registerCommand("focus-cursor", {
      description: "Custom editor focus smoke",
      handler: async (_args, ctx) => {
        await ctx.ui.custom<string>((_tui, _theme, _keys, done) => {
          closeCustom = done;
          let focused = false;
          return {
            render: () => {
              nestedFocused = focused;
              // Mimic pi-tui Editor: emit cursor marker only when focused.
              return focused
                ? ["TOP", `${CURSOR_MARKER}`, "BOTTOM"]
                : ["TOP", " ", "BOTTOM"];
            },
            handleInput: () => undefined,
            invalidate: () => undefined,
            get focused() {
              return focused;
            },
            set focused(value: boolean) {
              focused = value;
            },
          };
        });
      },
    });
  };

  try {
    const state = createInitialState(process.cwd());
    const tab = createTab(1, "s1", process.cwd());
    state.tabs.push(tab);
    state.activeTabId = "s1";
    const runtime = new MixCodeRuntime({
      sessionsRoot: dir,
      extensionFactories: [extension],
    });
    await runtime.createTab(tab, {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: process.cwd(),
    });
    const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });
    try {
      const editor = (
        tui as unknown as {
          children: Array<{ editor: { render: (width: number) => string[] } }>;
        }
      ).children[0]!.editor;
      const task = runtime.prompt("s1", "/focus-cursor");
      await waitFor(() => {
        const surface = editor.render(80).join("\n");
        return surface.includes("TOP") && surface.includes("BOTTOM");
      });
      const surface = editor.render(80).join("\n");
      assert.equal(nestedFocused, true, "custom component must receive focused=true");
      assert.ok(surface.includes(CURSOR_MARKER), "focused custom editor must emit cursor marker");
      closeCustom?.("done");
      await task;
    } finally {
      tui.stop();
    }
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
