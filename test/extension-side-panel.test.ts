import assert from "node:assert/strict";
import { test } from "node:test";
import { type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import { createMixCodeTui, handleMixCodeKeyInput } from "../src/ui/app.js";
import { handleMouseInput } from "../src/ui/app-mouse.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeState } from "../src/core/types.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import { renderExtensionPanel } from "../src/ui/rendering/chrome.js";
import { renderHotkeysText } from "../src/ui/hotkeys.js";

// The extension widget side panel: Right on empty input opens a right-hand
// vertical split that collects aboveEditor/belowEditor widgets; the widgets
// then disappear from around the editor. Right again closes it. Panel content
// is mouse-selectable. Below 80 cols it refuses to open (toast instead).

const RIGHT = "\x1b[C";
const WIDGET_ABOVE = "todos-above-line";
const WIDGET_BELOW = "fleet-below-line";
const CHAT_MARKER = "chat-line";

function makeTab(overrides: Record<string, unknown> = {}) {
  return createTab(1, "s1", "/repo", {
    extensionUi: {
      statuses: [],
      widgets: [
        { key: "todos", placement: "aboveEditor", lines: [WIDGET_ABOVE] },
        { key: "fleet", placement: "belowEditor", lines: [WIDGET_BELOW] },
      ],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
    ...overrides,
  });
}

function makeState(overrides: Record<string, unknown> = {}): MixCodeState {
  const state = createInitialState("/repo");
  state.tabs.push(makeTab(overrides));
  state.activeTabId = "s1";
  return state;
}

function makeRuntime(): MixCodeRuntime {
  const chat = Array.from({ length: 30 }, (_, i) => ({
    role: "assistant" as const,
    text: `${CHAT_MARKER}-${i}`,
  }));
  return {
    getTab: () => ({ chat }),
    applyExtensionAutocompleteProviders: (_sessionId: string, base: unknown) => base,
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
    getExtensionCommands: () => [],
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    appendSystemMessage: () => undefined,
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
  } as unknown as MixCodeRuntime;
}

function emptyEditor() {
  return { getText: () => "", setText: () => undefined };
}

function fakeTui() {
  let overlayOpen = false;
  return {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };
}

test("Right on empty input toggles the panel; second Right closes it", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  const tui = fakeTui();

  assert.equal(tab.panelOpen, false);
  assert.deepEqual(
    handleMixCodeKeyInput(state, RIGHT, tui, undefined, undefined, undefined, () => false, emptyEditor()),
    { consume: true },
  );
  assert.equal(tab.panelOpen, true);
  assert.deepEqual(
    handleMixCodeKeyInput(state, RIGHT, tui, undefined, undefined, undefined, () => false, emptyEditor()),
    { consume: true },
  );
  assert.equal(tab.panelOpen, false);
});

test("Right panel toggle has priority over extension shortcuts", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  const tui = fakeTui();
  let dispatched = false;
  const runtime = {
    dispatchExtensionShortcut: () => {
      dispatched = true;
      return true;
    },
  };

  assert.deepEqual(
    handleMixCodeKeyInput(state, RIGHT, tui, undefined, runtime, undefined, undefined, emptyEditor()),
    { consume: true },
  );
  assert.equal(tab.panelOpen, true);
  assert.equal(dispatched, false);
});

test("hotkeys help lists the Right widget panel shortcut", () => {
  assert.match(renderHotkeysText(), /Right.*extension widget side panel/);
});

test("Right with non-empty input does not open the panel (cursor move stays editor's)", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  const tui = fakeTui();

  const result = handleMixCodeKeyInput(
    state,
    RIGHT,
    tui,
    undefined,
    undefined,
    undefined,
    () => false,
    { getText: () => "hello", setText: () => undefined },
  );
  // Not consumed by the panel toggle; panel stays closed.
  assert.equal(tab.panelOpen, false);
  assert.notDeepEqual(result, { consume: true });
});

