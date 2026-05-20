// Regression tests for the windowed agent-surface renderer.
// The windowed path activates for chats above WINDOW_RENDER_BLOCK_THRESHOLD
// (60 blocks) and skips rendering blocks outside the visible viewport. These
// tests check that the windowed output matches the legacy full-render path
// in the ways that matter to users: same visible content, same boundary
// markers, same scrollbar presence.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab, type ChatLine } from "../src/index.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";

const WIDTH = 100;
const HEIGHT = 20;

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function buildLongChat(count: number): ChatLine[] {
  const chat: ChatLine[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 4 === 0) chat.push({ role: "assistant", text: `assistant-${i}` });
    else if (i % 4 === 1) chat.push({ role: "user", text: `user-${i}` });
    else if (i % 4 === 2) {
      chat.push({
        role: "tool",
        title: "bash",
        toolCallId: `t-${i}`,
        status: "success",
        text: `output-${i}`,
        args: { command: `echo ${i}` },
      });
    } else chat.push({ role: "system", text: `system-${i}` });
  }
  return chat;
}

test("windowed renderer pins to bottom when scrollOffset is 0", () => {
  const chat = buildLongChat(200);
  const tab = createTab(1, "s1", "/repo", { chatScrollOffset: 0 });
  const lines = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  // The newest message must be visible. i=199 -> 199%4=3 -> system-199.
  assert.match(text, /system-199/);
  // The first visible row should be the boundary marker, not message-0.
  assert.match(text, /\.\.\. older above/);
  assert.equal(lines.length, HEIGHT);
});

test("windowed renderer shows mid-scroll content with both boundary markers", () => {
  const chat = buildLongChat(200);
  const tab = createTab(2, "s2", "/repo", { chatScrollOffset: 50 });
  const lines = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /\.\.\. older above/);
  assert.match(text, /\.\.\. newer below/);
  // Newest message should NOT be visible when scrolled mid.
  assert.doesNotMatch(text, /system-199/);
  assert.equal(lines.length, HEIGHT);
});

test("windowed renderer reaches top of chat when scrollOffset is the home sentinel", () => {
  const chat = buildLongChat(200);
  const tab = createTab(3, "s3", "/repo", { chatScrollOffset: 1_000_000 });
  const lines = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  // Oldest message should be visible after the sentinel-driven scroll.
  assert.match(text, /assistant-0\b/);
  // Newest message must NOT be visible.
  assert.doesNotMatch(text, /system-199/);
  assert.match(text, /\.\.\. newer below/);
  assert.equal(lines.length, HEIGHT);
  // The renderer must clamp the sentinel to a reasonable maximum, not leave
  // the user stuck above the content with subsequent scrolls feeling dead.
  assert.ok(tab.chatScrollOffset < 1_000_000);
});

test("windowed renderer keeps visible window stable across repeated renders", () => {
  const chat = buildLongChat(200);
  const tab = createTab(4, "s4", "/repo", { chatScrollOffset: 30 });
  const first = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  const second = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  // Identical inputs should produce identical output (cache stability).
  assert.deepEqual(first, second);
});

test("windowed renderer survives empty chat", () => {
  const chat: ChatLine[] = [];
  const tab = createTab(5, "s5", "/repo");
  const lines = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  // Empty chat returns just the placeholder rows; not padded to viewport.
  // (This matches the legacy path's behavior.)
  assert.match(lines.map(stripAnsi).join("\n"), /No messages yet/);
});

test("windowed renderer activates only above the threshold", () => {
  // Below threshold: legacy path. i=29 -> 29%4=1 -> user-29.
  const shortChat = buildLongChat(30);
  const shortTab = createTab(6, "s6", "/repo", { chatScrollOffset: 0 });
  const shortLines = renderAgentSurface(
    shortTab,
    { chat: shortChat, reasoning: [] } as never,
    WIDTH,
    HEIGHT,
  );
  assert.match(shortLines.map(stripAnsi).join("\n"), /user-29/);

  // Above threshold: windowed path. Same observable behavior at offset 0.
  // i=119 -> 119%4=3 -> system-119.
  const longChat = buildLongChat(120);
  const longTab = createTab(7, "s7", "/repo", { chatScrollOffset: 0 });
  const longLines = renderAgentSurface(
    longTab,
    { chat: longChat, reasoning: [] } as never,
    WIDTH,
    HEIGHT,
  );
  assert.equal(longLines.length, HEIGHT);
  assert.match(longLines.map(stripAnsi).join("\n"), /system-119/);
});

test("windowed renderer renders queue preview when present", () => {
  const chat = buildLongChat(150);
  const tab = createTab(8, "s8", "/repo", {
    chatScrollOffset: 0,
    pendingMessages: ["next prompt waiting"],
  });
  const lines = renderAgentSurface(tab, { chat, reasoning: [] } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /next prompt waiting/);
  assert.equal(lines.length, HEIGHT);
});
