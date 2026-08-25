import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  MixCodeFooterRoot,
  MixCodeLayoutRoot,
  MixCodeRoot,
} from "../src/ui/app-layout.js";
import type { EditorSlot } from "../src/ui/app-editor.js";
import { renderExtensionFooter } from "../src/ui/rendering.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import { getActiveTab } from "../src/core/tabs.js";
import { MixCodeRuntime } from "../src/agent/runtime.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

function fakeEditor(lines: string[]): EditorSlot {
  return {
    render: () => lines,
    invalidate: () => undefined,
    isShowingAutocomplete: () => false,
    setEmbeddedTerminalRows: () => false,
    setEditorMaxRows: () => false,
  } as unknown as EditorSlot;
}

function buildLayout(viewportRows: number, width = 80) {
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
      renderExtensionFooter(getActiveTab(state), width).length
    );
  const editor = fakeEditor(["editor-line-0", "editor-line-1"]);
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

test("many above/below editor widgets keep the tab bar on screen", () => {
  const viewportRows = 24;
  const { layout, tab } = buildLayout(viewportRows);

  tab.extensionUi.widgets = [
    ...Array.from({ length: 12 }, (_, i) => ({
      key: `above-${i}`,
      placement: "aboveEditor" as const,
      lines: [`ABOVE-${i}`],
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      key: `below-${i}`,
      placement: "belowEditor" as const,
      lines: [`BELOW-${i}`],
    })),
  ];

  // Two passes: clamp reads previous frame's tabBarHitRow.
  layout.render(80);
  const lines = layout.render(80);
  const text = stripAnsi(lines.join("\n"));

  assert.ok(lines.length <= viewportRows, `overflow: ${lines.length} > ${viewportRows}`);
  assert.match(text, /Agent-01/, "tab bar must stay visible");
  assert.match(text, /editor-line-0/, "editor must remain usable");
  // Truncation affordance when the budget cannot fit every widget line.
  assert.match(text, /widget|truncated|more/i);
});

test("widgets-truncated marker fits a 20-column terminal", () => {
  const viewportRows = 24;
  const width = 20;
  const { layout, tab } = buildLayout(viewportRows, width);

  tab.extensionUi.widgets = [
    ...Array.from({ length: 12 }, (_, i) => ({
      key: `above-${i}`,
      placement: "aboveEditor" as const,
      lines: [`ABOVE-${i}`],
    })),
    ...Array.from({ length: 10 }, (_, i) => ({
      key: `below-${i}`,
      placement: "belowEditor" as const,
      lines: [`BELOW-${i}`],
    })),
  ];

  layout.render(width);
  const lines = layout.render(width);
  assert.match(stripAnsi(lines.join("\n")), /widget|truncated|more/i);
  for (const [index, line] of lines.entries()) {
    const lineWidth = visibleWidth(line);
    assert.ok(
      lineWidth <= width,
      `line ${index} width ${lineWidth} > ${width}: ${JSON.stringify(stripAnsi(line))}`,
    );
  }
});
