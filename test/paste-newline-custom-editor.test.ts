import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab, handleMixCodeKeyInput, type MixCodeState } from "../src/index.js";
import type { MixCodeEditorActions } from "../src/ui/app-types.js";

// Regression guard for the paste-newline heuristic swallowing Enter while an
// extension custom component owns the editor slot.
//
// The heuristic (handlePasteNewline) exists to stop a paste-without-bracketed-
// paste from submitting the DEFAULT editor line by line. When an extension
// `ctx.ui.custom(...)` component replaces the editor, Enter is that component's
// confirmation key and never submits the default editor — so the heuristic must
// not intercept it. Before the fix, rapid input (3+ printable/CR events within
// the 5ms window, which any scripted/test input produces) converted Enter into
// an inserted "\n", the component's done() never fired, and awaiting the
// extension command hung forever (the runtime-ui-12 infinite hang).

function silentTui() {
  return {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
}

function makeState() {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  return state;
}

function makeEditorActions(overrides: Partial<MixCodeEditorActions>): {
  actions: MixCodeEditorActions;
  inserted: string[];
} {
  const inserted: string[] = [];
  const actions: MixCodeEditorActions = {
    getText: () => "",
    setText: () => undefined,
    insertTextAtCursor: (text) => {
      inserted.push(text);
    },
    ...overrides,
  };
  return { actions, inserted };
}

function feedRapidInput(state: MixCodeState, actions: MixCodeEditorActions): void {
  // Two printable keys within the 5ms paste window prime the detector so the
  // following Enter is classified as part of a paste burst.
  handleMixCodeKeyInput(state, "x", silentTui(), undefined, undefined, undefined, undefined, actions);
  handleMixCodeKeyInput(state, "y", silentTui(), undefined, undefined, undefined, undefined, actions);
}

test("paste-newline heuristic keeps intercepting Enter on the default editor", () => {
  const state = makeState();
  const { actions, inserted } = makeEditorActions({});
  feedRapidInput(state, actions);
  const result = handleMixCodeKeyInput(
    state,
    "\r",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(result, { consume: true }, "rapid Enter is consumed as paste newline");
  assert.deepEqual(inserted, ["\n"], "Enter is converted into an inserted newline");
});

test("paste-newline heuristic does not swallow Enter while a pending extension interaction owns input", () => {
  const state = makeState();
  state.tabs[0]!.extensionUi.waitingForInputs.push({
    id: "extension-custom-1",
    kind: "custom",
  });
  const { actions, inserted } = makeEditorActions({});
  feedRapidInput(state, actions);
  const result = handleMixCodeKeyInput(
    state,
    "\r",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.equal(result, undefined, "Enter must pass through to the custom component");
  assert.deepEqual(inserted, [], "no newline is injected into the replaced editor");
});

// Regression: global Ctrl+C clears the default editor, but when a pending
// extension interaction owns the slot (e.g. /btw), Ctrl+C is that component's
// exit/cancel key and must fall through instead of being consumed as clear-input.
test("Ctrl+C does not clear/consume while a pending extension interaction owns input", () => {
  const state = makeState();
  state.tabs[0]!.extensionUi.waitingForInputs.push({
    id: "extension-custom-1",
    kind: "custom",
  });
  let cleared = false;
  const { actions } = makeEditorActions({
    getText: () => "draft",
    setText: () => {
      cleared = true;
    },
  });
  const result = handleMixCodeKeyInput(
    state,
    "\x03",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.equal(result, undefined, "Ctrl+C must pass through to the custom component");
  assert.equal(cleared, false, "default editor must not be cleared");
});

test("Ctrl+C still clears draft with a permanent editor replacement", () => {
  const state = makeState();
  let text = "draft";
  const { actions } = makeEditorActions({
    getText: () => text,
    setText: (next) => {
      text = next;
    },
  });
  const result = handleMixCodeKeyInput(
    state,
    "\x03",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(text, "");
});

// Regression: global Ctrl+R pre-fills /rename, but when a pending extension
// interaction owns the slot (e.g. /btw bring-to-main), Ctrl+R must fall through.
test("Ctrl+R does not rename/consume while a pending extension interaction owns input", () => {
  const state = makeState();
  state.tabs[0]!.extensionUi.waitingForInputs.push({
    id: "extension-custom-1",
    kind: "custom",
  });
  let renamedText: string | undefined;
  const { actions } = makeEditorActions({
    setText: (text) => {
      renamedText = text;
    },
  });
  const result = handleMixCodeKeyInput(
    state,
    "\x12",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.equal(result, undefined, "Ctrl+R must pass through to the custom component");
  assert.equal(renamedText, undefined, "rename text must not be injected");
});

test("Ctrl+R still prefills /rename with a permanent editor replacement", () => {
  const state = makeState();
  let text = "draft";
  const { actions } = makeEditorActions({
    getText: () => text,
    setText: (next) => {
      text = next;
    },
  });
  const result = handleMixCodeKeyInput(
    state,
    "\x12",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(text, `/rename ${state.tabs[0]!.title}`);
});

// Regression: global Ctrl+J / Shift+Enter insert newline into MixCode's editor
// actions. Temporary takeovers (e.g. /btw) own those keys; permanent skins do not.
test("Ctrl+J and Shift+Enter do not insert/consume while a pending extension interaction owns input", () => {
  const state = makeState();
  state.tabs[0]!.extensionUi.waitingForInputs.push({
    id: "extension-custom-1",
    kind: "custom",
  });
  const { actions, inserted } = makeEditorActions({});
  // "\n" is the legacy Ctrl+J (and Ghostty Shift+Enter) byte; CSI u is Kitty Shift+Enter.
  for (const data of ["\n", "\x1b[13;2u"] as const) {
    const result = handleMixCodeKeyInput(
      state,
      data,
      silentTui(),
      undefined,
      undefined,
      undefined,
      undefined,
      actions,
    );
    assert.equal(result, undefined, `${JSON.stringify(data)} must pass through to the custom component`);
  }
  assert.deepEqual(inserted, [], "no newline is injected into the replaced editor");
});

// Regression: global PgUp/PgDn scroll the main chat, but when an extension
// custom component owns the editor slot (e.g. /btw side-thread history),
// those keys must fall through instead of being consumed as chat scroll.
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

test("PgUp/PgDn still scroll the main chat on the default editor", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  tab.chatScrollOffset = 0;
  const { actions } = makeEditorActions({});
  const up = handleMixCodeKeyInput(
    state,
    PAGE_UP,
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(up, { consume: true }, "PgUp scrolls main chat");
  assert.equal(tab.chatScrollOffset, 10);
  const down = handleMixCodeKeyInput(
    state,
    PAGE_DOWN,
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(down, { consume: true }, "PgDn scrolls main chat");
  assert.equal(tab.chatScrollOffset, 0);
});

test("PgUp/PgDn do not scroll/consume while a pending extension interaction owns input", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  tab.chatScrollOffset = 0;
  tab.extensionUi.waitingForInputs.push({ id: "extension-custom-1", kind: "custom" });
  const { actions } = makeEditorActions({});
  for (const key of [PAGE_UP, PAGE_DOWN]) {
    const result = handleMixCodeKeyInput(
      state,
      key,
      silentTui(),
      undefined,
      undefined,
      undefined,
      undefined,
      actions,
    );
    assert.equal(result, undefined, `${JSON.stringify(key)} must pass through to the custom component`);
  }
  assert.equal(tab.chatScrollOffset, 0, "main chat must not scroll under a pending interaction");
});

test("PgUp/PgDn still scroll the main chat with a permanent editor replacement", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  tab.chatScrollOffset = 0;
  const { actions } = makeEditorActions({});
  const up = handleMixCodeKeyInput(
    state,
    PAGE_UP,
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(up, { consume: true });
  assert.equal(tab.chatScrollOffset, 10);
  const down = handleMixCodeKeyInput(
    state,
    PAGE_DOWN,
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(down, { consume: true });
  assert.equal(tab.chatScrollOffset, 0);
});

test("PgUp/PgDn do not scroll/consume while a pending extension interaction is open", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  tab.chatScrollOffset = 0;
  tab.extensionUi.waitingForInputs.push({ id: "extension-custom-1", kind: "custom" });
  const { actions } = makeEditorActions({});
  const result = handleMixCodeKeyInput(
    state,
    PAGE_UP,
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.equal(result, undefined, "PgUp must not steal focus from a pending extension interaction");
  assert.equal(tab.chatScrollOffset, 0);
});

test("Ctrl+U is not consumed while a pending extension interaction owns input", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  tab.pendingMessages.push("queued prompt");
  tab.extensionUi.waitingForInputs.push({ id: "extension-custom-1", kind: "custom" });
  let text = "draft";
  let popped = 0;
  const { actions } = makeEditorActions({
    getText: () => text,
    setText: (next) => {
      text = next;
    },
  });
  const result = handleMixCodeKeyInput(
    state,
    "\x15",
    silentTui(),
    undefined,
    {
      popPendingMessage: () => {
        popped++;
        return "runtime queued";
      },
    },
    undefined,
    undefined,
    actions,
  );

  assert.equal(result, undefined, "Ctrl+U must reach the extension component");
  assert.equal(popped, 0, "extension input must not dequeue the main editor queue");
  assert.equal(text, "draft");
  assert.equal(tab.vimEnterArmedAt, undefined);
});

test("Up/Down do not browse prompt history while a pending extension interaction owns input", () => {
  const state = makeState();
  state.tabs[0]!.extensionUi.waitingForInputs.push({
    id: "extension-custom-1",
    kind: "custom",
  });
  let historyBrowsed = 0;
  const { actions } = makeEditorActions({
    browsePromptHistory: () => {
      historyBrowsed++;
      return true;
    },
  });
  for (const key of ["\x1b[A", "\x1b[B"]) {
    const result = handleMixCodeKeyInput(
      state,
      key,
      silentTui(),
      undefined,
      undefined,
      undefined,
      undefined,
      actions,
    );
    assert.equal(result, undefined, `${JSON.stringify(key)} must pass through to the custom component`);
  }
  assert.equal(historyBrowsed, 0, "pending custom UI must not enter prompt history");
});

test("Up still browses prompt history with a permanent editor replacement", () => {
  const state = makeState();
  let historyBrowsed = 0;
  const { actions } = makeEditorActions({
    browsePromptHistory: () => {
      historyBrowsed++;
      return true;
    },
  });
  const result = handleMixCodeKeyInput(
    state,
    "\x1b[A",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(historyBrowsed, 1);
});

test("vim Up/Down do not scroll chat while a pending extension interaction owns input", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  tab.vimMode = true;
  tab.chatScrollOffset = 0;
  tab.extensionUi.waitingForInputs.push({
    id: "extension-custom-1",
    kind: "custom",
  });
  const { actions } = makeEditorActions({});
  for (const key of ["\x1b[A", "\x1b[B"]) {
    const result = handleMixCodeKeyInput(
      state,
      key,
      silentTui(),
      undefined,
      undefined,
      undefined,
      undefined,
      actions,
    );
    assert.equal(result, undefined, `${JSON.stringify(key)} must pass through to the custom component`);
  }
  assert.equal(tab.chatScrollOffset, 0, "vim must not scroll chat under a pending interaction");
});

test("Tab keeps switching MixCode tabs while an extension interaction is pending", () => {
  const state = makeState();
  const first = state.tabs[0]!;
  first.extensionUi.waitingForInputs.push({ id: "extension-custom-1", kind: "custom" });
  state.tabs.push(createTab(2, "s2", "/repo"));
  const { actions } = makeEditorActions({});

  const result = handleMixCodeKeyInput(
    state,
    "\t",
    silentTui(),
    undefined,
    undefined,
    undefined,
    undefined,
    actions,
  );

  assert.deepEqual(result, { consume: true });
  assert.equal(state.activeTabId, "s2");
});
