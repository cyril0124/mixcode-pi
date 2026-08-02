import assert from "node:assert/strict";
import { test } from "node:test";
import type { Terminal } from "@earendil-works/pi-tui";
import { createMixCodeTui, handleMixCodeKeyInput } from "../src/ui/app.js";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeTabInfo } from "../src/core/types.js";
import type { MixCodeRuntime } from "../src/agent/runtime.js";
import type { SessionTreeNode } from "../src/core/tree-selector.js";
import { renderFloatingPanelOverlay } from "../src/ui/rendering/floating-panel.js";
import { themeForId } from "../src/ui/themes.js";

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

function userEntry(id: string, text: string, parentId: string | null) {
  return messageNode(id, parentId, "user", text).entry;
}

function makeRuntime(tab: MixCodeTabInfo): MixCodeRuntime {
  const branch = [
    userEntry("u1", "first user message", null),
    messageNode("a1", "u1", "assistant", "assistant answer").entry,
    userEntry("u2", "second user message", "a1"),
    messageNode("a2", "u2", "assistant", "assistant answer 2").entry,
    userEntry("u3", "third user message", "a2"),
    messageNode("a3", "u3", "assistant", "assistant answer 3").entry,
    userEntry("u4", "fourth user message", "a3"),
    messageNode("a4", "u4", "assistant", "assistant answer 4").entry,
    userEntry("u5", "fifth user message", "a4"),
    messageNode("a5", "u5", "assistant", "assistant answer 5").entry,
    userEntry("u6", "sixth user message", "a5"),
  ];
  const chat = branch
    .filter((entry) => entry.type === "message")
    .map((entry) => ({
      role: entry.message.role as "user" | "assistant",
      text: entry.message.content[0]?.type === "text" ? entry.message.content[0].text : "",
      entryId: entry.id,
    }));
  return {
    getTab: () => ({
      tab,
      chat,
      session: { getBranch: () => branch },
    }),
    onChange: () => () => undefined,
    getAllExtensionCommands: () => [],
    getPromptHistory: () => [],
    setExtensionUiHost: () => undefined,
    getExtensionCommands: () => [],
    onTabClosed: () => () => undefined,
    onModelsChanged: () => () => undefined,
    appendSystemMessage: () => undefined,
    getSharedModelRuntime: () => undefined,
    getExtensionTools: () => [],
    applyExtensionAutocompleteProviders: (_sessionId: string, base: AutocompleteProvider) => base,
  } as unknown as MixCodeRuntime;
}

function emptyEditor() {
  return { getText: () => "", setText: () => undefined };
}

test("generic floating panel overlays above editor right and highlights selected row", () => {
  const lines = Array.from({ length: 10 }, (_, index) => `${`base-${index}`.padEnd(39)}│`);
  const rendered = renderFloatingPanelOverlay(
    lines,
    {
      title: "User Messages",
      lines: ["↑ 2 older above", "previous", "current", "↓ 1 newer below"],
      highlightedIndex: 2,
      width: 26,
      expiresAt: Date.now() + 1_000,
      style: {
        border: "warning",
        title: "accent",
        body: "panel",
        highlighted: "success",
      },
    },
    { width: 40, editorTopRow: 9, theme: themeForId("mixcode-dark") },
  );
  assert.match(rendered[1] ?? "", /\x1b\[38;2;240;198;116m╭/);
  assert.match(rendered[1] ?? "", /\x1b\[38;2;138;190;183mUser Messages/);
  assert.match(rendered[4] ?? "", /\x1b\[38;2;181;189;104m current/);
  const plain = rendered.map(stripAnsi);

  assert.match(plain[1] ?? "", /╭ User Messages/);
  assert.match(plain[2] ?? "", /↑ 2 older above/);
  assert.match(plain[4] ?? "", /current/);
  assert.match(plain[5] ?? "", /↓ 1 newer below/);
  assert.equal(plain[4]?.endsWith("│"), true, "floating panel must preserve the right scrollbar column");
  assert.match(plain[9] ?? "", /base-9/);
});

test("vim user-message navigation renders an expiring preview above the editor", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { vimMode: true });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = makeRuntime(tab);
  const tui = createMixCodeTui(state, runtime, { terminal: silentTerminal() });

  try {
    assert.deepEqual(
      handleMixCodeKeyInput(state, "\x1b[1;2C", tui, undefined, runtime, undefined, () => false, emptyEditor()),
      { consume: true },
    );
    let plain = tui.render(80).map(stripAnsi).join("\n");
    assert.match(plain, /User Messages/);
    assert.match(plain, /sixth user message/);
    assert.match(plain, /<NEWEST>/);

    for (let i = 0; i < 3; i++) {
      handleMixCodeKeyInput(state, "\x1b[1;2C", tui, undefined, runtime, undefined, () => false, emptyEditor());
    }
    tab.chatSurfaceBounds = { top: 1, left: 1, width: 80, height: 5 };
    handleMixCodeKeyInput(state, "\x1b[C", tui, undefined, runtime, undefined, () => false, emptyEditor());
    plain = tui.render(80).map(stripAnsi).join("\n");
    assert.match(plain, /↑ 3 older above/);
    assert.match(plain, /fourth user message/);
    assert.match(plain, /↓ 3 newer below/);
    assert.doesNotMatch(plain, /\* fourth user message|o fourth user message/);

    tab.floatingPanel = { ...tab.floatingPanel!, expiresAt: Date.now() - 1 };
    plain = tui.render(80).map(stripAnsi).join("\n");
    assert.doesNotMatch(plain, /User Messages/);
  } finally {
    tui.stop();
  }
});
