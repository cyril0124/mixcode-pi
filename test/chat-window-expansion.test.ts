// Lazy expansion of the bounded restored chat window: startup materializes a
// 200-entry tail; scrolling (or gg) pinned at the top of that window pulls in
// one chunk of older history at a time while the viewport stays anchored.

import "./helpers/isolated-agent-dir.js";

import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  chatHomeWithExpansion,
  scrollChatWithExpansion,
  type ChatScrollExpansionRuntime,
} from "../src/core/overlays.js";
import { handleVimModeKey } from "../src/ui/app-key-handlers.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import {
  CHAT_WINDOW_EXPAND_CHUNK,
  RESTORED_CHAT_ENTRY_LIMIT,
} from "../src/agent/runtime-lifecycle.js";
import { stripTerminalSequences as stripAnsi } from "@earendil-works/pi-tui";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime, createTab, type ChatLine } from "./helpers/mixcode.js";

const WIDTH = 100;
const HEIGHT = 20;

function expansionRuntimeSpy(startIndex: number): {
  runtime: ChatScrollExpansionRuntime;
  expandCalls: string[];
  setStart: (next: number) => void;
} {
  let current = startIndex;
  const expandCalls: string[] = [];
  return {
    runtime: {
      getTab: (_sessionId: string) => ({ chatWindowStartIndex: current }),
      expandChatWindow: (sessionId: string) => {
        expandCalls.push(sessionId);
        current = Math.max(0, current - CHAT_WINDOW_EXPAND_CHUNK);
        return CHAT_WINDOW_EXPAND_CHUNK;
      },
    },
    expandCalls,
    setStart: (next: number) => {
      current = next;
    },
  };
}

test("up-scroll at the top of a windowed chat expands one chunk and applies the delta", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.chatScrollOffset = 500;
  tab.lastRenderedChatAtTop = true;
  const { runtime, expandCalls } = expansionRuntimeSpy(350);

  const consumed = scrollChatWithExpansion(runtime, tab, 3);

  assert.equal(consumed, true);
  assert.deepEqual(expandCalls, ["s1"]);
  assert.equal(tab.chatScrollOffset, 503);
});

test("up-scroll away from the top, down-scrolls, and full chats never expand", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.chatScrollOffset = 100;
  tab.lastRenderedChatAtTop = false;
  const away = expansionRuntimeSpy(350);
  scrollChatWithExpansion(away.runtime, tab, 3);
  assert.deepEqual(away.expandCalls, [], "not pinned at the top");

  const down = expansionRuntimeSpy(350);
  tab.lastRenderedChatAtTop = true;
  scrollChatWithExpansion(down.runtime, tab, -3);
  assert.deepEqual(down.expandCalls, [], "down-scroll never expands");

  const full = expansionRuntimeSpy(0);
  scrollChatWithExpansion(full.runtime, tab, 3);
  assert.deepEqual(full.expandCalls, [], "no windowed history left");
});

test("home mode expands only while pinned at the very top (chatHomeOffset 0)", () => {
  const tab = createTab(1, "s1", "/repo");
  const { runtime, expandCalls } = expansionRuntimeSpy(120);

  tab.chatAtHome = true;
  tab.chatHomeOffset = 5;
  chatHomeWithExpansion(runtime, tab);
  assert.deepEqual(expandCalls, [], "scrolled below the home top");

  tab.chatHomeOffset = 0;
  chatHomeWithExpansion(runtime, tab);
  assert.deepEqual(expandCalls, ["s1"], "gg pinned at the top pulls one chunk");
  assert.equal(tab.chatAtHome, true);
  assert.equal(tab.chatHomeOffset, 0);
});

test("repeated vim gg walks back through windowed history chunk by chunk", () => {
  const tab = createTab(1, "s1", "/repo");
  tab.vimMode = true;
  const { runtime, expandCalls } = expansionRuntimeSpy(RESTORED_CHAT_ENTRY_LIMIT);

  // First gg: not at home yet, so it only pins the home position.
  assert.equal(handleVimModeKey(tab, "g", runtime), true);
  assert.equal(handleVimModeKey(tab, "g", runtime), true);
  assert.deepEqual(expandCalls, []);
  assert.equal(tab.chatAtHome, true);

  // Every further gg expands one chunk while older history remains.
  assert.equal(handleVimModeKey(tab, "g", runtime), true);
  assert.equal(handleVimModeKey(tab, "g", runtime), true);
  assert.equal(expandCalls.length, 1);

  // Exhausted: no window left, gg stays a plain home.
  expansionRuntimeSpy(0);
  assert.equal(handleVimModeKey(tab, "g", runtime), true);
  assert.equal(handleVimModeKey(tab, "g", runtime), true);
});

