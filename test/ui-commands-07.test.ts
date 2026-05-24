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
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
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

test("double escape stops an active agent run", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  let aborts = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: (sessionId: string) => {
      assert.equal(sessionId, "s1");
      aborts++;
      return true;
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeAction, "abort-agent");
  assert.match(renderInputMeta(tab, 80).join("\n"), /Esc again: stop/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(aborts, 1);
  assert.equal(renders, 2);
});

test("double escape stop takes priority over extension terminal input handlers", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  let dispatched = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    dispatchTerminalInput: () => {
      dispatched++;
      return { consume: true };
    },
    abortTab: (sessionId: string) => {
      assert.equal(sessionId, "s1");
      aborts++;
      return true;
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeAction, "abort-agent");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(dispatched, 0);
  assert.equal(aborts, 1);
});

test("expired double escape arm resets before stopping an active run", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  tab.pendingEscapeArmedAt = Date.now() - PENDING_ESCAPE_CONFIRM_WINDOW_MS - 1;

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeAction, "abort-agent");
  assert.equal(aborts, 0);
});

test("single escape abort prompt is cleared by later non-abort actions", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => true,
  };
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeAction, "abort-agent");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x0f", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeAction, undefined);
});

test("command palette disabled entries show an explicit unavailable reason", () => {
  const state = createInitialState("/repo");
  const overlays: string[] = [];
  let overlayOpen = false;
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
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "s", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "a", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "v", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "e", tui), { consume: true });
  assert.match(
    overlays.at(-1) ?? "",
    /> Save Workspace\s+\/save-workspace\s+disabled: No open Agent Tabs/,
  );
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: () => {
        throw new Error("disabled command should not execute");
      },
    }),
    { consume: true },
  );
  assert.equal(state.commandPaletteOpen, false);
  assert.match(overlays.at(-1) ?? "", /No open Agent Tabs to save as a workspace/);
});

test("ctrl-p does not open command palette while another input mode owns focus", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let overlays = 0;
  let overlayOpen = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      overlays++;
      overlayOpen = true;
      return {} as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };

  assert.equal(
    handleMixCodeKeyInput(state, "\x10", tui, undefined, undefined, undefined, () => true),
    undefined,
  );
  assert.equal(state.commandPaletteOpen, false);
  assert.equal(overlays, 0);

  state.picker = {
    kind: "theme",
    title: "Choose Theme",
    query: "",
    selectedIndex: 0,
    items: [{ id: "terminal", label: "Terminal", description: "" }],
  };
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  state.picker = undefined;

  state.tabJumpOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  state.tabJumpOpen = false;

  state.exportChooserOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  state.exportChooserOpen = false;

  tab.previewOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  tab.previewOpen = false;

  tab.pendingDialogs.push(
    createDialogRequest("r1", "s1", [
      { header: "Question", question: "Pick?", options: [], multiple: false, custom: false },
    ]),
  );
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  tab.pendingDialogs = [];

  overlayOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  overlayOpen = false;

  state.activeTabId = "missing";
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  assert.equal(overlays, 0);
});

test("global key input cycles tabs unless editor autocomplete is open", () => {
  const state = createInitialState("/repo");
  const s2 = createTab(2, "s2", "/repo", { unreadDone: true });
  state.tabs.push(createTab(1, "s1", "/repo"), s2);
  state.activeTabId = "s1";
  let renders = 0;
  const renderForces: Array<boolean | undefined> = [];
  const tui = {
    requestRender: (force?: boolean) => {
      renders++;
      renderForces.push(force);
    },
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(s2.unreadDone, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
  state.activeTabId = "config";
  s2.unreadDone = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(s2.unreadDone, false);

  state.activeTabId = "s1";
  assert.equal(
    handleMixCodeKeyInput(state, "\t", tui, undefined, undefined, undefined, () => true),
    undefined,
  );
  assert.equal(state.activeTabId, "s1");
  assert.equal(renders, 3);
  assert.deepEqual(renderForces, [undefined, undefined, undefined]);
});

test("vim mode still allows tab and shift-tab to switch agent tabs", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { vimMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  let renders = 0;
  let text = "";
  const tui = {
    requestRender: () => {
      renders++;
    },
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    insertTextAtCursor: (next: string) => {
      text += next;
    },
  };

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\t", tui, undefined, undefined, undefined, () => false, editorActions),
    { consume: true },
  );
  assert.equal(state.activeTabId, "s2");
  assert.equal(first.vimMode, false);
  assert.equal(second.vimMode, true);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "x", tui, undefined, undefined, undefined, () => false, editorActions),
    { consume: true },
  );
  assert.equal(text, "");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
  assert.equal(first.vimMode, true);
  assert.equal(second.vimMode, false);
  assert.equal(renders, 3);
});

