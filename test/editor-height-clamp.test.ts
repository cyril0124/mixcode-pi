import assert from "node:assert/strict";
import { test } from "node:test";
import type { Component } from "@earendil-works/pi-tui";
import { initTreeSelector, type SessionTreeNode } from "../src/core/tree-selector.js";
import { renderTreeSelector } from "../src/ui/tree-selector-render.js";
import {
  MixCodeFooterRoot,
  MixCodeLayoutRoot,
  MixCodeRoot,
  TERMINAL_SCROLL_GUARD_ROWS,
} from "../src/ui/app-layout.js";
import type { EditorSlot } from "../src/ui/app-editor.js";
import { renderExtensionFooter, renderFooter } from "../src/ui/rendering.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { getActiveTab } from "../src/core/tabs.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

// Minimal editor stub returning a fixed set of lines, standing in for an
// extension editor-replacement component (e.g. the btw answer pager). The first
// and last lines mimic the pager's top/bottom borders so we can assert both
// survive the clamp.
function fakeEditor(lines: string[]): EditorSlot {
  return {
    render: () => lines,
    invalidate: () => undefined,
    setEmbeddedTerminalRows: () => false,
    setEditorMaxRows: () => false,
  } as unknown as EditorSlot;
}

// Build the lines a btw-style bordered pager emits for a tall answer. The real
// pager self-sizes its content to `terminal.rows - ANSWER_CHROME(4) -
// ANSWER_RESERVED_APP(3)` then wraps it in top border + title + footer + bottom
// border. We replicate that self-sizing so the test mirrors btw exactly.
const BTW_CHROME_LINES = 4;
const BTW_RESERVED_APP_LINES = 3;
function messageNode(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  children: SessionTreeNode[] = [],
): SessionTreeNode {
  return {
    entry: {
      type: "message",
      id,
      parentId,
      timestamp: "2026-05-14T00:00:00.000Z",
      message: { role, content: [{ type: "text", text }] },
    },
    children,
  } as SessionTreeNode;
}

function sampleTree(): SessionTreeNode[] {
  return [
    messageNode("root", null, "user", "start", [
      messageNode("assistant", "root", "assistant", "answer", [
        messageNode("active", "assistant", "user", "current branch"),
        messageNode("other", "assistant", "user", "side branch"),
      ]),
    ]),
  ];
}

function borderedPagerLines(viewportRows: number): string[] {
  const contentRows = Math.max(1, viewportRows - BTW_CHROME_LINES - BTW_RESERVED_APP_LINES);
  return [
    "TOP-BORDER",
    "TITLE",
    ...Array.from({ length: contentRows }, (_, i) => `content-${i}`),
    "FOOTER-HINTS",
    "BOTTOM-BORDER",
  ];
}

// Wire a layout root exactly like createMixCodeTui in app.ts: a REAL MixCodeRoot
// as main, with the editorRows -> getReservedRows feedback loop intact, so the
// test exercises the true rendering pipeline (including state.tabBarHitRow).
function buildRealLayoutWithEditor(editorLines: string[], viewportRows: number, width = 80) {
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
    () =>
      editorRows +
      metaRows +
      renderExtensionFooter(getActiveTab(state), width).length +
      renderFooter(width).length +
      TERMINAL_SCROLL_GUARD_ROWS,
  );
  const editor = fakeEditor(editorLines);
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
  return { layout, state, getEditorRows: () => editorRows };
}

// Convenience wrapper: build a layout whose editor returns N filler lines.
function buildRealLayout(editorLineCount: number, viewportRows: number, width = 80) {
  return buildRealLayoutWithEditor(
    Array.from({ length: editorLineCount }, (_, i) => `editor-line-${i}`),
    viewportRows,
    width,
  );
}

