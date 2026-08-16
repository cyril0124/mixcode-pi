import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { CompactPromptEditor, EditorSlot } from "../src/ui/app-editor.js";
import type { TUI as TuiType } from "@earendil-works/pi-tui";

function makeTui(): TuiType {
  return {
    requestRender: () => undefined,
    setFocus: () => undefined,
  } as unknown as TuiType;
}

test("leaving agent for Home clears editor and keeps agent draftInput", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";

  const tui = makeTui();
  const editor = new CompactPromptEditor(tui, {} as never, undefined, state);
  const slot = new EditorSlot(tui, editor, state);
  // Prime slot on the agent tab with a draft.
  slot.current.setText("AGENT-DRAFT");
  slot.current; // sync
  // Force draft save path via re-sync after text change onChange isn't wired;
  // set activeTabId tracking by reading current once, then mutate text + switch.
  (slot as unknown as { activeTabId: string }).activeTabId = "s1";
  editor.setText("AGENT-DRAFT");

  state.activeTabId = "home";
  slot.current; // syncActiveTab

  assert.equal(editor.getText(), "");
  assert.equal(tab.draftInput, "AGENT-DRAFT");
});

test("returning to agent restores draftInput without Home text", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { draftInput: "AGENT-DRAFT" });
  state.tabs.push(tab);
  state.activeTabId = "home";

  const tui = makeTui();
  const editor = new CompactPromptEditor(tui, {} as never, undefined, state);
  const slot = new EditorSlot(tui, editor, state);
  (slot as unknown as { activeTabId: string }).activeTabId = "home";
  editor.setText("HOME-ONLY");

  state.activeTabId = "s1";
  slot.current;

  assert.equal(editor.getText(), "AGENT-DRAFT");
  assert.equal(tab.draftInput, "AGENT-DRAFT");
});
