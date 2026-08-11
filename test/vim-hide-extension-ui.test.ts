import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { createMixCodeTui } from "../src/ui/app.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";

// These tests verify that Vim mode (a read-only chat-scrolling surface) hides
// extension-injected UI around the editor: aboveEditor/belowEditor widgets and
// the extension status line. MixCode-owned chrome (meta row, agent title) stays.

const WIDGET_ABOVE = "todos-widget-above";
const WIDGET_BELOW = "fleet-widget-below";
const STATUS_TEXT = "subagents-status-line";
const CHAT_MARKER = "chat-history-line";

function makeState(vimMode: boolean) {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", {
      vimMode,
      extensionUi: {
        statuses: [{ key: "subagents", text: STATUS_TEXT }],
        widgets: [
          { key: "todos", placement: "aboveEditor", lines: [WIDGET_ABOVE] },
          { key: "fleet", placement: "belowEditor", lines: [WIDGET_BELOW] },
        ],
        toolsExpanded: false,
        pendingUserInteractions: [],
        workingVisible: true,
      },
    }),
  );
  state.activeTabId = "s1";
  return state;
}

function makeRuntime(): MixCodeRuntime {
  const chat = Array.from({ length: 40 }, (_, index) => ({
    role: "assistant" as const,
    text: `${CHAT_MARKER}-${index}`,
  }));
  return {
    getTab: () => ({ chat }),
    applyExtensionAutocompleteProviders: (_sessionId: string, base: unknown) => base,
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
  } as unknown as MixCodeRuntime;
}

function renderPlain(vimMode: boolean): { lines: string[]; chatRows: number } {
  const tui = createMixCodeTui(makeState(vimMode), makeRuntime(), { terminal: silentTerminal() });
  try {
    const lines = tui.render(80).map(stripAnsi);
    const chatRows = lines.filter((line) => line.includes(CHAT_MARKER)).length;
    return { lines, chatRows };
  } finally {
    tui.stop();
  }
}

test("normal mode shows extension widgets and the extension status line", () => {
  const { lines } = renderPlain(false);
  const output = lines.join("\n");
  assert.match(output, new RegExp(WIDGET_ABOVE));
  assert.match(output, new RegExp(WIDGET_BELOW));
  assert.match(output, new RegExp(STATUS_TEXT));
});

test("vim mode hides extension widgets and status line, reclaiming rows for chat", () => {
  const normal = renderPlain(false);
  const vim = renderPlain(true);
  const vimOutput = vim.lines.join("\n");

  // All extension-injected UI around the editor is gone in vim mode.
  assert.doesNotMatch(vimOutput, new RegExp(WIDGET_ABOVE));
  assert.doesNotMatch(vimOutput, new RegExp(WIDGET_BELOW));
  assert.doesNotMatch(vimOutput, new RegExp(STATUS_TEXT));

  // MixCode-owned chrome is preserved: the agent title still anchors the editor.
  assert.match(vimOutput, /Agent-01/);
  assert.match(vimOutput, /Vim: → newer user msg · Shift\+→ older user msg/);

  // The freed rows (2 widgets + 1 status) are handed back to the chat surface.
  assert.ok(
    vim.chatRows > normal.chatRows,
    `expected more chat rows in vim mode, got vim=${vim.chatRows} normal=${normal.chatRows}`,
  );
});

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function silentTerminal(): Terminal {
  return {
    start: () => undefined,
    stop: () => undefined,
    drainInput: async () => undefined,
    write: () => undefined,
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
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
