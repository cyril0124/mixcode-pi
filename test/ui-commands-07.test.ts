import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  renderInputMeta,
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
} from "./helpers/mixcode.js";

test("double escape stops an active agent run", () => {
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
    abortTab: (sessionId: string) => {
      assert.equal(sessionId, "s1");
      aborts++;
      return true;
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(typeof tab.pendingEscapeArmedAt, "number");
  assert.equal(tab.toast?.type, "info");
  assert.match(tab.toast?.message ?? "", /Esc again: stop/);
  assert.doesNotMatch(renderInputMeta(tab, 80).join("\n"), /Esc again: stop/);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeArmedAt, undefined);
  assert.equal(aborts, 1);
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
  assert.equal(typeof tab.pendingEscapeArmedAt, "number");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(dispatched, 0);
  assert.equal(aborts, 1);
});

test("extension widget input handlers are suppressed while a modal dialog is active", () => {
  // pi-subagents registers a belowEditor fleet list whose input listener
  // navigates on Up/Down. A `/agents` select dialog replaces the editor without
  // a tui overlay (hasOverlay=false) but sets a pending interaction, so the
  // dialog — not the widget — must own the arrow keys.
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    extensionUi: {
      statuses: [],
      widgets: [{ key: "fleet", placement: "belowEditor", lines: ["fleet"] }],
      toolsExpanded: false,
      waitingForInputs: [{ id: "extension-select-1", kind: "custom" }],
      workingVisible: true,
    },
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let dispatched = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
  let hiddenOverlay = false;
  const runtime = {
    dispatchTerminalInput: () => {
      dispatched++;
      return { consume: true };
    },
    hasHiddenExtensionOverlay: () => hiddenOverlay,
  } as unknown as Parameters<typeof handleMixCodeKeyInput>[4];
  const editor = { getText: () => "", setText: () => undefined };

  handleMixCodeKeyInput(state, "\x1b[A", tui, undefined, runtime, undefined, () => false, editor);
  handleMixCodeKeyInput(state, "\x1b[B", tui, undefined, runtime, undefined, () => false, editor);
  assert.equal(dispatched, 0);

  // A hidden custom overlay must keep receiving its recovery shortcut.
  hiddenOverlay = true;
  handleMixCodeKeyInput(state, "\x1d", tui, undefined, runtime, undefined, () => false, editor);
  assert.equal(dispatched, 1);

  // Without a pending interaction the widget listener runs normally.
  hiddenOverlay = false;
  tab.extensionUi.waitingForInputs = [];
  handleMixCodeKeyInput(state, "\x1b[A", tui, undefined, runtime, undefined, () => false, editor);
  assert.equal(dispatched, 2);
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
  assert.equal(typeof tab.pendingEscapeArmedAt, "number");
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
  assert.equal(typeof tab.pendingEscapeArmedAt, "number");
  assert.deepEqual(handleMixCodeKeyInput(state, "\x0f", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(tab.pendingEscapeArmedAt, undefined);
});

test("command palette hides disabled entries and does not execute them", () => {
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
  assert.match(overlays.at(-1) ?? "", /No matching commands/);
  assert.doesNotMatch(overlays.at(-1) ?? "", /Save Workspace/);
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\r", tui, undefined, undefined, undefined, undefined, undefined, {
      executeCommand: () => {
        throw new Error("disabled command should not execute");
      },
    }),
    { consume: true },
  );
  assert.equal(state.commandPaletteOpen, false);
});

