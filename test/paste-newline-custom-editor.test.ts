import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab, handleMixCodeKeyInput } from "../src/index.js";
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

function feedRapidInput(state: ReturnType<typeof makeState>, actions: MixCodeEditorActions): void {
  // Two printable keys within the 5ms paste window prime the detector so the
  // following Enter is classified as part of a paste burst.
  handleMixCodeKeyInput(state, "x", silentTui(), undefined, undefined, undefined, undefined, actions);
  handleMixCodeKeyInput(state, "y", silentTui(), undefined, undefined, undefined, undefined, actions);
}

test("paste-newline heuristic keeps intercepting Enter on the default editor", (t) => {
  t.mock.method(Date, "now", () => 1_000_000);
  const state = makeState();
  const { actions, inserted } = makeEditorActions({ hasEditorReplacement: () => false });
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

test("paste-newline heuristic does not swallow Enter while an extension owns the editor slot", (t) => {
  t.mock.method(Date, "now", () => 2_000_000);
  const state = makeState();
  const { actions, inserted } = makeEditorActions({ hasEditorReplacement: () => true });
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

// Regression: global Ctrl+C clears the default editor, but when an extension
// custom component owns the editor slot (e.g. /btw), Ctrl+C is that component's
// exit/cancel key and must fall through instead of being consumed as clear-input.
test("Ctrl+C does not clear/consume while an extension owns the editor slot", () => {
  const state = makeState();
  let cleared = false;
  const { actions } = makeEditorActions({
    hasEditorReplacement: () => true,
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
