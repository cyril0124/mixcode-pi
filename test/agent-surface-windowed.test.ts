// Regression tests for the windowed agent-surface renderer.
// The windowed path activates for chats above WINDOW_RENDER_BLOCK_THRESHOLD
// (60 blocks) and skips rendering blocks outside the visible viewport. These
// tests check that the windowed output matches the legacy full-render path
// in the ways that matter to users: same visible content, same boundary
// markers, same scrollbar presence.

import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
  createTab,
  scrollChat,
  type ChatLine,
  type MixCodeTabInfo,
} from "../src/index.js";
import { renderAgentSurface } from "../src/ui/rendering/agent-surface.js";
import { renderChat } from "../src/ui/rendering/chat.js";

const WIDTH = 100;
const HEIGHT = 20;
const DEFAULT_SURFACE_OPTIONS = {
  oversizedAssistantMessage: DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
};

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

function buildStreamingAssistantChat(count: number): ChatLine[] {
  const paragraph = "Streaming assistant text with enough words to wrap across lines. ".repeat(8);
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant",
    text: `${paragraph} block-${index}`,
  }));
}

function buildPerformanceChat(count: number): ChatLine[] {
  const chat: ChatLine[] = [];
  for (let i = 0; i < count; i++) {
    if (i % 4 === 0) {
      chat.push({
        role: "assistant",
        text: `assistant-${i} ${"assistant words wrap markdown **bold** ".repeat(30)}`,
      });
    } else if (i % 4 === 1) {
      chat.push({ role: "user", text: `user-${i} ${"user words wrap ".repeat(30)}` });
    } else if (i % 4 === 2) {
      chat.push({
        role: "tool",
        title: "bash",
        toolCallId: `t-${i}`,
        status: "success",
        text: `output-${i} ${"tool output ".repeat(30)}`,
        args: { command: `echo ${i}` },
      });
    } else {
      chat.push({ role: "system", text: `system-${i} ${"system words ".repeat(30)}` });
    }
  }
  return chat;
}

function buildRunningChatWithHugeStreamingTail(): ChatLine[] {
  const chat: ChatLine[] = [{ role: "user", text: "first user message" }];
  for (let i = 1; i < 80; i++) {
    chat.push({
      role: i % 2 === 0 ? "user" : "assistant",
      text: `historical-${i} ${"history words wrap ".repeat(50)}`,
    });
  }
  chat.push({
    role: "assistant",
    text: `active streaming tail ${"streaming words wrap ".repeat(10_000)}`,
  });
  return chat;
}

