import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import {
  createInitialState,
  createTab,
  renderConversation,
  renderHome,
  selectedNoticeText,
} from "./helpers/mixcode.js";
import {
  createTreeSelectorState,
  initTreeSelector,
  type SessionTreeNode,
} from "../src/core/tree-selector.js";
import { handleMouseInput } from "../src/ui/app-mouse.js";
import { closeAppOverlay, showNoticeTextOverlay } from "../src/ui/app-overlays.js";
import { handleTreeSelectorKey } from "../src/ui/components/tree-selector.js";
import { renderTreeSelector } from "../src/ui/components/tree-selector-render.js";
import { createSettingsPanel, selectSettingsItemByLabel } from "./helpers/settings-panel.js";
import { testOverlayHandle } from "./helpers/tui.js";

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

function toolResultTree(): SessionTreeNode[] {
  return [
    messageNode("root", null, "user", "start", [
      {
        entry: {
          type: "message",
          id: "assistant-tool",
          parentId: "root",
          timestamp: "2026-05-14T00:00:00.000Z",
          message: {
            ...fauxAssistantMessage(""),
            content: [
              { type: "toolCall", id: "call-1", name: "read", arguments: { path: "/tmp/a" } },
            ],
          },
        },
        children: [
          {
            entry: {
              type: "message",
              id: "tool-result",
              parentId: "assistant-tool",
              timestamp: "2026-05-14T00:00:00.000Z",
              message: {
                role: "toolResult",
                toolCallId: "call-1",
                toolName: "read",
                content: [{ type: "text", text: "tool output" }],
                isError: false,
                timestamp: 0,
              },
            },
            children: [],
          },
        ],
      },
    ]),
  ];
}

test("#76 settings number edit accepts unit suffixes and prefills compact form", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-unit-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  const oversized = { ui: { oversizedAssistantMessage: { maxBytes: 5 * 1024 * 1024 } } };
  await fsPromises.writeFile(mixcodeFile, JSON.stringify(oversized));
  try {
    const state = createInitialState(dir);
    const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
      mixcodeRaw: structuredClone(oversized),
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
    });

    selectSettingsItemByLabel(panel, "Oversized max bytes");
    panel.handleInput("\r"); // enter edit
    assert.equal(panel.editMode, true);
    assert.equal(panel.editText, "5mb");

    // Replace with 2kb
    panel.editText = "";
    for (const ch of "2kb") panel.handleInput(ch);
    panel.handleInput("\r");
    // setValue is async
    await Bun.sleep(30);
    assert.equal(panel.editMode, false);
    assert.equal(panel.mixcodeRaw.ui?.oversizedAssistantMessage?.maxBytes, 2 * 1024);

    assert.match(stripAnsi(panel.render(80).join("\n")), /2 KB/);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("#76 non-byte number fields reject unit suffixes", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-settings-retries-"));
  const mixcodeFile = path.join(dir, "mixcode_settings.json");
  await fsPromises.writeFile(
    mixcodeFile,
    JSON.stringify({
      ui: { oversizedAssistantMessage: { maxLines: 12 } },
    }),
  );
  try {
    const state = createInitialState(dir);
    const panel = createSettingsPanel(state, SettingsManager.inMemory(), {
      mixcodeRaw: { ui: { oversizedAssistantMessage: { maxLines: 12 } } },
      mixcodeFile,
      piSettingsFile: path.join(dir, "settings.json"),
    });

    selectSettingsItemByLabel(panel, "Oversized max lines");
    panel.handleInput("\r"); // enter edit
    assert.equal(panel.editMode, true);
    assert.equal(panel.editText, "12");

    panel.editText = "";
    for (const ch of "5k") panel.handleInput(ch);
    panel.handleInput("\r");
    await Bun.sleep(30);
    // Invalid unit input keeps edit mode and the prior explicit value.
    assert.equal(panel.editMode, true);
    assert.equal(panel.editText, "5k");
    assert.equal(panel.mixcodeRaw.ui?.oversizedAssistantMessage?.maxLines, 12);
    assert.match(panel.editError ?? "", /Invalid number/);
    assert.match(stripAnsi(panel.render(80).join("\n")), /Invalid number: "5k"/);

    // Valid plain integer still works for non-byte fields.
    panel.editText = "";
    for (const ch of "8") panel.handleInput(ch);
    panel.handleInput("\r");
    await Bun.sleep(30);
    assert.equal(panel.editMode, false);
    assert.equal(panel.mixcodeRaw.ui?.oversizedAssistantMessage?.maxLines, 8);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("#78 Home card shows unread-done chip and non-assistant preview", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    title: "Agent-01",
    status: "idle",
    unreadDone: true,
  });
  state.tabs.push(tab);
  state.activeTabId = "home";
  const plain = stripAnsi(
    renderHome(state, 100, undefined, 0, undefined, () => [
      { role: "user", text: "hello from bash", variant: "user-bash" },
    ]).join("\n"),
  );
  assert.match(plain, /\[done\]/);
  assert.match(plain, /hello from bash/);
});

