import assert from "node:assert/strict";
import { test } from "node:test";
import type { MixCodeRuntime } from "../src/index.js";
import { createInitialState, createTab, handleMixCodeKeyInput, handleSubmittedInput } from "../src/index.js";
import type { SessionTreeNode } from "../src/core/tree-selector.js";
import { scrollChatToUserEntry } from "../src/ui/chat-scroll-target.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { renderTreeSelector } from "../src/ui/tree-selector-render.js";

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

function runtimeWithTree(overrides: Partial<MixCodeRuntime> = {}): MixCodeRuntime {
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
    extensionNavigateTree: async () => {
      throw new Error("/navigate must scroll chat, not switch tree leaf");
    },
    appendSystemMessage: () => undefined,
    prompt: async () => undefined,
    ...overrides,
  } as unknown as MixCodeRuntime;
}

test("/navigate opens the Session Tree view filtered to current-chat user messages", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const openedSessions: string[] = [];
  const tui = {
    requestRender: () => undefined,
    treeSelectorDisplay: {
      open: (sessionId: string) => openedSessions.push(sessionId),
      refresh: () => undefined,
      close: () => undefined,
    },
  };

  await handleSubmittedInput(state, runtimeWithTree(), "/navigate", tui);

  assert.deepEqual(openedSessions, ["s1"]);
  assert.equal(state.treeSelector.open, true);
  assert.equal(state.treeSelector.mode, "navigate");
  assert.equal(state.treeSelector.filterMode, "user-only");
  assert.deepEqual(
    state.treeSelector.filteredNodes.map((node) => node.node.entry.id),
    ["u1", "u2"],
  );
  const text = renderTreeSelector(state, 100).map(stripAnsi).join("\n");
  assert.match(text, /Session Tree/);
  assert.match(text, /j\/k: move\+scroll/);
  assert.match(text, /user: first user/);
  assert.match(text, /user: second user/);
  assert.doesNotMatch(text, /side branch user/);
  assert.doesNotMatch(text, /assistant answer/);
});

test("/navigate moves with arrows and j/k, then scrolls current chat", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  tab.chatSurfaceBounds = { top: 0, left: 0, width: 80, height: 4 };
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = runtimeWithTree();
  const tui = {
    requestRender: () => undefined,
    treeSelectorDisplay: {
      open: () => undefined,
      refresh: () => undefined,
      close: () => undefined,
    },
  };

  await handleSubmittedInput(state, runtime, "/navigate", tui);
  assert.equal(state.treeSelector.filteredNodes[state.treeSelector.selectedIndex]?.node.entry.id, "u2");
  assert.equal(tab.chatScrollOffset, 0);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui, undefined, runtime), { consume: true });
  assert.equal(state.treeSelector.filteredNodes[state.treeSelector.selectedIndex]?.node.entry.id, "u1");
  await Promise.resolve();
  assert.ok(tab.chatScrollOffset > 0);

  const olderOffset = tab.chatScrollOffset;
  assert.deepEqual(handleMixCodeKeyInput(state, "k", tui, undefined, runtime), { consume: true });
  assert.equal(state.treeSelector.filteredNodes[state.treeSelector.selectedIndex]?.node.entry.id, "u1");
  assert.match(tab.toast?.message ?? "", /No older user message/);
  assert.equal(tab.chatScrollOffset, olderOffset);

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[B", tui, undefined, runtime), { consume: true });
  assert.equal(state.treeSelector.filteredNodes[state.treeSelector.selectedIndex]?.node.entry.id, "u2");
  await Promise.resolve();
  assert.equal(tab.chatScrollOffset, 0);
  assert.equal(state.treeSelector.summarizePrompt, null);

  assert.deepEqual(handleMixCodeKeyInput(state, "j", tui, undefined, runtime), { consume: true });
  assert.equal(state.treeSelector.filteredNodes[state.treeSelector.selectedIndex]?.node.entry.id, "u2");
  assert.match(tab.toast?.message ?? "", /No newer user message/);
  assert.equal(tab.chatScrollOffset, 0);

  assert.equal(handleMixCodeKeyInput(state, "\r", tui, undefined, runtime)?.consume, undefined);
  assert.equal(handleMixCodeKeyInput(state, "x", tui, undefined, runtime)?.consume, undefined);
  assert.equal(state.treeSelector.summarizePrompt, null);
  assert.equal(state.treeSelector.searchQuery, "");
});

test("/navigate scroll alignment puts selected user message at top when possible", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  const u1 = messageNode("u1", null, "user", "first user");
  const a1 = messageNode("a1", "u1", "assistant", "assistant one");
  const u2 = messageNode("u2", "a1", "user", "middle user");
  const a2 = messageNode("a2", "u2", "assistant", "assistant two");
  const u3 = messageNode("u3", "a2", "user", "last user");
  const chat = [
    { role: "user" as const, text: "first user", entryId: "u1" },
    { role: "assistant" as const, text: "assistant one" },
    { role: "user" as const, text: "middle user", entryId: "u2" },
    { role: "assistant" as const, text: "assistant two" },
    { role: "user" as const, text: "last user", entryId: "u3" },
  ];

  const result = scrollChatToUserEntry(tab, chat, [u1.entry, a1.entry, u2.entry, a2.entry, u3.entry], "u2", 5, 80);

  assert.equal(result.found, true);
  assert.ok(tab.chatScrollOffset > 0);
  const visible = renderAgentSurface(tab, { chat, reasoning: [] } as never, 80, 5)
    .map(stripAnsi)
    .filter((line) => line.trim());
  assert.match(visible.slice(0, 3).join("\n"), /middle user/);
  assert.doesNotMatch(visible.slice(0, 3).join("\n"), /first user/);
});

test("/navigate requires an active agent chat", async () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo");
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = {
    appendSystemMessage: () => undefined,
    prompt: async () => undefined,
    getTab: () => undefined,
  } as unknown as MixCodeRuntime;
  const tui = { requestRender: () => undefined };

  await assert.rejects(
    () => handleSubmittedInput(state, runtime, "/navigate", tui),
    /Navigate requires an active agent chat/,
  );
});