test("windowed renderer pins to bottom when scrollOffset is 0", () => {
  const chat = buildLongChat(200);
  const tab = createTab(1, "s1", "/repo", { chatScrollOffset: 0 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  // The newest message must be visible. i=199 -> 199%4=3 -> system-199.
  assert.match(text, /system-199/);
  // The first visible row should be the boundary marker, not message-0.
  assert.match(text, /↑ older above/);
  assert.equal(lines.length, HEIGHT);
});

test("windowed renderer shows mid-scroll content with both boundary markers", () => {
  const chat = buildLongChat(200);
  const tab = createTab(2, "s2", "/repo", { chatScrollOffset: 50 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /↑ older above/);
  assert.match(text, /↓ newer below/);
  // Newest message should NOT be visible when scrolled mid.
  assert.doesNotMatch(text, /system-199/);
  assert.equal(lines.length, HEIGHT);
});

test("windowed renderer reaches top of chat when scrollOffset is the home sentinel", () => {
  const chat = buildLongChat(200);
  const tab = createTab(3, "s3", "/repo", { chatScrollOffset: 1_000_000 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  // Oldest message should be visible after the sentinel-driven scroll.
  assert.match(text, /assistant-0\b/);
  // Newest message must NOT be visible.
  assert.doesNotMatch(text, /system-199/);
  assert.match(text, /↓ newer below/);
  assert.equal(lines.length, HEIGHT);
  // The renderer must clamp the sentinel to a reasonable maximum, not leave
  // the user stuck above the content with subsequent scrolls feeling dead.
  assert.ok(tab.chatScrollOffset < 1_000_000);
});

test("windowed renderer keeps visible window stable across repeated renders", () => {
  const chat = buildLongChat(200);
  const tab = createTab(4, "s4", "/repo", { chatScrollOffset: 30 });
  const first = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const second = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  // Identical inputs should produce identical output (cache stability).
  assert.deepEqual(first, second);
});

test("windowed renderer survives empty chat", () => {
  const chat: ChatLine[] = [];
  const tab = createTab(5, "s5", "/repo");
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  // Empty chat returns just the placeholder rows; not padded to viewport.
  // (This matches the legacy path's behavior.)
  assert.match(lines.map(stripAnsi).join("\n"), /No messages yet/);
});

test("windowed renderer renders queue preview when present", () => {
  const chat = buildLongChat(150);
  const tab = createTab(8, "s8", "/repo", {
    chatScrollOffset: 0,
    pendingMessages: ["next prompt waiting"],
  });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  assert.match(text, /next prompt waiting/);
  assert.equal(lines.length, HEIGHT);
});

test("windowed renderer preserves header-to-queue spacing with empty blocks", () => {
  const chat: ChatLine[] = Array.from({ length: 60 }, () => ({
    role: "assistant",
    text: "",
  }));
  const overrides = {
    startupSummary: "[Context]\n  /repo/AGENTS.md\n",
    pendingMessages: ["queued"],
  };
  const clean = (lines: string[]) => lines.map((line) => stripAnsi(line).trimEnd());
  const full = clean(
    renderAgentSurface(
      createTab(42, "s42-full", "/repo", overrides),
      { chat } as never,
      WIDTH - 1,
    ),
  );
  const windowed = clean(
    renderAgentSurface(
      createTab(43, "s43-windowed", "/repo", overrides),
      { chat } as never,
      WIDTH,
      HEIGHT * 2,
    ),
  );

  assert.deepEqual(windowed.slice(0, full.length), full);
});

test("running plain streaming chats use windowed rendering", () => {
  const chat = buildStreamingAssistantChat(180);
  const tab = createTab(9, "s9", "/repo", { status: "running", chatScrollOffset: 0 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");

  assert.equal(lines.length, HEIGHT);
  assert.match(text, /block-179/);
  assert.match(text, /↑ older above/);
  assert.doesNotMatch(text, /block-0\b/);
});

test("windowed renderer keeps scrolled view stable as new output arrives", () => {
  const chat = buildLongChat(120);
  const tab = createTab(20, "s20", "/repo", { status: "running", chatScrollOffset: 30 });
  const before = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);
  const firstMessageRow = before.findIndex((line) => /\b(?:assistant|user|output|system)-\d+\b/.test(line));
  const firstVisibleMessage = before[firstMessageRow]?.match(/\b(?:assistant|user|output|system)-\d+\b/)?.[0];

  assert.ok(firstVisibleMessage, "expected a visible chat message below the older marker");

  chat.push(...buildLongChat(10).map((line, index) => ({ ...line, text: `${line.text}-new-${index}` })));
  const after = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);

  assert.match(after[firstMessageRow] ?? "", new RegExp(`\\b${firstVisibleMessage}\\b`));
  assert.ok(tab.chatScrollOffset > 30, "scroll offset grows to compensate for appended output");
});

test("windowed renderer keeps scrolled view stable as streaming tail grows", () => {
  const chat = buildRunningChatWithHugeStreamingTail();
  const tab = createTab(21, "s21", "/repo", { status: "running", chatScrollOffset: 30 });
  const before = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);
  const firstContentRow = before.findIndex((line) => line.includes("streaming words wrap"));
  const firstVisibleLine = before[firstContentRow];

  assert.ok(firstVisibleLine, "expected visible streaming content");

  chat[chat.length - 1] = {
    ...chat[chat.length - 1]!,
    text: `${chat[chat.length - 1]!.text} ${"new streaming words wrap ".repeat(400)}`,
  };
  const after = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);
  const repeated = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);

  assert.equal(after.length, HEIGHT);
  assert.equal(repeated.length, HEIGHT);
  assert.equal(after[firstContentRow], firstVisibleLine);
  assert.equal(repeated[firstContentRow], firstVisibleLine);

  tab.chatScrollOffset = 0;
  const bottom = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT)
    .map(stripAnsi)
    .join("\n");
  assert.match(bottom, /new streaming words wrap/);
});

test("renderer transition keeps a historical scroll anchor when streaming completes", () => {
  const chat = [
    ...buildLongChat(30),
    { role: "assistant" as const, text: "active streaming tail" },
  ];
  const tab = createTab(44, "s44", "/repo", { status: "running", chatScrollOffset: 30 });
  const before = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);
  const anchorRow = before.findIndex((line) =>
    /\b(?:assistant|user|output|system)-\d+\b/.test(line),
  );
  const anchor = before[anchorRow];

  assert.ok(anchor, "expected a visible historical message");

  chat[chat.length - 1] = {
    role: "assistant",
    text: Array.from({ length: 120 }, (_, index) => `STREAM-${index + 1}`).join("\n"),
  };
  tab.status = "idle";
  const after = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi);

  assert.equal(after[anchorRow], anchor);
});