function buildRealLayoutWithDynamicEditor(
  editor: EditorSlot,
  viewportRows: number,
  width = 80,
) {
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
    () =>
      editorRows +
      metaRows +
      renderExtensionFooter(getActiveTab(state), width).length +
      renderFooter(width).length +
      TERMINAL_SCROLL_GUARD_ROWS,
  );
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
  return { layout, state };
}

function buildRealLayoutWithBtwStyleEditor(viewportRows: number) {
  let embeddedTerminalRows = viewportRows;
  const editor = {
    render: () => borderedPagerLines(embeddedTerminalRows),
    invalidate: () => undefined,
    setEmbeddedTerminalRows: (rows: number) => {
      if (embeddedTerminalRows === rows) return false;
      embeddedTerminalRows = rows;
      return true;
    },
    setEditorMaxRows: () => false,
  } as unknown as EditorSlot;
  return buildRealLayoutWithDynamicEditor(editor, viewportRows);
}

function buildRealLayoutWithTreeEditor(viewportRows: number) {
  let editorMaxRows: number | undefined;
  let editorState: ReturnType<typeof createInitialState> | undefined;
  const editor = {
    render: (width: number) => renderTreeSelector(editorState!, width, editorMaxRows),
    invalidate: () => undefined,
    setEmbeddedTerminalRows: () => false,
    setEditorMaxRows: (rows: number | undefined) => {
      if (editorMaxRows === rows) return false;
      editorMaxRows = rows;
      return true;
    },
  } as unknown as EditorSlot;
  const { layout, state } = buildRealLayoutWithDynamicEditor(editor, viewportRows);
  editorState = state;
  initTreeSelector(state.treeSelector, sampleTree(), "active");
  return { layout, state };
}

test("oversized extension editor never overflows the viewport or evicts the tab bar", () => {
  const viewportRows = 24;
  const { layout, state, getEditorRows } = buildRealLayout(200, viewportRows);

  // Render twice: the clamp reads the previous frame's tabBarHitRow, so a second
  // frame reflects the steady state the user actually sees.
  layout.render(80);
  const lines = layout.render(80);
  const text = stripAnsi(lines.join("\n"));

  assert.ok(
    lines.length <= viewportRows,
    `expected <= ${viewportRows} lines, got ${lines.length}`,
  );
  // The tab bar must survive (it is the first line main emits for an agent tab).
  assert.ok((state.tabBarHitRow ?? 0) >= 1, "tab bar must occupy at least one row");
  assert.match(text, /Agent-01/);
  // The editor was clamped well below its requested 200 lines but kept >= 1.
  assert.ok(getEditorRows() < 200, `editor rows ${getEditorRows()} should be clamped`);
  assert.ok(getEditorRows() >= 1, "editor must keep at least one line");
});

test("bordered pager keeps both its top and bottom borders alongside the tab bar", () => {
  // Regression: a previous over-reservation cut the pager's bottom border (the
  // yellow line) because the clamp sliced from the top. A btw-style pager that
  // self-sizes to the terminal must keep both borders AND the tab bar, with no
  // overflow and nothing clipped.
  const viewportRows = 24;
  const { layout, state } = buildRealLayoutWithEditor(
    borderedPagerLines(viewportRows),
    viewportRows,
  );

  layout.render(80);
  const lines = layout.render(80);
  const text = stripAnsi(lines.join("\n"));

  assert.ok(lines.length <= viewportRows, `overflow: ${lines.length} > ${viewportRows}`);
  assert.match(text, /Agent-01/, "tab bar must stay visible");
  assert.match(text, /TOP-BORDER/, "pager top border must stay visible");
  assert.match(text, /BOTTOM-BORDER/, "pager bottom border (yellow line) must stay visible");
  assert.ok((state.tabBarHitRow ?? 0) >= 1, "tab bar must remain laid out");
});