test("global key input clears editor and prepares rename command", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Worker" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "draft prompt";
  const history: string[] = [];
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
    addToHistory: (entry: string) => history.push(entry),
  };

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\u0003",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(text, "");
  assert.deepEqual(history, ["draft prompt"]);
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x12",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(text, "/rename Worker");
  state.activeTabId = "config";
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "\x12",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    undefined,
  );
  assert.equal(text, "/rename Worker");
  assert.equal(renders, 2);
});

test("vim mode consumes editor input, scrolls chat, and exits with q", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let renders = 0;
  let text = "";
  const prompts: string[] = [];
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const runtime = {
    prompt: async (_sessionId: string, prompt: string) => {
      prompts.push(prompt);
    },
  };
  const editorActions = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
    insertTextAtCursor: (next: string) => {
      text += next;
    },
    submitCurrentText: () => {
      prompts.push(text);
      text = "";
    },
  };

  await handleSubmittedInput(state, runtime, "/vim", tui);
  assert.equal(tab.vimMode, true);

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "j",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollOffset, 0);
  assert.equal(text, "");

  assert.deepEqual(handleMixCodeKeyInput(state, "k", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 3);
  assert.deepEqual(handleMixCodeKeyInput(state, "g", tui), { consume: true });
  assert.equal(tab.vimPendingHome, true);
  assert.deepEqual(handleMixCodeKeyInput(state, "g", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 1_000_000);
  assert.deepEqual(handleMixCodeKeyInput(state, "G", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  assert.deepEqual(handleMixCodeKeyInput(state, "x", tui), { consume: true });
  assert.equal(text, "");
  assert.deepEqual(prompts, []);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(tab.vimMode, true);
  assert.equal(tab.vimPendingEscapeAt, undefined);
  assert.deepEqual(handleMixCodeKeyInput(state, "q", tui), { consume: true });
  assert.equal(tab.vimMode, false);
  assert.equal(renders > 0, true);
});

test("global key input inserts editor newline with ctrl-j", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let renders = 0;
  let text = "ab";
  const inserted: string[] = [];
  const tui = {
    requestRender: () => renders++,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\n", tui, undefined, undefined, undefined, () => false, {
      getText: () => text,
      setText: (next: string) => {
        text = next;
      },
      insertTextAtCursor: (next: string) => {
        inserted.push(next);
      },
    }),
    { consume: true },
  );
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b[13;2u", tui, undefined, undefined, undefined, () => false, {
      getText: () => text,
      setText: (next: string) => {
        text = next;
      },
      insertTextAtCursor: (next: string) => {
        inserted.push(next);
      },
    }),
    { consume: true },
  );
  assert.deepEqual(inserted, ["\n", "\n"]);
  assert.equal(text, "ab");

  assert.deepEqual(
    handleMixCodeKeyInput(state, "\n", tui, undefined, undefined, undefined, () => false, {
      getText: () => text,
      setText: (next: string) => {
        text = next;
      },
    }),
    { consume: true },
  );
  assert.equal(text, "ab\n");
  assert.equal(renders, 3);
});
