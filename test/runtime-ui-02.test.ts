import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import {
  MixCodeRoot,
  MixCodeRuntime,
  createInitialState,
  createTab,
  createMixCodeTui,
} from "./helpers/mixcode.js";

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

test("MixCodeRoot renders config and agent views", () => {
  const state = createInitialState("/repo");
  const runtime = new MixCodeRuntime();
  const root = new MixCodeRoot(state, runtime);
  assert.match(stripAnsi(root.render(100).join("\n")), /MixCode Home/);

  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  assert.match(root.render(100).join("\n"), /No messages yet/);

  state.activeTabId = "home";
  assert.match(root.render(100).join("\n"), /Agents/);

  const compactRoot = new MixCodeRoot(state, runtime, () => 8);
  const compactLines = compactRoot.render(100);
  assert.match(stripAnsi(compactLines.join("\n")), /MixCode Home/);
  assert.ok(compactLines.length <= 7);

  state.activeTabId = "s1";
  const compactChat = Array.from({ length: 50 }, (_, index) => ({
    role: "assistant" as const,
    text: `message ${index}`,
  }));
  (runtime as unknown as { getTab: () => { chat: typeof compactChat } }).getTab = () => ({
    chat: compactChat,
  });
  const compactAgentLines = compactRoot.render(100);
  assert.match(stripAnsi(compactAgentLines[0] ?? ""), /Agent-01/);
  assert.match(stripAnsi(compactAgentLines[1] ?? ""), /^\u2500+$/);
  assert.match(stripAnsi(compactAgentLines[2] ?? ""), /↑ older above/);
  assert.equal(compactAgentLines.length, 6);

  const headerOnlyRoot = new MixCodeRoot(state, runtime, () => 2);
  assert.equal(headerOnlyRoot.render(100).length, 0);

  const topOnlyRoot = new MixCodeRoot(state, runtime, () => 4);
  const topOnlyLines = topOnlyRoot.render(100);
  assert.equal(topOnlyLines.length, 2);
  assert.match(stripAnsi(topOnlyLines[0] ?? ""), /Agent-01/);
});

test("createMixCodeTui theme host updates state and notifies listeners", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const changedThemes: string[] = [];
  const runtime = new MixCodeRuntime();
  const tui = createMixCodeTui(state, runtime, {
    terminal: silentTerminal(),
    onStateChanged: (nextState) => {
      changedThemes.push(nextState.theme);
    },
  });
  try {
    const host = (
      runtime as unknown as {
        extensionUiHost?: {
          themes?: {
            getTheme: () => string;
            setTheme: (themeId: string) => void;
          };
        };
      }
    ).extensionUiHost;
    assert.equal(host?.themes?.getTheme(), "claude-warm");
    host?.themes?.setTheme("terminal");
    assert.equal(state.theme, "terminal");
    assert.deepEqual(changedThemes, ["terminal"]);
  } finally {
    tui.stop();
  }
});
