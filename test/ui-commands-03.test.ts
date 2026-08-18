import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  tabBarHitRegions,
  setTheme,
  themeForId,
} from "./helpers/mixcode.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";
import type { Model } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL } from "./helpers/mixcode.js";

type TestChatLine = { role: "system"; text: string };

function assertQuitOverlay(text: string | undefined): void {
  assert.match(text ?? "", /┌/);
  assert.match(text ?? "", /Quit MixCode/);
  assert.match(text ?? "", /\[Y\] Quit/);
}

async function waitFor<T>(read: () => Promise<T>, attempts = 25): Promise<T> {
  let lastError: unknown;
  for (let index = 0; index < attempts; index++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await Bun.sleep(10);
    }
  }
  throw lastError;
}

test("global @ input stays in editor", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let overlayOpen = false;
  let editorText = "";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };
  const editorActions = {
    getText: () => editorText,
    setText: (text: string) => {
      editorText = text;
    },
    insertTextAtCursor: (text: string) => {
      editorText += text;
    },
  };

  assert.equal(
    handleMixCodeKeyInput(
      state,
      "@",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );
  assert.equal(editorText, "");
  assert.equal(overlayOpen, false);
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "@",
      tui,
      undefined,
      undefined,
      undefined,
      () => true,
      editorActions,
    ),
    undefined,
  );
});

test("ctrl+q opens a quit confirmation overlay when the prompt is empty", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { pendingEscapeArmedAt: 1_700_000_000_000 }));
  state.activeTabId = "s1";
  let overlayOpen = false;
  let rendered = "";
  const lifecycle: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      rendered =
        typeof component === "string"
          ? component
          : (component.render?.(80).join("\n") ?? String(component));
      return {
        hide: () => {
          overlayOpen = false;
        },
      } as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
    stop: () => lifecycle.push("stop"),
  };
  const runtime = {
    closeAllTabs: async () => {
      lifecycle.push("closeAll");
    },
  } as unknown as MixCodeRuntime;

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x11", tui, undefined, undefined, undefined, () => false, {
      getText: () => "   ",
      setText: () => undefined,
    }),
    { consume: true },
  );
  assert.equal(state.quitConfirmOpen, true);
  assert.equal(state.tabs[0]?.pendingEscapeArmedAt, undefined);
  assertQuitOverlay(rendered);
  assert.deepEqual(handleMixCodeKeyInput(state, "n", tui), { consume: true });
  assert.equal(state.quitConfirmOpen, false);
  assert.equal(overlayOpen, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x11", tui, undefined, runtime), {
    consume: true,
  });
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), { consume: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lifecycle, ["stop", "closeAll"]);
});
