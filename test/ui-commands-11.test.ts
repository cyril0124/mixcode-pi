import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createDialogRequest,
  createTab,
  expandLocalPromptCommand,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderConfig,
  renderInputMeta,
  renderPickerOverlay,
  renderQuestionOverlay,
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

test("global key input resolves extension dialog questions without prompting the model", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-select-1",
      "s1",
      [
        {
          header: "Pick",
          question: "Choose",
          options: [
            { label: "A", description: "Alpha" },
            { label: "B", description: "Beta" },
          ],
          multiple: false,
          custom: false,
        },
      ],
      { extensionResolverId: "extension-ui-select-1", extensionUiKind: "select" },
    ),
  );
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let resolved: unknown;
  let prompted = false;
  const changes: string[] = [];
  const runtime = {
    prompt: async () => {
      prompted = true;
    },
    resolveExtensionDialog: (_sessionId: string, requestId: string, result: unknown) => {
      resolved = result;
      const index = tab.pendingDialogs.findIndex((request) => request.requestId === requestId);
      if (index !== -1) tab.pendingDialogs.splice(index, 1);
      return true;
    },
  };
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.deepEqual(
    handleMixCodeKeyInput(state, " ", tui, undefined, runtime, () => changes.push("changed")),
    { consume: true },
  );
  assert.equal(resolved, "B");
  assert.equal(prompted, false);
  assert.equal(tab.pendingDialogs.length, 0);
  assert.deepEqual(changes, ["changed"]);

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-input-1",
      "s1",
      [{ header: "Name", question: "Type name", options: [], multiple: false, custom: true }],
      { extensionResolverId: "extension-ui-input-1", extensionUiKind: "input" },
    ),
  );
  tab.pendingDialogs[0]!.editingCustomIndex = 0;
  for (const char of "Neo") {
    assert.deepEqual(handleMixCodeKeyInput(state, char, tui, undefined, runtime), {
      consume: true,
    });
  }
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(resolved, "Neo");

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-input-empty",
      "s1",
      [{ header: "Name", question: "Type name", options: [], multiple: false, custom: true }],
      { extensionResolverId: "extension-ui-input-empty", extensionUiKind: "input" },
    ),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), { consume: true });
  assert.equal(resolved, "");

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-select-empty",
      "s1",
      [{ header: "Pick", question: "Choose", options: [], multiple: false, custom: false }],
      { extensionResolverId: "extension-ui-select-empty", extensionUiKind: "select" },
    ),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), { consume: true });
  assert.equal(resolved, undefined);

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-select-sparse",
      "s1",
      [{ header: "Pick", question: "Choose", options: [], multiple: false, custom: false }],
      { extensionResolverId: "extension-ui-select-sparse", extensionUiKind: "select" },
    ),
  );
  tab.pendingDialogs[0]!.selectedAnswers = [];
  tab.pendingDialogs[0]!.customAnswers = [];
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), { consume: true });
  assert.equal(resolved, undefined);

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-input-sparse-index",
      "s1",
      [
        {
          header: "First",
          question: "Skip this one",
          options: [{ label: "A", description: "" }],
          multiple: false,
          custom: false,
        },
        { header: "Name", question: "Type name", options: [], multiple: false, custom: true },
      ],
      { extensionResolverId: "extension-ui-input-sparse-index", extensionUiKind: "input" },
    ),
  );
  tab.pendingDialogs[0]!.selectedAnswers = [["A"]];
  tab.pendingDialogs[0]!.customAnswers = ["ignored"];
  assert.deepEqual(handleMixCodeKeyInput(state, "l", tui, undefined, runtime), { consume: true });
  assert.equal(tab.pendingDialogs[0]?.currentQuestionIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "y", tui, undefined, runtime), { consume: true });
  assert.equal(resolved, "");

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-missing-runtime",
      "s1",
      [{ header: "Pick", question: "Choose", options: [], multiple: false, custom: false }],
      { extensionResolverId: "extension-ui-missing-runtime", extensionUiKind: "select" },
    ),
  );
  assert.throws(() => handleMixCodeKeyInput(state, "y", tui), /runtime resolver support/);
  tab.pendingDialogs = [];

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-confirm-1",
      "s1",
      [
        {
          header: "Confirm",
          question: "Proceed?",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
          multiple: false,
          custom: false,
        },
      ],
      { extensionResolverId: "extension-ui-confirm-1", extensionUiKind: "confirm" },
    ),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime), { consume: true });
  assert.equal(resolved, "Yes");
  assert.equal(tab.pendingDialogs.length, 0);

  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-confirm-esc",
      "s1",
      [
        {
          header: "Confirm",
          question: "Proceed?",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
          multiple: false,
          custom: false,
        },
      ],
      { extensionResolverId: "extension-ui-confirm-esc", extensionUiKind: "confirm" },
    ),
  );
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(resolved, undefined);
  assert.equal(tab.pendingDialogs.length, 0);

  tab.status = "thinking";
  tab.pendingDialogs.push(
    createDialogRequest(
      "extension-ui-confirm-running-esc",
      "s1",
      [
        {
          header: "Confirm",
          question: "Proceed?",
          options: [
            { label: "Yes", description: "" },
            { label: "No", description: "" },
          ],
          multiple: false,
          custom: false,
        },
      ],
      {
        extensionResolverId: "extension-ui-confirm-running-esc",
        extensionUiKind: "confirm",
      },
    ),
  );
  let aborts = 0;
  const streamingRuntime = {
    ...runtime,
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  };
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, streamingRuntime), {
    consume: true,
  });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, streamingRuntime), {
    consume: true,
  });
  assert.equal(resolved, undefined);
  assert.equal(tab.pendingDialogs.length, 0);
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(aborts, 0);
});