test("streaming completion keeps a PageUp anchor when the viewport grows", () => {
  const streamingLines = Array.from(
    { length: 120 },
    (_, index) => `STREAM-LINE-${String(index).padStart(4, "0")} ${"content ".repeat(8)}`,
  );
  const streamingText = streamingLines.slice(0, 60).join("\n");
  const chat: ChatLine[] = [...buildLongChat(64), { role: "assistant", text: streamingText }];
  const streamingIndex = chat.length - 1;
  const tab = createTab(45, "s45", "/repo", { status: "running", chatScrollOffset: 0 });
  const streamingRuntimeTab = {
    tab,
    chat,
    streamingAssistant: {
      chatIndex: streamingIndex,
      blockIndices: new Map([[0, streamingIndex]]),
      toolCallIndices: new Map<string, number>(),
    },
  };

  renderAgentSurface(tab, streamingRuntimeTab as never, WIDTH, HEIGHT);
  scrollChat(tab, 10);
  const before = renderAgentSurface(tab, streamingRuntimeTab as never, WIDTH, HEIGHT).map(stripAnsi);
  const anchorRow = before.findIndex((line) => line.includes("STREAM-LINE-"));
  const anchor = before[anchorRow];

  assert.ok(anchor, "expected the PageUp viewport inside the streaming message");

  for (let length = 70; length <= streamingLines.length; length += 10) {
    chat[streamingIndex] = { role: "assistant", text: streamingLines.slice(0, length).join("\n") };
    renderAgentSurface(tab, streamingRuntimeTab as never, WIDTH, HEIGHT);
  }
  chat[streamingIndex] = {
    role: "assistant",
    text: `${streamingLines.join("\n")}\nFINAL-COMPLETION-MARKER`,
  };
  const completedRuntimeTab = { tab, chat, streamingAssistant: undefined };
  renderAgentSurface(tab, completedRuntimeTab as never, WIDTH, HEIGHT);
  tab.status = "idle";
  const after = renderAgentSurface(tab, completedRuntimeTab as never, WIDTH, HEIGHT + 1).map(
    stripAnsi,
  );

  assert.equal(after[anchorRow], anchor);
});

test("short-chat renderer switch keeps an anchor inside the completed streaming message", () => {
  const streamingLines = Array.from(
    { length: 80 },
    (_, index) => `STREAM-LINE-${String(index).padStart(4, "0")} ${"content ".repeat(8)}`,
  );
  // 24 blocks: windowed while running (>=20), full render once idle (<60).
  const chat: ChatLine[] = [...buildLongChat(23), { role: "assistant", text: streamingLines.slice(0, 40).join("\n") }];
  const streamingIndex = chat.length - 1;
  const tab = createTab(46, "s46", "/repo", { status: "running", chatScrollOffset: 0 });
  const streamingRuntimeTab = {
    tab,
    chat,
    streamingAssistant: {
      chatIndex: streamingIndex,
      blockIndices: new Map([[0, streamingIndex]]),
      toolCallIndices: new Map<string, number>(),
    },
  };

  renderAgentSurface(tab, streamingRuntimeTab as never, WIDTH, HEIGHT);
  scrollChat(tab, 10);
  const before = renderAgentSurface(tab, streamingRuntimeTab as never, WIDTH, HEIGHT).map(stripAnsi);
  const anchorRow = before.findIndex((line) => line.includes("STREAM-LINE-"));
  const anchor = before[anchorRow];

  assert.ok(anchor, "expected the PageUp viewport inside the streaming message");

  chat[streamingIndex] = { role: "assistant", text: streamingLines.join("\n") };
  const completedRuntimeTab = { tab, chat, streamingAssistant: undefined };
  renderAgentSurface(tab, completedRuntimeTab as never, WIDTH, HEIGHT);
  tab.status = "idle";
  const after = renderAgentSurface(tab, completedRuntimeTab as never, WIDTH, HEIGHT + 1).map(
    stripAnsi,
  );

  assert.equal(after[anchorRow], anchor);
});

