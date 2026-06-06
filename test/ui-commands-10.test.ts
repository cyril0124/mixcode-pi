import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  tabBarHitRegions,
  setTheme,
  themeForId,
  themeSuggestions,
} from "../src/index.js";
import type { MixCodeRuntime } from "../src/index.js";
import type { Model } from "@earendil-works/pi-ai";
import { MIXCODE_FAUX_MODEL } from "../src/index.js";

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
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw lastError;
}

test("export chooser escape branch closes without a visible overlay handle", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.exportChooserOpen = true;
  state.exportChooserIndex = 2;
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.exportChooserOpen, false);
  assert.equal(state.exportChooserIndex, 0);
  assert.equal(renders, 1);
});

test("export chooser exposes missing runtime and active tab errors", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => true,
  };

  state.exportChooserOpen = true;
  assert.throws(() => handleMixCodeKeyInput(state, "t", tui), /runtime tab access/);
  assert.equal(state.exportChooserOpen, true);
  assert.throws(
    () => handleMixCodeKeyInput(state, "t", tui, undefined, { getTab: () => undefined }),
    /Unknown tab session/,
  );
  state.tabs.length = 0;
  state.activeTabId = "missing";
  assert.throws(
    () => handleMixCodeKeyInput(state, "t", tui, undefined, { getTab: () => undefined }),
    /No active tab/,
  );
});

