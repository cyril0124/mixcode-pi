import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionTreeNode } from "../src/core/tree-selector.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";
import { createInitialState, createTab, handleMixCodeKeyInput } from "./helpers/mixcode.js";
import { testTui } from "./helpers/tui.js";
import { scrollChatToUserEntry } from "../src/ui/chat-scroll-target.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
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

function sampleTree(): SessionTreeNode[] {
  return [
    messageNode("u1", null, "user", "first user", [
      messageNode("a1", "u1", "assistant", "assistant answer", [
        messageNode("u2", "a1", "user", "second user"),
      ]),
      messageNode("u3", "u1", "user", "side branch user"),
    ]),
  ];
}

function currentBranch() {
  const root = sampleTree()[0]!;
  const assistant = root.children[0]!;
  const secondUser = assistant.children[0]!;
  return [root.entry, assistant.entry, secondUser.entry];
}

function currentChat() {
  return [
    { role: "user" as const, text: "first user", entryId: "u1" },
    { role: "assistant" as const, text: "assistant answer" },
    { role: "user" as const, text: "second user", entryId: "u2" },
  ];
}

function runtimeWithTree(): MixCodeRuntime {
  return {
    getTab: () => ({
      chat: currentChat(),
      session: {
        getTree: () => sampleTree(),
        getBranch: () => currentBranch(),
        getLeafId: () => "u2",
        appendLabelChange: () => "",
      },
      agentSession: { abortBranchSummary: () => undefined },
    }),
    appendSystemMessage: () => undefined,
    prompt: async () => undefined,
  } as unknown as MixCodeRuntime;
}

function emptyEditor() {
  return { getText: () => "", setText: () => undefined };
}

test("vim Right jumps to next user message and then NEWEST", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.chatSurfaceBounds = { top: 0, left: 0, width: 80, height: 4 };
  tab.vimMode = true;
  tab.chatScrollAnchorEntryId = "u1";
  tab.chatScrollAnchorIndex = 0;
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = runtimeWithTree();
  const tui = testTui();

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollAnchorEntryId, "u2");

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollAnchorEntryId, undefined);
  assert.equal(tab.chatScrollOffset, 0);

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.match(tab.toast?.message ?? "", /No newer user message/);
});

test("vim Shift+Right walks backward through user messages", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.chatSurfaceBounds = { top: 0, left: 0, width: 80, height: 4 };
  tab.vimMode = true;
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = runtimeWithTree();
  const tui = testTui();

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[1;2C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollAnchorEntryId, "u2");
  assert.equal(tab.chatScrollAnchorIndex, 2);

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[1;2C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollAnchorEntryId, "u1");
  assert.equal(tab.chatScrollAnchorIndex, 0);

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[1;2C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollAnchorEntryId, "u1");
  assert.match(tab.toast?.message ?? "", /No older user message/);
});

test("vim Shift+Right treats a stale anchor as the newest position", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.chatSurfaceBounds = { top: 0, left: 0, width: 80, height: 4 };
  tab.vimMode = true;
  tab.chatScrollAnchorEntryId = "missing";
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = runtimeWithTree();
  const tui = testTui();

  assert.deepEqual(
    handleMixCodeKeyInput(
      state,
      "\x1b[1;2C",
      tui,
      undefined,
      runtime,
      undefined,
      () => false,
      emptyEditor(),
    ),
    { consume: true },
  );
  assert.equal(tab.chatScrollAnchorEntryId, "u2");
  assert.equal(tab.chatScrollAnchorIndex, 2);
});

test("scrollChatToUserEntry puts selected user message at top when possible", () => {
  const tab = createTab(1, "s1", "/repo");
  const u1 = messageNode("u1", null, "user", "first user");
  const a1 = messageNode("a1", "u1", "assistant", "assistant one");
  const u2 = messageNode("u2", "a1", "user", "middle user");
  const a2 = messageNode("a2", "u2", "assistant", "assistant two");
  const u3 = messageNode("u3", "a2", "user", "last user");
  const chat = [
    { role: "user" as const, text: "first user", entryId: "u1" },
    { role: "assistant" as const, text: "assistant one" },
    { role: "user" as const, text: "middle user" },
    { role: "assistant" as const, text: "assistant two" },
    { role: "user" as const, text: "last user", entryId: "u3" },
  ];

  const result = scrollChatToUserEntry(
    tab,
    chat,
    [u1.entry, a1.entry, u2.entry, a2.entry, u3.entry],
    "u2",
    5,
    80,
  );

  assert.equal(result.found, true);
  assert.equal(tab.chatScrollAnchorEntryId, "u2");
  const visible = renderAgentSurface(tab, { chat } as never, 80, 5)
    .map(stripAnsi)
    .filter((line) => line.trim());
  assert.match(visible.slice(0, 3).join("\n"), /middle user/);
  assert.doesNotMatch(visible.slice(0, 3).join("\n"), /first user/);
});

test("scrollChatToUserEntry targeting does not render every chat block", () => {
  const tab = createTab(1, "s1", "/repo");
  const u1 = messageNode("u1", null, "user", "first user");
  const x1 = {
    entry: {
      type: "custom_message",
      id: "x1",
      parentId: "u1",
      timestamp: "2026-05-14T00:00:01.000Z",
      customType: "slow",
      content: "slow block",
    },
    children: [],
  } as unknown as SessionTreeNode;
  const u2 = messageNode("u2", "x1", "user", "second user");
  let renderCalls = 0;
  const chat = [
    { role: "user" as const, text: "first user", entryId: "u1" },
    {
      role: "extension" as const,
      text: "slow block",
      renderExtension: () => {
        renderCalls++;
        return ["slow block"];
      },
    },
    { role: "user" as const, text: "second user", entryId: "u2" },
  ];

  const result = scrollChatToUserEntry(tab, chat, [u1.entry, x1.entry, u2.entry], "u2", 4, 80);

  assert.equal(result.found, true);
  const visible = renderAgentSurface(tab, { chat } as never, 80, 4)
    .map(stripAnsi)
    .filter((line) => line.trim());
  assert.match(visible.slice(0, 3).join("\n"), /second user/);
  assert.equal(renderCalls, 0);
});