test("deep scroll keeps its history anchor across streaming growth and completion", () => {
  const chat: ChatLine[] = [
    ...buildLongChat(200),
    { role: "assistant", text: Array.from({ length: 60 }, (_, i) => `TAIL-${i}`).join("\n") },
  ];
  const streamingIndex = chat.length - 1;
  const tab = createTab(47, "s47", "/repo", { status: "running", chatScrollOffset: 0 });
  const runtimeTab = {
    tab,
    chat,
    streamingAssistant: {
      chatIndex: streamingIndex,
      blockIndices: new Map([[0, streamingIndex]]),
      toolCallIndices: new Map<string, number>(),
    },
  };

  renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT);
  for (let page = 0; page < 6; page++) {
    scrollChat(tab, 10);
    renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT);
  }
  const before = renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT).map(stripAnsi);
  const anchorRow = before.findIndex((line) => /(?:assistant|user|output|system)-\d+/.test(line));
  const anchor = before[anchorRow];

  assert.ok(anchor, "expected a visible history message after deep scroll");
  assert.doesNotMatch(anchor, /TAIL-/);

  chat[streamingIndex] = {
    role: "assistant",
    text: Array.from({ length: 160 }, (_, i) => `TAIL-${i}`).join("\n"),
  };
  renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT);
  const completedRuntimeTab = { tab, chat, streamingAssistant: undefined };
  renderAgentSurface(tab, completedRuntimeTab as never, WIDTH, HEIGHT);
  tab.status = "idle";
  const after = renderAgentSurface(tab, completedRuntimeTab as never, WIDTH, HEIGHT + 1).map(
    stripAnsi,
  );

  assert.equal(after[anchorRow], anchor);
});

test("tool completion and agent-end notices do not shift a frozen history anchor", () => {
  const chat: ChatLine[] = [
    ...buildLongChat(80),
    {
      role: "tool",
      title: "bash",
      toolCallId: "t-run",
      status: "running",
      text: "working...",
      args: { command: "sleep 1" },
    },
  ];
  const toolIndex = chat.length - 1;
  const tab = createTab(48, "s48", "/repo", { status: "running", chatScrollOffset: 0 });
  const runtimeTab = {
    tab,
    chat,
    streamingAssistant: {
      chatIndex: undefined,
      blockIndices: new Map(),
      toolCallIndices: new Map([["t-run", toolIndex]]),
    },
  };

  renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT);
  scrollChat(tab, 10);
  const before = renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT).map(stripAnsi);
  const anchorRow = before.findIndex((line) => /(?:assistant|user|output|system)-\d+/.test(line));
  const anchor = before[anchorRow];

  assert.ok(anchor, "expected a visible history message above the running tool");

  // tool_execution_end: running renderer swaps to the success renderer.
  chat[toolIndex] = { ...chat[toolIndex]!, status: "success", text: "done" };
  // agent_end: empty-run notice lands below.
  chat.push({ role: "system", text: "(agent ended)" });
  const endedRuntimeTab = { tab, chat, streamingAssistant: undefined };
  renderAgentSurface(tab, endedRuntimeTab as never, WIDTH, HEIGHT);
  tab.status = "idle";
  const after = renderAgentSurface(tab, endedRuntimeTab as never, WIDTH, HEIGHT + 1).map(
    stripAnsi,
  );

  assert.equal(after[anchorRow], anchor);
});

test("scrolling up past the streaming markdown limit does not snap on the next frame", () => {
  const streamingLines = Array.from(
    { length: 200 },
    (_, index) => `STREAM-LINE-${String(index).padStart(4, "0")} ${"content ".repeat(8)}`,
  );
  // 120 rendered lines ≈ 8.6k chars: past STREAMING_MARKDOWN_CHAR_LIMIT at PageUp.
  const chat: ChatLine[] = [
    ...buildLongChat(24),
    { role: "assistant", text: streamingLines.slice(0, 120).join("\n") },
  ];
  const streamingIndex = chat.length - 1;
  const tab = createTab(49, "s49", "/repo", { status: "running", chatScrollOffset: 0 });
  const runtimeTab = {
    tab,
    chat,
    streamingAssistant: {
      chatIndex: streamingIndex,
      blockIndices: new Map([[0, streamingIndex]]),
      toolCallIndices: new Map<string, number>(),
    },
  };

  renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT);
  scrollChat(tab, 10);
  const frozen = renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT).map(stripAnsi);
  const anchorRow = frozen.findIndex((line) => line.includes("STREAM-LINE-"));
  const anchor = frozen[anchorRow];

  assert.ok(anchor, "expected the PageUp viewport inside the streaming message");

  // Next frame: the freeze disables tail truncation, so the block re-renders in
  // full. The anchor line must not move.
  chat[streamingIndex] = { role: "assistant", text: streamingLines.slice(0, 130).join("\n") };
  const after = renderAgentSurface(tab, runtimeTab as never, WIDTH, HEIGHT).map(stripAnsi);

  assert.equal(after[anchorRow], anchor);
});

