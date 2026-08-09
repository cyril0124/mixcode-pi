import assert from "node:assert/strict";
import { test } from "node:test";
import type { EditorComponent, TUI as TuiType } from "@earendil-works/pi-tui";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { CompactPromptEditor, EditorSlot, editorThemeFor } from "../src/ui/app-editor.js";
import { themeForId } from "../src/ui/themes.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

function makeTui(): TuiType {
  return {
    requestRender: () => undefined,
    setFocus: () => undefined,
    terminal: { rows: 40, columns: 80 },
  } as unknown as TuiType;
}

function makeSlot(state = createInitialState("/repo")) {
  const tab = createTab(1, "s1", "/repo", {
    title: "Agent-01",
    currentContextTokens: 100_000,
    contextLimit: 200_000,
    contextLimitOverridden: true,
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const tui = makeTui();
  const defaultEditor = new CompactPromptEditor(
    tui,
    editorThemeFor(themeForId(state.theme)),
    { paddingX: 1 },
    state,
  );
  const slot = new EditorSlot(tui, defaultEditor, state);
  return { state, tab, tui, defaultEditor, slot };
}

function stubEditor(
  lines: string[],
  textApi?: { getText?: () => string; setText?: (text: string) => void },
): EditorComponent {
  const identity = (s: string) => s;
  return {
    focused: false,
    borderColor: identity,
    render: () => lines.map((line) => line),
    invalidate: () => undefined,
    handleInput: () => undefined,
    getText: () => textApi?.getText?.() ?? "",
    setText: (text: string) => textApi?.setText?.(text),
  } as unknown as EditorComponent;
}

test("EditorSlot keeps context chrome on the default agent editor", () => {
  const { slot } = makeSlot();
  const plain = stripAnsi(slot.render(64).join("\n"));
  assert.match(plain, /Agent-01/);
  assert.match(plain, /100k\/200k\*/);
});

test("EditorSlot leaves custom editor body unlabeled (chrome moves to tab separator)", () => {
  const { slot, tab } = makeSlot();
  tab.contextLimitOverridden = true;
  const width = 48;
  const plainTop = "─".repeat(width);
  slot.setEditorComponent(() => stubEditor([plainTop, " body ", plainTop]));
  const lines = slot.render(width).map(stripAnsi);
  assert.equal(lines.length, 3);
  assert.equal(lines[0], plainTop);
  assert.doesNotMatch(lines.join("\n"), /Agent-01|100k\/200k/);
});

test("EditorSlot does not prepend chrome above rounded custom editor tops", () => {
  const { slot } = makeSlot();
  const width = 48;
  const roundedTop = `╭${"─".repeat(width - 2)}╮`;
  const roundedBot = `╰${"─".repeat(width - 2)}╯`;
  slot.setEditorComponent(() => stubEditor([roundedTop, "│ prompt │", roundedBot]));
  const lines = slot.render(width).map(stripAnsi);
  assert.equal(lines.length, 3);
  assert.match(lines[0]!, /╭/);
  assert.doesNotMatch(lines.join("\n"), /Agent-01/);
});

test("EditorSlot skips agent chrome for input-component overrides", () => {
  const { slot, state } = makeSlot();
  slot.setInputComponent(
    {
      render: () => ["dialog body"],
      invalidate: () => undefined,
      handleInput: () => undefined,
    },
    state.activeTabId,
  );
  const plain = stripAnsi(slot.render(40).join("\n"));
  assert.match(plain, /dialog body/);
  assert.doesNotMatch(plain, /100k\/200k/);
  assert.doesNotMatch(plain, /Agent-01/);
});

test("EditorSlot skips agent chrome on Home/config", () => {
  const { slot, state, defaultEditor } = makeSlot();
  state.activeTabId = "config";
  defaultEditor.setText("");
  const plain = stripAnsi(slot.render(48).join("\n"));
  assert.doesNotMatch(plain, /100k\/200k/);
  assert.doesNotMatch(plain, /Agent-01 ·/);
});

test("EditorSlot Up/Down browses prompt history with a permanent editor replacement", () => {
  const { slot, tab } = makeSlot();
  tab.promptHistory = ["newest", "older"];
  tab.draftInput = "";
  const width = 40;
  const plainTop = "─".repeat(width);
  let text = "";
  slot.setEditorComponent(() =>
    stubEditor([plainTop, " body ", plainTop], {
      getText: () => text,
      setText: (next) => {
        text = next;
      },
    }),
  );
  assert.equal(slot.browsePromptHistory("\x1b[A"), true, "Up from empty enters history");
  assert.equal(text, "newest");
  assert.equal(slot.browsePromptHistory("\x1b[A"), true);
  assert.equal(text, "older");
  assert.equal(slot.browsePromptHistory("\x1b[B"), true);
  assert.equal(text, "newest");
  assert.equal(slot.browsePromptHistory("\x1b[B"), true);
  assert.equal(text, "");
});
