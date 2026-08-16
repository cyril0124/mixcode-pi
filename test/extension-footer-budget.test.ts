import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MixCodeFooterRoot,
  MixCodeLayoutRoot,
  MixCodeRoot,
  TERMINAL_SCROLL_GUARD_ROWS,
} from "../src/ui/app-layout.js";
import type { EditorSlot } from "../src/ui/app-editor.js";
import { renderExtensionFooter, renderFooter } from "../src/ui/rendering.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";
import { getActiveTab } from "../src/core/tabs.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

function fakeEditor(lines: string[]): EditorSlot {
  return {
    render: () => lines,
    invalidate: () => undefined,
    setEmbeddedTerminalRows: () => false,
    setEditorMaxRows: () => false,
  } as unknown as EditorSlot;
}

function buildLayout(viewportRows: number, width = 100) {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs = [tab];
  state.activeTabId = tab.sessionId;
  const runtime = new MixCodeRuntime();

  let editorRows = 0;
  let metaRows = 1;
  const main = new MixCodeRoot(
    state,
    runtime,
    () => viewportRows,
    () => {
      const active = getActiveTab(state);
      return (
        editorRows +
        metaRows +
        renderExtensionFooter(active, width).length +
        renderFooter(width).length +
        TERMINAL_SCROLL_GUARD_ROWS
      );
    },
  );
  const editor = fakeEditor(["editor-line-0"]);
  const layout = new MixCodeLayoutRoot(
    state,
    main,
    editor,
    new MixCodeFooterRoot(state),
    (rows) => {
      editorRows = rows;
    },
    (rows) => {
      metaRows = rows;
    },
    () => viewportRows,
    { requestRender: () => undefined },
  );
  return { layout, state, tab };
}

test("multi-line extension footer stays within viewport and keeps tab bar visible", () => {
  const viewportRows = 10;
  const width = 100;
  const { layout, tab } = buildLayout(viewportRows, width);
  tab.extensionUi.footer = {
    lines: [
      "FOOTER-LINE-1  extension footer (3 rows)",
      "FOOTER-LINE-2  not counted in layout budget",
      "FOOTER-LINE-3  → tab bar overflows viewport",
    ],
  };

  layout.render(width);
  const lines = layout.render(width);
  const text = stripAnsi(lines.join("\n"));

  assert.ok(
    lines.length <= viewportRows,
    `overflow: assembled=${lines.length} > viewport=${viewportRows}`,
  );
  assert.match(text, /MixCode Home|Agent-01/, "tab bar must stay in viewport");
  assert.match(text, /FOOTER-LINE-1/, "extension footer still paints");
});

test("Home does not paint the selected agent extension footer", () => {
  const viewportRows = 14;
  const width = 100;
  const { layout, state, tab } = buildLayout(viewportRows, width);
  tab.extensionUi.footer = {
    lines: [
      "FOOTER-LINE-1  extension footer (3 rows)",
      "FOOTER-LINE-2  not counted in layout budget",
      "FOOTER-LINE-3  → tab bar overflows viewport",
    ],
  };
  state.activeTabId = "home";
  state.homeSelectedTabIndex = 0;

  layout.render(width);
  const lines = layout.render(width);
  const text = stripAnsi(lines.join("\n"));

  assert.doesNotMatch(text, /FOOTER-LINE/, "agent extension footer must not show on Home");
  assert.match(text, /MixCode Home|Agents|Agent-01/);
});