// Growth can arrive in the same frame as a user scroll. Freeze must still absorb
// the growth; otherwise the view drifts toward the streaming tail.
test("windowed renderer stays stable when user scrolls in the same frame as growth", () => {
  const chatA = buildLongChat(120);
  const chatB = buildLongChat(120);
  const tabA = createTab(22, "s22", "/repo", { status: "running", chatScrollOffset: 40 });
  const tabB = createTab(23, "s23", "/repo", { status: "running", chatScrollOffset: 40 });

  renderAgentSurface(tabA, { chat: chatA } as never, WIDTH, HEIGHT);
  renderAgentSurface(tabA, { chat: chatA } as never, WIDTH, HEIGHT);
  renderAgentSurface(tabB, { chat: chatB } as never, WIDTH, HEIGHT);
  renderAgentSurface(tabB, { chat: chatB } as never, WIDTH, HEIGHT);

  // Scroll-only baseline.
  tabA.chatScrollOffset += 5;
  const onlyScroll = renderAgentSurface(tabA, { chat: chatA } as never, WIDTH, HEIGHT).map(stripAnsi);
  const onlyScrollIds = onlyScroll
    .map((line) => line.match(/\b(?:assistant|user|output|system)-\d+\b/)?.[0])
    .filter((id): id is string => Boolean(id));

  // Same user scroll, but content also grows below in this frame.
  tabB.chatScrollOffset += 5;
  chatB.push(
    ...buildLongChat(12).map((line, index) => ({ ...line, text: `${line.text}-grow-${index}` })),
  );
  const scrollAndGrow = renderAgentSurface(tabB, { chat: chatB } as never, WIDTH, HEIGHT).map(
    stripAnsi,
  );
  const scrollAndGrowIds = scrollAndGrow
    .map((line) => line.match(/\b(?:assistant|user|output|system)-\d+\b/)?.[0])
    .filter((id): id is string => Boolean(id));

  assert.deepEqual(
    scrollAndGrowIds,
    onlyScrollIds,
    "same-frame growth must not push the scrolled view toward newer content",
  );
  assert.ok(
    tabB.chatScrollOffset > tabA.chatScrollOffset,
    "scroll offset must grow to absorb appended content after a same-frame user scroll",
  );
});