test("Right does not open the panel when the tab has no widgets", () => {
  const state = makeState({
    extensionUi: {
      statuses: [],
      widgets: [],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });
  const tab = state.tabs[0]!;
  const tui = fakeTui();

  handleMixCodeKeyInput(state, RIGHT, tui, undefined, undefined, undefined, () => false, emptyEditor());
  assert.equal(tab.panelOpen, false);
  assert.ok(tab.toast, "expected a toast explaining nothing to show");
});

test("open panel renders widgets on the right and removes them from around the editor", () => {
  const closed = renderPlain(false);
  const open = renderPlain(true);

  // Closed: widgets stack around the editor (single column).
  assert.match(closed.join("\n"), new RegExp(WIDGET_ABOVE));
  assert.match(closed.join("\n"), new RegExp(WIDGET_BELOW));

  // Open: widgets appear in the right panel...
  const openText = open.join("\n");
  assert.match(openText, new RegExp(WIDGET_ABOVE));
  assert.match(openText, new RegExp(WIDGET_BELOW));

  // ...and chat is now sharing rows with the panel: a panel row carries both a
  // chat marker on the left and a widget on the right (true side-by-side).
  const sideBySide = open.some(
    (line) => line.includes(CHAT_MARKER) && (line.includes(WIDGET_ABOVE) || line.includes(WIDGET_BELOW)),
  );
  assert.ok(sideBySide, "expected a row with chat on the left and a widget on the right");

  // The above-widget should sit above the below-widget inside the panel.
  const aboveRow = open.findIndex((l) => l.includes(WIDGET_ABOVE));
  const belowRow = open.findIndex((l) => l.includes(WIDGET_BELOW));
  assert.ok(aboveRow !== -1 && belowRow !== -1 && aboveRow < belowRow);
});

test("open panel shows a dim hint on how to close it", () => {
  const open = renderPlain(true);
  const closed = renderPlain(false);
  // The close hint is present only while the panel is open, on the panel side.
  assert.match(open.join("\n"), /\u2192 to close/);
  assert.doesNotMatch(closed.join("\n"), /\u2192 to close/);
});

test("open panel on a 20-column terminal does not overflow", () => {
  const state = makeState({ panelOpen: true });
  const tui = createMixCodeTui(state, makeRuntime(), { terminal: silentTerminal(20) });
  try {
    const lines = tui.render(20);
    for (const [index, line] of lines.entries()) {
      const lineWidth = visibleWidth(line);
      assert.ok(
        lineWidth <= 20,
        `line ${index} width ${lineWidth} > 20: ${JSON.stringify(stripAnsi(line))}`,
      );
    }
    const text = lines.map(stripAnsi).join("\n");
    assert.match(text, new RegExp(WIDGET_ABOVE));
    assert.equal(state.tabs[0]!.panelOpen, true);
    const wide = tui.render(100).map(stripAnsi).join("\n");
    assert.match(wide, /\u2192 to close/);
  } finally {
    tui.stop();
  }
});

test("panel shows full live widget output without a truncation marker", () => {
  // A widget whose render() honors the maxLines budget, like real callback
  // widgets. The tall panel must show all 18 lines; its own scroll window is
  // the only visible-height limit.
  const bigLines = Array.from({ length: 18 }, (_, i) => `panel-item-${i + 1}`);
  const state = makeState({
    panelOpen: true,
    extensionUi: {
      statuses: [],
      widgets: [
        {
          key: "big",
          placement: "aboveEditor",
          lines: bigLines,
          render: (_width: number, maxLines?: number) =>
            maxLines === undefined ? bigLines.slice(0, 10) : bigLines.slice(0, maxLines),
        },
      ],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });
  const tui = createMixCodeTui(state, makeRuntime(), { terminal: silentTerminal(100, 36) });
  let text: string;
  try {
    text = tui.render(100).map(stripAnsi).join("\n");
  } finally {
    tui.stop();
  }
  assert.match(text, /panel-item-18/);
  assert.doesNotMatch(text, /widget truncated/);
});

test("panel shows a scroll-down marker when live widget output overflows", () => {
  const tab = makeTab({
    extensionUi: {
      statuses: [],
      widgets: [
        {
          key: "big",
          placement: "aboveEditor",
          lines: [],
          render: (_width: number, maxLines?: number) =>
            Array.from({ length: maxLines ?? 20 }, (_, i) => `live-item-${i + 1}`),
        },
      ],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });

  // At the top of a tall panel, the hidden rows below are flagged with "↓ more".
  tab.panelScrollOffset = 0;
  const text = renderExtensionPanel(tab, 40, 5).map(stripAnsi).join("\n");
  assert.match(text, /\u2193 more/);
  assert.doesNotMatch(text, /\u2191 more/);
});

test("panel wraps wide widget lines instead of truncating with an ellipsis", () => {
  // A single line wider than the panel body must wrap onto multiple rows so no
  // content is lost. Regression guard: render-based widgets used to be cut with
  // "..." (see chrome.ts truncateToWidth) instead of wrapped.
  const longLine =
    "This is a very long widget line that clearly exceeds the panel body width and should wrap";
  const tab = makeTab({
    extensionUi: {
      statuses: [],
      widgets: [{ key: "w", placement: "aboveEditor", lines: [], render: () => [longLine] }],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });

  const rows = renderExtensionPanel(tab, 40, 10).map(stripAnsi);
  const body = rows.join("\n");
  // No ellipsis truncation, and the final word of the line survives the wrap.
  assert.doesNotMatch(body, /\.\.\./);
  assert.match(body, /should wrap/);
  // The line occupied more than one content row (wrapped, not single-line).
  const contentRows = rows.filter((r) => /\S/.test(r.replace(/\u2502/g, "").replace(/to close/, "")));
  assert.ok(contentRows.length >= 2, "wide line should wrap onto multiple rows");
});

test("panel below the width threshold refuses to open with a toast", () => {
  const state = makeState();
  const tab = state.tabs[0]!;
  const tui = fakeTui();
  const original = Object.getOwnPropertyDescriptor(process.stdout, "columns");
  Object.defineProperty(process.stdout, "columns", { value: 60, configurable: true });
  try {
    handleMixCodeKeyInput(state, RIGHT, tui, undefined, undefined, undefined, () => false, emptyEditor());
    assert.equal(tab.panelOpen, false);
    assert.equal(tab.toast?.type, "warning");
  } finally {
    if (original) Object.defineProperty(process.stdout, "columns", original);
  }
});

test("panel content is mouse-selectable and copies to clipboard", async () => {
  const state = makeState({ panelOpen: true });
  const tab = state.tabs[0]!;
  const tui = fakeTui();
  // Render once so the panel surface bounds + raw lines are recorded.
  const mixTui = createMixCodeTui(state, makeRuntime(), { terminal: silentTerminal(100) });
  mixTui.render(100);
  mixTui.stop();

  assert.ok(tab.panelSurfaceBounds, "panel bounds should be set after render");
  const bounds = tab.panelSurfaceBounds!;
  // Find a panel row that actually contains widget text to select.
  const rowIndex = (tab.lastRenderedPanelLines ?? []).findIndex((l) => l.includes(WIDGET_ABOVE));
  assert.ok(rowIndex >= 0, "panel should contain the above-widget line");
  const screenRow = bounds.top + rowIndex;
  const startCol = bounds.left;
  const endCol = bounds.left + bounds.width - 1;

  let copied = "";
  const copy = async (text: string) => {
    copied = text;
  };
  // Press (button 0), drag to end of row, release — SGR mouse sequences.
  handleMouseInput(state, tab, `\x1b[<0;${startCol};${screenRow}M`, tui, undefined, undefined, copy);
  handleMouseInput(state, tab, `\x1b[<32;${endCol};${screenRow}M`, tui, undefined, undefined, copy);
  handleMouseInput(state, tab, `\x1b[<0;${endCol};${screenRow}m`, tui, undefined, undefined, copy);

  await Bun.sleep(10);
  assert.match(copied, new RegExp(WIDGET_ABOVE));
});

test("tall panel scrolls with clamped offset and shows up/down markers", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `panel-item-${i + 1}`);
  const tab = createTab(1, "s1", "/repo", {
    panelOpen: true,
    extensionUi: {
      statuses: [],
      widgets: [{ key: "big", placement: "aboveEditor", lines }],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });

  // At offset 0: top visible, a "↓ more" marker but no "↑ more".
  tab.panelScrollOffset = 0;
  const top = renderExtensionPanel(tab, 40, 10).map(stripAnsi).join("\n");
  assert.match(top, /panel-item-1\b/);
  assert.match(top, /\u2193 more/);
  assert.doesNotMatch(top, /\u2191 more/);

  // Scrolled down: a "↑ more" marker appears and later items become visible.
  tab.panelScrollOffset = 5;
  const mid = renderExtensionPanel(tab, 40, 10).map(stripAnsi).join("\n");
  assert.match(mid, /\u2191 more/);
  assert.match(mid, /panel-item-\d\d/);

  // Offset past the end is clamped back to the real maximum (no blank scroll).
  tab.panelScrollOffset = 9999;
  renderExtensionPanel(tab, 40, 10);
  assert.ok(tab.panelScrollOffset < 9999, "offset should be clamped to overflow");
  const end = renderExtensionPanel(tab, 40, 10).map(stripAnsi).join("\n");
  assert.match(end, /panel-item-30\b/);
  assert.doesNotMatch(end, /\u2193 more/);
});

test("wheel routes to panel or chat by region, never both", () => {
  const state = makeState({
    panelOpen: true,
    extensionUi: {
      statuses: [],
      widgets: [
        {
          key: "big",
          placement: "aboveEditor",
          lines: Array.from({ length: 30 }, (_, i) => `panel-item-${i + 1}`),
        },
      ],
      toolsExpanded: false,
      waitingForInputs: [],
      workingVisible: true,
    },
  });
  const tab = state.tabs[0]!;
  const tui = fakeTui();
  // Establish panel/chat surface bounds.
  const mixTui = createMixCodeTui(state, makeRuntime(), { terminal: silentTerminal(100) });
  mixTui.render(100);
  mixTui.stop();
  const bounds = tab.panelSurfaceBounds!;
  assert.ok(bounds, "panel bounds set");

  // Wheel-down inside the panel scrolls the panel, leaves chat untouched.
  const chatBefore = tab.chatScrollOffset;
  handleMouseInput(
    state,
    tab,
    `\x1b[<65;${bounds.left + 1};${bounds.top + 1}M`,
    tui,
    undefined,
    undefined,
    async () => {},
  );
  assert.ok(tab.panelScrollOffset > 0, "panel scrolled");
  assert.equal(tab.chatScrollOffset, chatBefore, "chat not scrolled by panel wheel");

  // Wheel-up over the chat column scrolls chat, leaves the panel offset alone.
  const panelBefore = tab.panelScrollOffset;
  handleMouseInput(state, tab, `\x1b[<64;2;${bounds.top + 1}M`, tui, undefined, undefined, async () => {});
  assert.equal(tab.panelScrollOffset, panelBefore, "panel not scrolled by chat wheel");
  assert.ok(tab.chatScrollOffset > chatBefore, "chat scrolled");
});

function renderPlain(panelOpen: boolean): string[] {
  const state = makeState({ panelOpen });
  const tui = createMixCodeTui(state, makeRuntime(), { terminal: silentTerminal(100) });
  try {
    return tui.render(100).map(stripAnsi);
  } finally {
    tui.stop();
  }
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function silentTerminal(columns: number, rows = 24): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return columns;
    },
    get rows() {
      return rows;
    },
    get kittyProtocolActive() {
      return false;
    },
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => undefined,
    setTitle: () => undefined,
    setProgress: () => undefined,
  };
}

// Regression: Ctrl+E must reach a pending extension editor (e.g. /view), NOT
// the global main-input external-editor handler. Permanent setEditorComponent
// skins still use MixCode Ctrl+E; only pending interactions own the key.
test("Ctrl+E defers to the extension editor component when a pending interaction owns the slot", () => {
  const state = makeState();
  state.tabs[0]!.extensionUi.waitingForInputs.push({
    id: "extension-editor-1",
    kind: "editor",
  });
  let capturedHost:
    | { editor?: { setEditorComponent?: (factory: unknown, sessionId?: string) => void } }
    | undefined;
  const runtime = {
    getTab: () => ({ chat: [] }),
    applyExtensionAutocompleteProviders: (_sessionId: string, base: unknown) => base,
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
    getExtensionCommands: () => [],
    getPromptHistory: () => [],
    appendSystemMessage: () => undefined,
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    setExtensionUiHost: (host: typeof capturedHost) => {
      capturedHost = host;
    },
  } as unknown as MixCodeRuntime;

  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal(100, 36) });
  try {
    const received: string[] = [];
    // Minimal EditorComponent stub that records the input it is handed.
    const stubFactory = () => ({
      render: () => ["stub-editor"],
      invalidate: () => undefined,
      getText: () => "",
      setText: () => undefined,
      handleInput: (data: string) => {
        received.push(data);
      },
    });
    assert.ok(capturedHost?.editor?.setEditorComponent, "extension UI host must expose editor replacement");
    capturedHost.editor.setEditorComponent(stubFactory, "s1");

    // Ctrl+E (0x05) fed through the real tui input pipeline.
    (tui as unknown as { handleTerminalInput(data: string): void }).handleTerminalInput("\x05");

    // Pending interaction owns Ctrl+E: falls through to the focused EditorSlot stub.
    assert.deepEqual(received, ["\x05"]);
  } finally {
    tui.stop();
  }
});