test("command palette swallows unbound keys like Ctrl+T and PageUp", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { chatScrollOffset: 0 });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  state.commandPaletteOpen = true;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({} as never),
    hideOverlay: () => undefined,
    hasOverlay: () => true,
  };

  // Ctrl+T would open tab jump if the palette leaked the key.
  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, true);
  assert.equal(state.tabJumpOpen, false);

  // PageUp would scroll chat if leaked.
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[5~", tui), { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
  assert.equal(state.commandPaletteOpen, true);
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
    kind: "models",
    title: "Choose Model",
    query: "",
    selectedIndex: 0,
    items: [{ id: "terminal", label: "Terminal", description: "" }],
  };
  // Modal pickers swallow unbound keys (including Ctrl+P) instead of nesting the palette.
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, false);
  state.picker = undefined;

  state.tabJumpOpen = true;
  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, false);
  state.tabJumpOpen = false;

  tab.extensionUi.waitingForInputs.push({ id: "r1", kind: "custom" });
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  tab.extensionUi.waitingForInputs = [];

  overlayOpen = true;
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  overlayOpen = false;

  state.activeTabId = "missing";
  assert.equal(handleMixCodeKeyInput(state, "\x10", tui), undefined);
  assert.equal(state.commandPaletteOpen, false);
  assert.equal(overlays, 0);
});

test("ctrl-p on Home opens command palette even if selected agent is waiting for input", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "Not Ready" });
  tab.extensionUi.waitingForInputs.push({ id: "r1", kind: "custom" });
  state.tabs.push(tab);
  state.homeSelectedTabIndex = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({} as never),
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x10", tui), { consume: true });
  assert.equal(state.commandPaletteOpen, true);
});

test("global key input cycles tabs unless editor autocomplete is open", () => {
  const state = createInitialState("/repo");
  const s2 = createTab(2, "s2", "/repo", { unreadDone: true });
  state.tabs.push(createTab(1, "s1", "/repo"), s2);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\t", tui), { consume: true });
  assert.equal(state.activeTabId, "s2");
  assert.equal(s2.unreadDone, false);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[Z", tui), { consume: true });
  assert.equal(state.activeTabId, "s1");
  state.activeTabId = "home";
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
});

test("global key input ignores Kitty key-release events", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"), createTab(2, "s2", "/repo"));
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  let terminalInputs = 0;
  const runtime = {
    dispatchTerminalInput: (_sessionId: string, data: string) => {
      assert.equal(data, "\x1b[9;1:3u");
      terminalInputs++;
      return undefined;
    },
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[9;1:3u", tui, undefined, runtime), {
    consume: true,
  });
  assert.equal(terminalInputs, 1);
  assert.equal(state.activeTabId, "s1");
});

test("tab jump to Home preserves vim mode on the agent (like Left)", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true }); // Ctrl+T
  assert.equal(state.tabJumpOpen, true);
  // Home is index 0; openTabJump selects current agent (1) — move to Home.
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true }); // Up
  assert.deepEqual(handleMixCodeKeyInput(state, "\r", tui), { consume: true });
  assert.equal(state.activeTabId, "home");
  assert.equal(tab.vimMode, true);

  // Right attach transfers vim back onto the agent surface.
  assert.deepEqual(
    handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, undefined, undefined, () => false, {
      getText: () => "",
      setText: () => undefined,
    }),
    { consume: true },
  );
  assert.equal(state.activeTabId, "s1");
  assert.equal(tab.vimMode, true);
});

test("vim mode still allows tab and shift-tab to switch agent tabs", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { vimMode: true });
  const second = createTab(2, "s2", "/repo");
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  let text = "";
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
});

test("global key input clears editor and prepares rename command", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "Worker" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "draft prompt";
  const history: string[] = [];
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
  state.activeTabId = "home";
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
});

test("vim mode consumes editor input, scrolls chat, and exits with q", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "";
  const prompts: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const runtime = {
    prompt: async (_sessionId: string, prompt: string) => {
      prompts.push(prompt);
    },
  };
  let historyBrowsed = false;
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
    browsePromptHistory: () => {
      historyBrowsed = true;
      return true;
    },
  };

  await handleSubmittedInput(state, runtime, "/vim", tui);
  assert.equal(tab.vimMode, true);

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[A",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollOffset, 3);
  assert.equal(historyBrowsed, false);

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
});

test("global key input inserts editor newline with ctrl-j", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let text = "ab";
  const inserted: string[] = [];
  const tui = {
    requestRender: () => undefined,
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
});