test("running chats with historical tool renderers still use windowed rendering", () => {
  let rendered = 0;
  const chat = buildStreamingAssistantChat(180);
  chat.splice(20, 0, {
    role: "tool",
    title: "historical",
    toolCallId: "historical-1",
    status: "success",
    text: "",
    renderToolCall: () => {
      rendered++;
      return ["historical tool frame"];
    },
  });
  const tab = createTab(10, "s10", "/repo", { status: "running", chatScrollOffset: 0 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");

  assert.equal(rendered, 0);
  assert.equal(lines.length, HEIGHT);
  assert.match(text, /block-179/);
  assert.match(text, /↑ older above/);
  assert.doesNotMatch(text, /historical tool frame/);
});

test("complete long assistant messages render full text outside TUI oversized policy", () => {
  const text = `START ${"x".repeat(9000)} END`;
  const rendered = renderChat([{ role: "assistant", text }], WIDTH).map(stripAnsi).join("\n");

  assert.match(rendered, /START/);
  assert.match(rendered, /END/);
  assert.doesNotMatch(rendered, /Oversized provider output/);
});

test("TUI surface folds oversized assistant provider output", () => {
  const chat: ChatLine[] = [
    { role: "assistant", text: `huge-start\n${"card\n".repeat(200)}huge-end` },
  ];
  const tab = createTab(24, "s24", "/repo", { chatScrollOffset: 0 });
  const text = renderAgentSurface(tab, { chat } as never, WIDTH, 140, undefined, {
    oversizedAssistantMessage: { enabled: true, maxLines: 50, maxBytes: 1024 * 1024 },
  })
    .map(stripAnsi)
    .join("\n");

  assert.match(text, /\[Oversized provider output\]/);
  assert.match(text, /role: assistant/);
  assert.match(text, /threshold:/);
  assert.match(text, /raw preview:/);
  assert.match(text, /huge-start/);
  assert.match(text, /huge-end/);
  assert.match(text, /use \/view to inspect it/);
});

test("TUI surface restores full assistant markdown rendering when oversized policy is disabled", () => {
  const chat: ChatLine[] = [{ role: "assistant", text: `START ${"x".repeat(200)} END` }];
  const tab = createTab(25, "s25", "/repo", { chatScrollOffset: 0 });
  const text = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT, undefined, {
    oversizedAssistantMessage: { enabled: false, maxLines: 1, maxBytes: 1 },
  })
    .map(stripAnsi)
    .join("\n");

  assert.doesNotMatch(text, /Oversized provider output/);
  assert.match(text, /START/);
  assert.match(text, /END/);
});

test("TUI surface folds oversized streaming assistant output immediately", () => {
  const chat: ChatLine[] = [{ role: "assistant", text: `streaming ${"card ".repeat(200)}` }];
  const tab = createTab(26, "s26", "/repo", { status: "running", chatScrollOffset: 0 });
  const runtimeTab = {
    chat,
    streamingAssistant: { chatIndex: 0, blockIndices: new Map() },
  } as never;
  const text = renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT, undefined, {
    oversizedAssistantMessage: { enabled: true, maxLines: 5000, maxBytes: 100 },
  })
    .map(stripAnsi)
    .join("\n");

  assert.match(text, /\[Oversized provider output\]/);
  assert.match(text, /role: assistant/);
});

test("TUI surface keeps below-threshold assistant messages as markdown", () => {
  const chat: ChatLine[] = [{ role: "assistant", text: "normal **markdown** message" }];
  const tab = createTab(27, "s27", "/repo", { chatScrollOffset: 0 });
  const text = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT, undefined, DEFAULT_SURFACE_OPTIONS)
    .map(stripAnsi)
    .join("\n");

  assert.doesNotMatch(text, /Oversized provider output/);
  assert.match(text, /normal markdown message/);
});

test("TUI oversized policy applies only to assistant and thinking roles", () => {
  const oversizedAssistantMessage = { enabled: true, maxLines: 1, maxBytes: 5 };
  const chat: ChatLine[] = [
    { role: "user", text: "USER-CONTENT-ABOVE-THRESHOLD" },
    { role: "tool", title: "bash", toolCallId: "t-role", status: "success", text: "TOOL-CONTENT-ABOVE-THRESHOLD" },
    { role: "system", text: "SYSTEM-CONTENT-ABOVE-THRESHOLD" },
    { role: "thinking", text: "THINKING-CONTENT-ABOVE-THRESHOLD" },
  ];
  const tab = createTab(28, "s28", "/repo", { chatScrollOffset: 0 });
  const text = renderAgentSurface(tab, { chat } as never, WIDTH, 80, undefined, {
    oversizedAssistantMessage,
  })
    .map(stripAnsi)
    .join("\n");

  assert.match(text, /USER-CONTENT-ABOVE-THRESHOLD/);
  assert.match(text, /TOOL-CONTENT-ABOVE-THRESHOLD/);
  assert.match(text, /SYSTEM-CONTENT-ABOVE-THRESHOLD/);
  assert.match(text, /role: thinking/);
});

test("running windowed renderer reaches the first user message with home sentinel", () => {
  const chat = buildRunningChatWithHugeStreamingTail();
  const tab = createTab(15, "s15", "/repo", { status: "running", chatScrollOffset: 1_000_000 });
  const streamingIndex = chat.length - 1;
  const runtimeTab = {
    chat,
    streamingAssistant: { chatIndex: streamingIndex, blockIndices: new Map() },
  } as never;

  const lines = renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");

  assert.match(text, /first user message/);
  assert.doesNotMatch(text, /active streaming tail/);
  assert.match(text, /↓ newer below/);
  assert.equal(lines.length, HEIGHT);
  assert.ok(tab.chatScrollOffset < 1_000_000);
});