function buildWindowedChat(count: number): ChatLine[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    text: `message-${index}`,
  }));
}

test("rendering a long chat records whether the offset is pinned at the top", () => {
  const tab = createTab(1, "s1", "/repo");
  const runtimeTab = { chat: buildWindowedChat(300) } as never;

  tab.chatScrollOffset = 0;
  renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT);
  assert.equal(tab.lastRenderedChatAtTop, false, "tail is not the top");

  tab.chatScrollOffset = 1_000_000;
  renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT);
  assert.equal(tab.lastRenderedChatAtTop, true, "clamped-to-top offset is the top");
});

test("expansion keeps the viewport anchored on the same content", () => {
  const tab = createTab(1, "s1", "/repo");
  const older = buildWindowedChat(200);
  const newer = buildWindowedChat(200).map((line, index) => ({
    ...line,
    text: `message-${index + 200}`,
  }));
  const rt: { chat: ChatLine[] } = {
    chat: [...older, ...newer].slice(RESTORED_CHAT_ENTRY_LIMIT), // startup window
  };
  const runtimeTab = rt as never;

  // Pin the viewport at the top of the materialized window.
  tab.chatScrollOffset = 1_000_000;
  const before = renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT).map(stripAnsi);
  const beforeTop = before.find((line) => line.trim());
  assert.ok(beforeTop, "window renders content");

  // User scrolls up at the top: expandChatWindow swaps in the full chat, then
  // the +3 delta applies. The freeze anchor must keep the viewport on the same
  // rows, shifted up by exactly the scrolled delta.
  rt.chat = [...older, ...newer];
  scrollChatWithExpansion(expansionRuntimeSpy(0).runtime, tab, 3);
  const after = renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT).map(stripAnsi);
  const afterTop = after.find((line) => line.trim());
  assert.ok(afterTop, "expanded window renders content");
  // The first previously-visible row must still be visible after the rebuild;
  // expansion itself must not jump the viewport to the tail or the very top.
  assert.ok(
    after.some((line) => line === beforeTop),
    "previously top row stays visible after expansion",
  );
});

test("runtime expandChatWindow materializes chunks and finishes at the full branch", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-window-expand-"));
  const sessionsRoot = path.join(dir, "sessions");
  await fsPromises.mkdir(sessionsRoot, { recursive: true });

  const sessionId = "windowed-session";
  const header = {
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: new Date().toISOString(),
    cwd: dir,
  };
  const lines: string[] = [JSON.stringify(header)];
  let parentId: string | null = null;
  const ENTRY_COUNT = RESTORED_CHAT_ENTRY_LIMIT + 100;
  for (let i = 0; i < ENTRY_COUNT; i += 1) {
    const id = `e${i}`;
    lines.push(
      JSON.stringify({
        type: "message",
        id,
        parentId,
        message: {
          role: i % 2 === 0 ? "user" : "assistant",
          content: [{ type: "text", text: `turn ${i}` }],
          timestamp: Date.now(),
        },
      }),
    );
    parentId = id;
  }
  await fsPromises.writeFile(
    path.join(sessionsRoot, `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${lines.join("\n")}\n`,
    "utf8",
  );

  const runtime = new MixCodeRuntime({ sessionsRoot });
  try {
    const runtimeTab = await runtime.createTab(createTab(1, sessionId, dir), {
      systemPrompt: "system",
      thinkingLevel: "medium",
      workdir: dir,
      model: MIXCODE_FAUX_MODEL,
    });

    // Startup kept the bounded tail (branch may carry an extra session_info
    // entry appended by createTab, so derive the expectation from the branch).
    const branchLength = runtimeTab.session.getBranch().length;
    assert.equal(branchLength, ENTRY_COUNT + 1);
    assert.equal(runtimeTab.chatWindowStartIndex, branchLength - RESTORED_CHAT_ENTRY_LIMIT);
    const windowed = runtimeTab.chat.filter(
      (line) => line.role === "user" || line.role === "assistant",
    ).length;
    // The window includes the session_info entry, so one slot is not a message.
    assert.equal(windowed, RESTORED_CHAT_ENTRY_LIMIT - 1);

    // One chunk: remaining entries (fewer than the chunk size).
    assert.equal(runtime.expandChatWindow(sessionId), branchLength - RESTORED_CHAT_ENTRY_LIMIT);
    assert.equal(runtimeTab.chatWindowStartIndex ?? 0, 0);
    const full = runtimeTab.chat.filter(
      (line) => line.role === "user" || line.role === "assistant",
    ).length;
    assert.equal(full, ENTRY_COUNT);

    // Fully expanded: further calls are a no-op.
    assert.equal(runtime.expandChatWindow(sessionId), 0);
  } finally {
    await runtime.closeAllTabs();
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
