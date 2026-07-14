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
  stripAnsi,
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

test("global key input submits batched inline text ending with enter", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let text = "";
  let renders = 0;
  const submitted: string[] = [];
  const inserted: string[] = [];
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "hello from tmux\r",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      {
        getText: () => text,
        setText: (next: string) => {
          text = next;
        },
        insertTextAtCursor: (next: string) => {
          inserted.push(next);
          text += next;
        },
        submitCurrentText: () => {
          submitted.push(text.trim());
          text = "";
        },
      },
    ),
    { consume: true },
  );

  assert.deepEqual(inserted, ["hello from tmux"]);
  assert.deepEqual(submitted, ["hello from tmux"]);
  assert.equal(text, "");
  assert.equal(renders, 1);
  const editor = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    insertTextAtCursor: (next: string) => {
      inserted.push(next);
      text += next;
    },
    submitCurrentText: () => {
      submitted.push(text.trim());
      text = "";
    },
  };
  state.tabJumpOpen = true;
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "export blocked\r",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editor,
    ),
    undefined,
  );
  state.tabJumpOpen = false;
  state.picker = { kind: "theme", title: "Choose Theme", query: "", selectedIndex: 0, items: [] };
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "picker blocked\r",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editor,
    ),
    undefined,
  );
  state.picker = undefined;
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "bad\x01\r",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editor,
    ),
    undefined,
  );
  assert.equal(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, () => false, editor),
    undefined,
  );
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "bad\nbody\r",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editor,
    ),
    undefined,
  );
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "plain",
      tui,
      undefined,
      undefined,
      undefined,
      () => false,
      editor,
    ),
    undefined,
  );
});

test("Home Ctrl+U does not dequeue the selected agent queue", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["agent-queued"] });
  state.tabs.push(tab);
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 0;
  let text = "home-draft";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
  };
  let popped = 0;
  const runtime = {
    popPendingMessage: () => {
      popped++;
      return "should-not-pop";
    },
  };

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x15",
      tui,
      undefined,
      runtime,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(popped, 0);
  assert.equal(text, "home-draft");
  assert.deepEqual(tab.pendingMessages, ["agent-queued"]);
});

test("global key input pops queued messages back into editor", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["first", "second"] });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "";
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
  };

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1bp",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(text, "second");
  assert.deepEqual(tab.pendingMessages, ["first"]);
  const runtime = {
    popPendingMessage: (sessionId: string) => (sessionId === "s1" ? "runtime queued" : undefined),
  };
  // In-progress draft must be re-queued, not discarded, when popping.
  text = "keep me draft";
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x15",
      tui,
      undefined,
      runtime,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(text, "runtime queued");
  assert.deepEqual(tab.pendingMessages, ["keep me draft", "first"]);
  tab.pendingMessages.length = 0;
  // Empty queue must still consume Ctrl+U so pi-tui's deleteToLineStart cannot wipe the draft.
  text = "keep draft";
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x15",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(text, "keep draft");
  assert.equal(renders, 2);
});

test("global key input lets editor handle Home and End while input is focused", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { chatScrollOffset: 7 });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => "hello",
    setText: () => undefined,
  };

  assert.equal(
    handleMixCodeKeyInput(
      state,
      "\x1b[H",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    undefined,
  );
  assert.equal(tab.chatScrollOffset, 7);
  assert.equal(renders, 0);

  assert.equal(
    handleMixCodeKeyInput(
      state,
      "\x1b[F",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    undefined,
  );
  assert.equal(tab.chatScrollOffset, 7);
  assert.equal(renders, 0);
});

test("tab jump overlay filters and activates selected tab from keyboard", () => {
  const state = createInitialState("/repo");
  const beta = createTab(2, "s2", "/repo", { title: "Beta", unreadDone: true });
  state.tabs.push(createTab(1, "s1", "/repo", { alias: "alpha" }), beta);
  state.activeTabId = "s1";
  const overlays: string[] = [];
  let overlayOpen = false;
  let renders = 0;
  const renderForces: Array<boolean | undefined> = [];
  const tui = {
    requestRender: (force?: boolean) => {
      renders++;
      renderForces.push(force);
    },
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
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.equal(state.tabJumpOpen, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.tabJumpIndex, 2);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.tabJumpIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "B", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "e", tui), { consume: true });
  assert.equal(state.tabJumpQuery, "Be");
  assert.match(stripAnsi(overlays.at(-1) ?? ""), /Beta/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\u007f", tui), { consume: true });
  assert.equal(state.tabJumpQuery, "B");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui), { consume: true });
  assert.equal(state.tabJumpIndex, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(beta.unreadDone, false);
  assert.equal(state.tabJumpOpen, false);
  assert.equal(overlayOpen, false);
  assert.equal(renderForces.at(-1), undefined);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(state.tabJumpIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.tabJumpOpen, false);
  assert.equal(renders, 2);
});

test("vim mode allows ctrl-t tab jump and transfers vim mode to selected tab", () => {
  const state = createInitialState("/repo");
  const alpha = createTab(1, "s1", "/repo", {
    title: "Alpha",
    vimMode: true,
    vimPendingEscapeAt: Date.now(),
    vimPendingHome: true,
  });
  const beta = createTab(2, "s2", "/repo", {
    title: "Beta",
    vimPendingEscapeAt: Date.now(),
    vimPendingHome: true,
  });
  state.tabs.push(alpha, beta);
  state.activeTabId = "s1";

  const overlays: string[] = [];
  let overlayOpen = false;
  let renders = 0;
  const tui = {
    requestRender: () => {
      renders++;
    },
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
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.equal(state.tabJumpOpen, true);
  assert.equal(alpha.vimMode, true);
  assert.match(overlays.at(-1) ?? "", /Tab Jump/);

  assert.deepEqual(handleMixCodeKeyInput(state, "B", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(alpha.vimMode, false);
  assert.equal(alpha.vimPendingEscapeAt, undefined);
  assert.equal(alpha.vimPendingHome, false);
  assert.equal(beta.vimMode, true);
  assert.equal(beta.vimPendingEscapeAt, undefined);
  assert.equal(beta.vimPendingHome, false);
  assert.equal(state.tabJumpOpen, false);
  assert.equal(overlayOpen, false);
  assert.equal(renders, 1);
});
