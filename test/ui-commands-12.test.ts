import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createQuestionRequest,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  renderQuestionOverlay,
  renderShellOverlay,
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

test("global key input covers extension input transforms picker errors and shell close paths", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    shellOpen: true,
    shellSession: { cwd: "/repo", command: "sh", buffer: ["one"], input: "" },
    pendingMessages: ["local queued"],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let overlayOpen = false;
  const overlays: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
    stop: () => {
      throw new Error("stop failed");
    },
  };
  let text = "";
  const editorActions = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    insertTextAtCursor: (next: string) => {
      text += next;
    },
    submitCurrentText: () => {
      text = "";
    },
  };
  const runtime = {
    dispatchTerminalInput: (_sessionId: string, data: string) =>
      data === "consume"
        ? { consume: true }
        : data === "mutate"
          ? { data: "changed" }
          : data === "empty"
            ? { data: "" }
            : undefined,
    refreshAllTabStatuses: () => [tab],
    updateTabWorkdir: async () => {
      throw new Error("workdir failed");
    },
    closeAllTabs: async () => undefined,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "consume", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(handleMixCodeKeyInput(state, "mutate", tui, undefined, runtime), undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "empty", tui, undefined, runtime), {
    consume: true,
  });
  state.activeTabId = "missing";
  assert.equal(handleMixCodeKeyInput(state, "\x1b[<0;1;3M", tui), undefined);
  state.activeTabId = "s1";

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(tab.shellOpen, false);

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "inline prompt\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(text, "");
  assert.equal(
    handleMixCodeKeyInput(state, "no submit\r", tui, undefined, runtime, undefined, () => false, {
      getText: () => text,
      setText: (next: string) => {
        text = next;
      },
    }),
    undefined,
  );
  state.activeTabId = "config";
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "config submit\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "@",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );
  state.activeTabId = "s1";
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "autocomplete submit\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => true,
      editorActions,
    ),
    undefined,
  );
  overlayOpen = true;
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "overlay submit\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );
  overlayOpen = false;
  state.tabJumpOpen = true;
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "help submit\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );
  state.tabJumpOpen = false;
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "bad\u0001\r",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );
  state.picker = {
    kind: "thinking",
    title: "Choose Thinking",
    query: "",
    selectedIndex: 0,
    items: [{ id: "invalid", label: "invalid", description: "" }],
  };
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.match(overlays.at(-1) ?? "", /Unknown thinking level: invalid/);
  state.picker = undefined;
  overlayOpen = false;

  state.picker = {
    kind: "workdir",
    title: "Change Workdir",
    query: "/repo",
    selectedIndex: 0,
    items: [{ id: "/tmp/next", label: "/tmp/next", description: "" }],
  };
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlays.at(-1) ?? "", /workdir failed/);
  state.picker = undefined;
  overlayOpen = false;
  assert.equal(handleMixCodeKeyInput(state, "x", tui), undefined);
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "\u0000",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      editorActions,
    ),
    undefined,
  );

  tab.pendingMessages = [];
  tab.status = "thinking";
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b", tui, undefined, {
      getTab: () => ({ agent: { state: { isStreaming: true } } }),
    }),
    { consume: true },
  );
  assert.throws(
    () =>
      handleMixCodeKeyInput(state, "\x1b", tui, undefined, {
        getTab: () => ({ agent: { state: { isStreaming: true } } }),
      }),
    /runtime abort support/,
  );
  tab.pendingEscapeAction = undefined;
  tab.status = "idle";

  tab.pendingQuestions.push(createQuestionRequest("empty", "s1", []));
  assert.equal(handleMixCodeKeyInput(state, "?", tui, undefined, runtime), undefined);
  tab.pendingQuestions = [];
  const customRequest = createQuestionRequest("custom-nav", "s1", [
    {
      header: "Custom",
      question: "Custom?",
      options: [{ label: "One", description: "" }],
      multiple: false,
      custom: true,
    },
    {
      header: "Next",
      question: "Next?",
      options: [{ label: "Two", description: "" }],
      multiple: false,
      custom: false,
    },
  ]);
  customRequest.editingCustomIndex = 0;
  customRequest.highlightedOptionIndices[0] = 1;
  tab.pendingQuestions.push(customRequest);
  assert.deepEqual(handleMixCodeKeyInput(state, "a", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui, undefined, runtime), {
    consume: true,
  });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1;5B", tui, undefined, runtime), {
    consume: true,
  });
  customRequest.editingCustomIndex = 0;
  customRequest.highlightedOptionIndices[0] = 1;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1;5A", tui, undefined, runtime), {
    consume: true,
  });
  customRequest.editingCustomIndex = 0;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1;5D", tui, undefined, runtime), {
    consume: true,
  });
  customRequest.editingCustomIndex = 0;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[1;5C", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(customRequest.currentQuestionIndex, 1);
  customRequest.editingCustomIndex = 1;
  assert.deepEqual(handleMixCodeKeyInput(state, "\u0001", tui, undefined, runtime), {
    consume: true,
  });
  tab.pendingQuestions = [];

  state.quitConfirmOpen = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "?", tui, undefined, runtime), { consume: true });
  assert.equal(state.quitConfirmOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), { consume: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlays.at(-1) ?? "", /stop failed/);

  state.quitConfirmOpen = false;
  overlayOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "r", tui, undefined, runtime), undefined);
  assert.equal(tab.status, "idle");
});

test("global key input exposes queue, quit, export, and inactive edge cases", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let overlayOpen = false;
  const overlays: string[] = [];
  const stops: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(100).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
    stop: () => {
      stops.push("stop");
      throw new Error("stop failed");
    },
  };

  assert.throws(() => handleMixCodeKeyInput(state, "\x1b", tui), /runtime queue support/);
  tab.pendingMessages = [];
  state.quitConfirmOpen = true;
  assert.deepEqual(
    handleMixCodeKeyInput(state, "y", tui, undefined, { closeAllTabs: async () => undefined }),
    { consume: true },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(stops, ["stop"]);
  assert.match(overlays.at(-1) ?? "", /stop failed/);

  state.activeTabId = "missing";
  state.exportChooserOpen = true;
  overlayOpen = false;
  assert.equal(
    handleMixCodeKeyInput(state, "z", tui, undefined, { getTab: () => undefined }),
    undefined,
  );
  assert.throws(() => handleMixCodeKeyInput(state, "t", tui), /runtime tab access/);
  state.tabs.length = 0;
  assert.throws(
    () => handleMixCodeKeyInput(state, "t", tui, undefined, { getTab: () => undefined }),
    /No active tab/,
  );
});