test("Home card Updated uses lastWorkedAt recency, not run duration", () => {
  const state = createInitialState("/repo");
  // Run lasted 3 minutes, but work finished ~5 seconds ago.
  const tab = createTab(1, "s1", "/repo", {
    title: "Agent-01",
    status: "idle",
    lastWorkedDurationSeconds: 180,
    lastWorkedAt: new Date(Date.now() - 5_000).toISOString(),
  });
  state.tabs.push(tab);
  state.activeTabId = "home";
  const plain = stripAnsi(renderHome(state, 100).join("\n"));
  assert.match(plain, /faux-1 · \?\/200k · [0-5]s ago/);
  assert.doesNotMatch(plain, /3m ago/);
  assert.doesNotMatch(plain, /Updated/);
  assert.doesNotMatch(plain, /Project /);
});

test("#88 tree ctrl+d resets filter to default", () => {
  const state = createInitialState("/repo");
  state.treeSelector = createTreeSelectorState();
  initTreeSelector(state.treeSelector, toolResultTree(), "tool-result");
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => {
      throw new Error("unexpected overlay");
    },
    hideOverlay: () => undefined,
    treeSelectorDisplay: {
      open: () => undefined,
      refresh: () => undefined,
      close: () => undefined,
    },
  };
  const rendered = () => stripAnsi(renderTreeSelector(state, 100).join("\n"));

  // ctrl+o cycles to no-tools: tool result row hidden, badge shown.
  assert.equal(handleTreeSelectorKey(state, "\x0f", tui), true);
  assert.match(rendered(), /\[no-tools\]/);
  assert.doesNotMatch(rendered(), /\[read: \/tmp\/a\]/);

  // ctrl+d resets the filter to default: tool result row visible again, badge gone.
  assert.equal(handleTreeSelectorKey(state, "\x04", tui), true);
  assert.doesNotMatch(rendered(), /\[no-tools\]/);
  assert.match(rendered(), /\[read: \/tmp\/a\]/);
});

test("#99 expanded user-bash still offers collapse when overflow exists", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line-${i}`);
  const tab = createTab(1, "s1", "/repo");
  tab.extensionUi.toolsExpanded = true;
  const rendered = stripAnsi(
    renderConversation(
      [
        {
          role: "tool",
          title: "bash",
          variant: "user-bash",
          status: "success",
          text: lines.join("\n"),
          args: { command: "seq 25" },
        },
      ],
      80,
      tab,
    ).join("\n"),
  );
  assert.match(rendered, /ctrl\+o to collapse/);
});

test("#101 running bash label differs when agent is busy", () => {
  const line = {
    role: "tool" as const,
    title: "bash",
    variant: "user-bash" as const,
    status: "running" as const,
    text: "",
    args: { command: "sleep 1" },
  };
  const idle = stripAnsi(renderConversation([line], 80).join("\n"));
  assert.match(idle, /Running\.\.\. \(Esc to cancel\)/);

  const tab = createTab(1, "s1", "/repo", { status: "running" });
  const busy = stripAnsi(renderConversation([line], 80, tab).join("\n"));
  assert.match(busy, /agent Esc aborts run/);
});

test("#103 notice selection copy strips borders and hint", () => {
  const lines = [
    "┌──────────────┐",
    "│ Notice body  │",
    "│              │",
    "│ c/y copy · Esc close │",
    "└──────────────┘",
  ];
  const selection = {
    anchor: { row: 0, col: 0 },
    focus: { row: 4, col: 20 },
    dragging: false,
  };
  const text = selectedNoticeText(lines, selection);
  assert.match(text, /Notice body/);
  assert.doesNotMatch(text, /c\/y copy/);
  assert.doesNotMatch(text, /┌|└|│/);
});

test("#102 wheel still scrolls chat while Notice is open", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  tab.chatSurfaceBounds = { top: 5, left: 1, width: 20, height: 3 };
  tab.lastRenderedChatLines = ["a", "b", "c"];
  let renders = 0;
  const tui = {
    requestRender: () => renders++,
    showOverlay: (component: { render: (width: number) => string[] }, options: { width?: number }) => {
      component.render(typeof options.width === "number" ? options.width : 40);
      return testOverlayHandle();
    },
    hasOverlay: () => true,
  };
  showNoticeTextOverlay(tui, "notice while scrolling");
  try {
    assert.equal(
      handleMouseInput(state, tab, "\x1b[<64;2;6M", tui, undefined, undefined, async () => undefined),
      true,
    );
    assert.equal(tab.chatScrollOffset, 3);
    assert.ok(renders >= 1);
  } finally {
    closeAppOverlay(tui);
  }
});