test("btw-style pager receives available height when widgets and working status consume rows", () => {
  const viewportRows = 24;
  const { layout, state } = buildRealLayoutWithBtwStyleEditor(viewportRows);
  try {
    const active = state.tabs[0]!;
    active.status = "running";
    active.workingStartedAt = new Date().toISOString();
    active.extensionUi.widgets = [
      {
        id: "goals",
        placement: "aboveEditor",
        lines: ["goal", "todo-1", "todo-2", "todo-3", "todo-4"],
      },
    ];

    layout.render(80);
    const lines = layout.render(80);
    const text = stripAnsi(lines.join("\n"));

    assert.ok(lines.length <= viewportRows, `overflow: ${lines.length} > ${viewportRows}`);
    assert.match(text, /Agent-01/, "tab bar must stay visible");
    assert.match(text, /TOP-BORDER/, "pager top border must stay visible");
    assert.match(text, /BOTTOM-BORDER/, "pager bottom border must stay visible");
    assert.doesNotMatch(text, /content-12/, "pager should size itself to available rows");
  } finally {
    layout.dispose();
  }
});

test("tree selector sizes list to available editor rows with widgets and worked status", () => {
  const viewportRows = 24;
  const { layout, state } = buildRealLayoutWithTreeEditor(viewportRows);
  const active = state.tabs[0]!;
  active.lastWorkedDurationSeconds = 2;
  active.extensionUi.widgets = [
    {
      id: "goals",
      placement: "aboveEditor",
      lines: ["goal", "time", "tokens", "floor", "next"],
    },
  ];

  layout.render(80);
  const lines = layout.render(80).map((line) => stripAnsi(line));
  const text = lines.join("\n");
  const treeNodeIndex = lines.findIndex((line) => line.includes("user: current branch"));
  const metaIndex = lines.findIndex((line) => line.includes("faux/faux-1"));

  assert.ok(lines.length <= viewportRows, `overflow: ${lines.length} > ${viewportRows}`);
  assert.match(text, /Session Tree/);
  assert.ok(treeNodeIndex >= 0, "tree node should stay visible inside editor area");
  assert.ok(metaIndex > treeNodeIndex, "input meta must remain below the tree list");
  assert.match(text, /\(3\/4\)/, "tree status row should remain visible");
});

test("non-self-sizing selector keeps its bottom border when clamped", () => {
  // The SDK ExtensionSelectorComponent renders its full box unconditionally
  // (no setEmbeddedTerminalRows/setEditorMaxRows hook), so an oversized option
  // list must keep its trailing border row instead of having it sliced off.
  const viewportRows = 12;
  const lines = [
    "TOP-BORDER",
    "TITLE",
    ...Array.from({ length: 30 }, (_, i) => `option-${i}`),
    "BOTTOM-BORDER",
  ];
  const { layout } = buildRealLayoutWithEditor(lines, viewportRows);

  layout.render(80);
  const text = stripAnsi(layout.render(80).join("\n"));

  assert.match(text, /TOP-BORDER/, "selector top border must stay visible");
  assert.match(text, /BOTTOM-BORDER/, "selector bottom border must survive the clamp");
});

test("small editor content is not clamped", () => {
  const { layout, getEditorRows } = buildRealLayout(3, 40);
  layout.render(80);
  layout.render(80);
  assert.equal(getEditorRows(), 3);
});

test("layout records visible input editor rows for mouse selection", () => {
  const { layout, state } = buildRealLayoutWithEditor(["TOP", " body ", "BOTTOM"], 24, 40);

  layout.render(40);
  layout.render(40);

  const active = state.tabs[0]!;
  assert.deepEqual(active.lastRenderedInputLines, ["TOP", " body ", "BOTTOM"]);
  assert.deepEqual(active.inputSurfaceBounds, {
    top: 21,
    left: 1,
    width: 40,
    height: 3,
  });

  state.activeTabId = "config";
  layout.render(40);
  assert.equal(active.inputSurfaceBounds?.width, 40);
  assert.equal(active.lastRenderedInputLines?.length, 3);
});