test("escape flushes queued messages immediately when the active tab is idle", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued request"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders += 1;
    },
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const flushed: string[] = [];
  const runtime = {
    flushPendingMessage: async (sessionId: string) => {
      flushed.push(sessionId);
      tab.pendingMessages = [];
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(flushed, ["s1"]);
  assert.deepEqual(tab.pendingMessages, []);
  assert.ok(renders >= 1);
});

test("escape aborts the active run and flushes queued messages before double-escape stop", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "thinking",
    pendingMessages: ["queued request"],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const events: string[] = [];
  const tui = {
    requestRender: () => {
      events.push("render");
    },
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: (sessionId: string) => {
      events.push(`abort:${sessionId}`);
      tab.status = "idle";
      return true;
    },
    flushPendingMessage: async (sessionId: string) => {
      events.push(`flush:${sessionId}`);
      tab.pendingMessages = [];
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((event) => event !== "render"),
    ["abort:s1", "flush:s1"],
  );
  assert.deepEqual(tab.pendingMessages, []);
  assert.equal(tab.pendingEscapeAction, undefined);
});

test("escape flushes runtime queued messages even before tab queue state catches up", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const events: string[] = [];
  const tui = {
    requestRender: () => {
      events.push("render");
    },
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({
      queuedPromptCount: 1,
      agent: { state: { isStreaming: true } },
      agentSession: { getSteeringMessages: () => ["queued request"] },
    }),
    abortTab: (sessionId: string) => {
      events.push(`abort:${sessionId}`);
      return true;
    },
    flushPendingMessage: async (sessionId: string, count?: number) => {
      events.push(`flush:${sessionId}:${count ?? "all"}`);
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    events.filter((event) => event !== "render"),
    ["abort:s1", "flush:s1:1"],
  );
  assert.equal(tab.pendingEscapeAction, undefined);
});

test("escape flush queued message errors are shown in an overlay", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued request"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(80).join("\n") ?? String(component)),
      );
      return {} as never;
    },
    hasOverlay: () => false,
  };
  const runtime = {
    flushPendingMessage: async () => {
      throw new Error("flush failed");
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(overlays.at(-1) ?? "", /flush failed/);
});