test("running windowed renderer can scroll stepwise to the first user message", () => {
  const chat = buildRunningChatWithHugeStreamingTail();
  const tab = createTab(16, "s16", "/repo", { status: "running", chatScrollOffset: 0 });
  const streamingIndex = chat.length - 1;
  const runtimeTab = {
    chat,
    streamingAssistant: { chatIndex: streamingIndex, blockIndices: new Map() },
  } as never;

  let text = "";
  for (let step = 0; step < 500; step++) {
    text = renderAgentSurface(tab, runtimeTab, WIDTH, HEIGHT).map(stripAnsi).join("\n");
    if (/first user message/.test(text)) break;
    scrollChat(tab, 10);
  }

  assert.match(text, /first user message/);
});

test("running chats with active tool renderers use windowed rendering and still invoke renderer", () => {
  let rendered = 0;
  const chat = buildStreamingAssistantChat(180);
  chat.push({
    role: "tool",
    title: "dynamic",
    toolCallId: "dynamic-1",
    status: "running",
    text: "",
    renderToolCall: () => {
      rendered++;
      return ["dynamic tool frame"];
    },
  });
  const tab = createTab(11, "s11", "/repo", { status: "running", chatScrollOffset: 0 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");

  // Active tool renderer at the tail is within the viewport and gets invoked
  assert.equal(rendered, 1);
  assert.match(text, /dynamic tool frame/);
});

test("running tool behind extension message still renders correctly", () => {
  let rendered = 0;
  const chat = buildStreamingAssistantChat(180);
  chat.push({
    role: "tool",
    title: "active",
    toolCallId: "active-1",
    status: "running",
    text: "",
    renderToolCall: () => {
      rendered++;
      return ["active tool frame"];
    },
  });
  // Extension pushes a message after the running tool (simulates extension
  // emitting a custom message during tool execution).
  chat.push({ role: "extension", text: "extension notification" });
  const tab = createTab(14, "s14", "/repo", { status: "running", chatScrollOffset: 0 });
  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");

  // The running tool renderer must still be invoked (it's within the viewport).
  assert.equal(rendered, 1);
  assert.match(text, /active tool frame/);
});

test("idle chats with stale pending tool tail still use windowed rendering", () => {
  let historicalRendered = 0;
  const chat = buildStreamingAssistantChat(180);
  chat.splice(20, 0, {
    role: "tool",
    title: "historical",
    toolCallId: "historical-1",
    status: "success",
    text: "",
    renderToolCall: () => {
      historicalRendered++;
      return ["historical tool frame"];
    },
  });
  chat.push({
    role: "tool",
    title: "stale",
    toolCallId: "stale-1",
    status: "pending",
    text: "",
  });
  const tab = createTab(19, "s19", "/repo", { status: "idle", chatScrollOffset: 0 });

  const lines = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");

  assert.equal(lines.length, HEIGHT);
  assert.match(text, /stale/);
  assert.match(text, /↑ older above/);
  assert.equal(historicalRendered, 0);
});

test("preview chat uses windowed rendering before runtime tab is ready", () => {
  const smallTab = createTab(17, "s17-small", "/repo", {
    previewMessages: buildPreviewMessages(100),
  });
  const largeTab = createTab(18, "s17-large", "/repo", {
    previewMessages: buildPreviewMessages(5000),
  });

  const lines = renderAgentSurface(largeTab, undefined, WIDTH, HEIGHT);
  const text = lines.map(stripAnsi).join("\n");
  assert.equal(lines.length, HEIGHT);
  assert.match(text, /preview-4999/);
  assert.match(text, /↑ older above/);

  const smallMs = measurePreviewRenderMs(smallTab, 50);
  const largeMs = measurePreviewRenderMs(largeTab, 50);
  assert.ok(
    largeMs < smallMs * 10,
    `expected 5000-preview render to stay windowed; 5000=${largeMs.toFixed(
      3,
    )}ms 100=${smallMs.toFixed(3)}ms ratio=${(largeMs / smallMs).toFixed(1)}x`,
  );
});

test("huge preview assistant block is folded on tab switch", () => {
  const hugeTab = createTab(23, "s23-huge", "/repo", {
    previewMessages: [
      { role: "assistant", text: `huge-start\n\n${"card\n\n".repeat(20_000)}huge-end` },
    ],
  });

  const lines = renderAgentSurface(hugeTab, undefined, WIDTH, HEIGHT, undefined, DEFAULT_SURFACE_OPTIONS);
  const text = lines.map(stripAnsi).join("\n");
  assert.equal(lines.length, HEIGHT);
  assert.match(text, /Oversized provider output/);
  assert.match(text, /huge-end/);
});

function buildPreviewMessages(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    role: "assistant" as const,
    text: `preview-${index} ${"preview words wrap markdown **bold** ".repeat(30)}`,
  }));
}

