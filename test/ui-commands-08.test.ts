import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  renderInputMeta,
} from "../src/index.js";

test("global key input submits batched inline text ending with enter", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let text = "";
  const submitted: string[] = [];
  const inserted: string[] = [];
  const tui = {
    requestRender: () => undefined,
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
  // Modal tab-jump / picker swallow unbound keys so they cannot submit.
  assert.deepEqual(
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
    { consume: true },
  );
  assert.deepEqual(inserted, ["hello from tmux"]);
  assert.deepEqual(submitted, ["hello from tmux"]);
  assert.equal(text, "");
  state.tabJumpOpen = false;
  state.picker = { kind: "models", title: "Choose Model", query: "", selectedIndex: 0, items: [] };
  assert.deepEqual(
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
    { consume: true },
  );
  assert.deepEqual(inserted, ["hello from tmux"]);
  assert.deepEqual(submitted, ["hello from tmux"]);
  assert.equal(text, "");
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
  state.activeTabId = "home";
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
});

test("empty-queue Ctrl+U arms vim via toast, not input meta", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => "",
    setText: () => undefined,
  };
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
  assert.ok(typeof tab.vimEnterArmedAt === "number");
  assert.equal(tab.toast?.type, "info");
  assert.match(tab.toast?.message ?? "", /Again: u or Ctrl\+U → vim/);
  const plain = stripAnsi(renderInputMeta(tab, 120).join("\n"));
  assert.doesNotMatch(plain, /u\/Ctrl\+U/);
});

test("empty-queue Ctrl+U then u enters vim mode", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "draft stays";
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
  assert.equal(tab.vimMode, false);
  assert.ok(typeof tab.vimEnterArmedAt === "number");

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "u",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(tab.vimMode, true);
  assert.equal(tab.vimEnterArmedAt, undefined);
  assert.equal(text, "draft stays");

  assert.deepEqual(handleMixCodeKeyInput(state, "q", tui), { consume: true });
  assert.equal(tab.vimMode, false);
});

test("empty-queue Ctrl+U twice enters vim mode", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => "",
    setText: () => undefined,
  };

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
  assert.ok(typeof tab.vimEnterArmedAt === "number");

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
  assert.equal(tab.vimMode, true);
  assert.equal(tab.vimEnterArmedAt, undefined);
});

test("queued Ctrl+U still dequeues and does not arm vim enter", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { pendingMessages: ["queued prompt"] });
  state.tabs.push(tab);
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
  };

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
  assert.equal(text, "queued prompt");
  assert.equal(tab.vimEnterArmedAt, undefined);
  assert.equal(tab.vimMode, false);

  assert.equal(
    handleMixCodeKeyInput(
      state,
      "u",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    undefined,
  );
  assert.equal(tab.vimMode, false);
});

test("vim enter arm cancels on other key and expires after 1s", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
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
  };

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
  assert.ok(typeof tab.vimEnterArmedAt === "number");

  // Non-confirm key clears the arm and continues normal dispatch.
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "x",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    undefined,
  );
  assert.equal(tab.vimEnterArmedAt, undefined);
  assert.equal(tab.vimMode, false);

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
  tab.vimEnterArmedAt = Date.now() - 1001;
  assert.equal(
    handleMixCodeKeyInput(
      state,
      "u",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    undefined,
  );
  assert.equal(tab.vimMode, false);
  assert.equal(tab.vimEnterArmedAt, undefined);
});

test("vim enter accepts Kitty CSI-u for confirming u and ignores key release", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "keep";
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
  assert.ok(typeof tab.vimEnterArmedAt === "number");

  // Kitty flag-2 Ctrl+U release must not clear the arm.
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[117;5:3u",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.ok(typeof tab.vimEnterArmedAt === "number");

  // Kitty CSI-u for plain `u` (not the raw byte "u").
  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[117u",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(tab.vimMode, true);
  assert.equal(text, "keep");
});

test("empty-queue Ctrl+U still arms vim with a permanent editor replacement", () => {
  // Visual editor skins (setEditorComponent) must not swallow Ctrl+U → u enter-vim.
  // Only pending extension interactions own that key.
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "draft stays";
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
    hasEditorReplacement: () => true,
  };

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
  assert.ok(typeof tab.vimEnterArmedAt === "number");

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "u",
      tui,
      undefined,
      undefined,
      undefined,
      undefined,
      editorActions,
    ),
    { consume: true },
  );
  assert.equal(tab.vimMode, true);
  assert.equal(text, "draft stays");
});

test("Home empty-queue Ctrl+U does not arm vim enter", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => undefined,
    hasOverlay: () => false,
  };
  const editorActions = {
    getText: () => "home",
    setText: () => undefined,
  };

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
  assert.equal(tab.vimEnterArmedAt, undefined);
  assert.equal(tab.vimMode, false);
});

test("global key input lets editor handle Home and End while input is focused", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { chatScrollOffset: 7 });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = {
    requestRender: () => undefined,
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
});

test("tab jump overlay filters and activates selected tab from keyboard", () => {
  const state = createInitialState("/repo");
  const beta = createTab(2, "s2", "/repo", { title: "Beta", unreadDone: true });
  state.tabs.push(createTab(1, "s1", "/repo", { alias: "alpha" }), beta);
  state.activeTabId = "s1";
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

  assert.deepEqual(handleMixCodeKeyInput(state, "\x14", tui), { consume: true });
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(state.tabJumpIndex, 1);
  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b", tui), { consume: true });
  assert.equal(state.tabJumpOpen, false);
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
  const tui = {
    requestRender: () => undefined,
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      overlayOpen = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(120).join("\n") ?? String(component)),
      );
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
});
