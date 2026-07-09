import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildViewText, formatViewText } from "../pi-packages/mpi-chat-view/index.ts";

// ─── formatViewText: markdown heading ──────────────────────────────────────────

test("formatViewText renders a markdown h1 title followed by body sections", () => {
  const text = formatViewText("Thinking Export", ["line one", "line two"]);
  assert.equal(text, "# Thinking Export\n\nline one\n\nline two");
});

test("formatViewText with a single body item has no trailing blank lines", () => {
  const text = formatViewText("Latest User Message", ["hi"]);
  assert.equal(text, "# Latest User Message\n\nhi");
});

// ─── buildViewText: session-branch reconstruction ──────────────────────────────

function userEntry(text: string): SessionEntry {
  return {
    type: "message",
    id: `u-${text}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  } as unknown as SessionEntry;
}

function assistantEntry(
  content: Array<{ type: string; text?: string; thinking?: string; redacted?: boolean; id?: string; name?: string; arguments?: Record<string, unknown> }>,
): SessionEntry {
  return {
    type: "message",
    id: `a-${Math.random()}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "assistant",
      content,
      api: "messages",
      provider: "anthropic",
      model: "test",
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop",
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

function toolResultEntry(toolCallId: string, text: string, isError = false): SessionEntry {
  return {
    type: "message",
    id: `r-${toolCallId}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    message: {
      role: "toolResult",
      toolCallId,
      toolName: "bash",
      content: [{ type: "text", text }],
      isError,
      timestamp: Date.now(),
    },
  } as unknown as SessionEntry;
}

test("buildViewText thinking: collects all thinking blocks in order", () => {
  const entries: SessionEntry[] = [
    userEntry("hi"),
    assistantEntry([
      { type: "thinking", thinking: "first thought" },
      { type: "text", text: "answer" },
    ]),
    assistantEntry([{ type: "thinking", thinking: "second thought" }]),
  ];
  const text = buildViewText("thinking", entries);
  assert.match(text, /first thought[\s\S]*second thought/);
});

test("buildViewText thinking: redacted blocks render a placeholder", () => {
  const entries: SessionEntry[] = [assistantEntry([{ type: "thinking", redacted: true }])];
  assert.match(buildViewText("thinking", entries), /\[Reasoning redacted\]/);
});

test("buildViewText thinking: empty branch yields the placeholder", () => {
  assert.match(buildViewText("thinking", []), /No thinking entries\./);
});

test("buildViewText latest-agent: returns the last assistant text reply", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "text", text: "first answer" }]),
    userEntry("follow up"),
    assistantEntry([{ type: "text", text: "second answer" }]),
  ];
  assert.match(buildViewText("latest-agent", entries), /second answer/);
});

test("buildViewText latest-agent: skips thinking-only turns to find the last text", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "text", text: "real answer" }]),
    assistantEntry([{ type: "thinking", thinking: "no visible text here" }]),
  ];
  assert.match(buildViewText("latest-agent", entries), /real answer/);
});

test("buildViewText latest-user: returns the last user message", () => {
  const entries: SessionEntry[] = [
    userEntry("first question"),
    assistantEntry([{ type: "text", text: "reply" }]),
    userEntry("second question"),
  ];
  assert.match(buildViewText("latest-user", entries), /second question/);
});

test("buildViewText chatlog: renders user/assistant/thinking/tool lines with paired results", () => {
  const entries: SessionEntry[] = [
    userEntry("run the tests"),
    assistantEntry([
      { type: "thinking", thinking: "let me run it" },
      { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
    ]),
    toolResultEntry("call-1", "all tests passed"),
    assistantEntry([{ type: "text", text: "Tests passed." }]),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /## 👤 User[\s\S]*run the tests/);
  assert.match(text, /💭 Thinking[\s\S]*let me run it/);
  assert.match(text, /🔧 Tool: `bash`[\s\S]*✅ success[\s\S]*all tests passed/);
  assert.match(text, /## 🤖 Assistant[\s\S]*Tests passed\./);
});

test("buildViewText chatlog: marks a failed tool result as error", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }]),
    toolResultEntry("call-2", "command not found", true),
  ];
  assert.match(buildViewText("chatlog", entries), /🔧 Tool: `bash`[\s\S]*❌ error[\s\S]*command not found/);
});