test("windowed rendering scales sublinearly with block count", () => {
  // Verify that windowed rendering with 5000 blocks is not dramatically
  // slower than with 100 blocks (both use windowed path during streaming).
  const smallChat = buildPerformanceChat(100);
  const largeChat = buildPerformanceChat(5000);
  const smallTab = createTab(12, "s12", "/repo", { status: "running", chatScrollOffset: 0 });
  const largeTab = createTab(13, "s13", "/repo", { status: "running", chatScrollOffset: 0 });

  const smallMs = measureRenderMs(smallTab, smallChat, 50);
  const largeMs = measureRenderMs(largeTab, largeChat, 50);

  // Windowed rendering should make 5000 blocks at most 10x slower than 100
  // blocks (not 50x which would indicate linear scaling).
  assert.ok(
    largeMs < smallMs * 10,
    `expected 5000-block render to be within 10x of 100-block; 5000=${largeMs.toFixed(
      3,
    )}ms 100=${smallMs.toFixed(3)}ms ratio=${(largeMs / smallMs).toFixed(1)}x`,
  );
});

test("PageUp after stick-to-bottom without an idle render does not snap to the old reply", () => {
  const replyOne = Array.from(
    { length: 80 },
    (_, index) => `REPLY-ONE-${String(index).padStart(3, "0")} ${"alpha ".repeat(8)}`,
  ).join("\n");
  const replyTwo = Array.from(
    { length: 80 },
    (_, index) => `REPLY-TWO-${String(index).padStart(3, "0")} ${"beta ".repeat(8)}`,
  ).join("\n");
  const chat: ChatLine[] = [
    ...buildLongChat(64),
    { role: "user", text: "prompt-one" },
    { role: "assistant", text: replyOne },
  ];
  const tab = createTab(51, "s51", "/repo", { status: "idle", chatScrollOffset: 0 });

  renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  for (let page = 0; page < 5; page++) {
    scrollChat(tab, 10);
    renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT);
  }

  tab.chatScrollOffset = 0;
  chat.push({ role: "user", text: "prompt-two" }, { role: "assistant", text: replyTwo });
  scrollChat(tab, 3);
  const after = renderAgentSurface(tab, { chat } as never, WIDTH, HEIGHT).map(stripAnsi).join("\n");
  assert.match(after, /REPLY-TWO-/);
  assert.doesNotMatch(after, /REPLY-ONE-/);
});

test("deep scroll paint stays near bottom paint cost (no unshift O(n^2))", () => {
  // Regression: Array.unshift while assembling scrolled history made deep
  // offset paint hundreds of times slower than bottom pin for large chats.
  const chat = buildPerformanceChat(2000);
  const bottomTab = createTab(40, "s40", "/repo", { chatScrollOffset: 0 });
  const deepTab = createTab(41, "s41", "/repo", { chatScrollOffset: 1_000_000 });

  const bottomMs = measureRenderMs(bottomTab, chat, 8);
  const deepMs = measureRenderMs(deepTab, chat, 6);

  assert.ok(
    deepMs < Math.max(15, bottomMs * 40),
    `deep scroll paint too slow vs bottom; deep=${deepMs.toFixed(3)}ms bottom=${bottomMs.toFixed(
      3,
    )}ms ratio=${(deepMs / Math.max(0.001, bottomMs)).toFixed(1)}x`,
  );
});

function measurePreviewRenderMs(tab: MixCodeTabInfo, iterations: number): number {
  for (let i = 0; i < 5; i++) {
    renderAgentSurface(tab, undefined, 120, 30);
  }
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    renderAgentSurface(tab, undefined, 120, 30);
  }
  return (performance.now() - start) / iterations;
}

function measureRenderMs(
  tab: MixCodeTabInfo,
  chat: ChatLine[],
  iterations: number,
): number {
  for (let i = 0; i < 5; i++) {
    renderAgentSurface(tab, { chat } as never, 120, 30);
  }
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    renderAgentSurface(tab, { chat } as never, 120, 30);
  }
  return (performance.now() - start) / iterations;
}
