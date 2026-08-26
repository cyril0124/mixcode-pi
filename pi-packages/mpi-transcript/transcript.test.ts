import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildViewText, editorExtraArgs, formatViewText } from "./index.js";

// ─── editorExtraArgs: vim/nvim flags ─────────────────────────────────────────

test("editorExtraArgs adds readonly/no-swap/no-shada/jump-to-end flags for vim and nvim", () => {
  assert.deepEqual(editorExtraArgs("nvim"), ["-R", "-n", "-i", "NONE", "+normal G"]);
  assert.deepEqual(editorExtraArgs("/usr/bin/vim"), ["-R", "-n", "-i", "NONE", "+normal G"]);
});

test("editorExtraArgs leaves non-vim editors untouched", () => {
  assert.deepEqual(editorExtraArgs("code"), []);
  assert.deepEqual(editorExtraArgs("/usr/local/bin/emacs"), []);
});

// ─── formatViewText: markdown heading ──────────────────────────────────────────

test("formatViewText renders a markdown h1 title followed by body sections", () => {
  const text = formatViewText("Thinking Export", ["line one", "line two"]);
  assert.equal(text, "# Thinking Export\n\nline one\n\nline two");
});

test("formatViewText with a single body item has no trailing blank lines", () => {
  const text = formatViewText("Latest User Message", ["hi"]);
  assert.equal(text, "# Latest User Message\n\nhi");
});

test("formatViewText strips ANSI escape sequences from the output", () => {
  const text = formatViewText("Thinking Export", [
    "\u001b[38;2;138;190;183mThinking:\u001b[39m \u001b[38;2;128;128;128mdone\u001b[39m",
  ]);
  assert.equal(text, "# Thinking Export\n\nThinking: done");
});

test("formatViewText strips trailing spaces and tabs from every line", () => {
  const text = formatViewText("Chat Export", ["hello  \nworld\t", "> \n> keep"]);
  assert.equal(text, "# Chat Export\n\nhello\nworld\n\n>\n> keep");
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
  opts?: {
    stopReason?: string;
    errorMessage?: string;
    totalTokens?: number;
    costTotal?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
  },
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
      usage: {
        input: opts?.input ?? 0,
        output: opts?.output ?? 0,
        cacheRead: opts?.cacheRead ?? 0,
        cacheWrite: opts?.cacheWrite ?? 0,
        totalTokens: opts?.totalTokens ?? 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts?.costTotal ?? 0 },
      },
      stopReason: opts?.stopReason ?? "stop",
      errorMessage: opts?.errorMessage,
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

test("buildViewText chatlog: numbers user and assistant sections by round", () => {
  const entries: SessionEntry[] = [
    userEntry("first question"),
    assistantEntry([{ type: "text", text: "first answer" }]),
    userEntry("second question"),
    assistantEntry([{ type: "text", text: "second answer" }]),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /## 👤 User · #1\n\n_[^\n]+_\n\nfirst question/);
  assert.match(text, /## 🤖 Assistant · #1\n\n_[^\n]+_\n\nfirst answer/);
  assert.match(text, /## 👤 User · #2\n\n_[^\n]+_\n\nsecond question/);
  assert.match(text, /## 🤖 Assistant · #2\n\n_[^\n]+_\n\nsecond answer/);
});

test("buildViewText thinking: labels each block with its round", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "thinking", thinking: "first thought" }]),
    userEntry("q2"),
    assistantEntry([{ type: "thinking", thinking: "second thought" }]),
  ];
  const text = buildViewText("thinking", entries);
  assert.match(text, /\*\*Turn 1\*\*\n\nfirst thought/);
  assert.match(text, /\*\*Turn 2\*\*\n\nsecond thought/);
});

test("buildViewText chatlog: renders tool call arguments as a JSON block", () => {
  const entries: SessionEntry[] = [
    assistantEntry([
      { type: "toolCall", id: "call-3", name: "bash", arguments: { command: "git status", timeout: 60 } },
    ]),
    toolResultEntry("call-3", "clean"),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /```json\n\{\n {2}"command": "git status",\n {2}"timeout": 60\n\}\n```/);
});

test("buildViewText chatlog: omits the JSON block when arguments are empty", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-4", name: "bash", arguments: {} }]),
    toolResultEntry("call-4", "ok"),
  ];
  assert.doesNotMatch(buildViewText("chatlog", entries), /```json/);
});

function customMessageEntry(customType: string, text: string, display: boolean): SessionEntry {
  return {
    type: "custom_message",
    id: `c-${customType}-${display}`,
    parentId: null,
    timestamp: new Date().toISOString(),
    customType,
    content: text,
    display,
  } as unknown as SessionEntry;
}

test("buildViewText chatlog: renders injected custom messages, marking hidden ones", () => {
  const entries: SessionEntry[] = [
    userEntry("hi"),
    customMessageEntry("skill-loader", "skill content here", false),
    customMessageEntry("goal-tracker", "visible injected note", true),
    assistantEntry([{ type: "text", text: "ok" }]),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /## 📥 Injected · `skill-loader` · _hidden_\n\nskill content here/);
  assert.match(text, /## 📥 Injected · `goal-tracker`\n\nvisible injected note/);
  assert.match(text, /## 🤖 Assistant · #1\n\n_[^\n]+_\n\nok/);
});

test("buildViewText chatlog: renders compaction and branch summary entries", () => {
  const entries: SessionEntry[] = [
    {
      type: "compaction",
      id: "comp-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "earlier work summarized",
      firstKeptEntryId: "u-x",
      tokensBefore: 54321,
    } as unknown as SessionEntry,
    {
      type: "branch_summary",
      id: "br-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      fromId: "a-x",
      summary: "summary of the other branch",
    } as unknown as SessionEntry,
    userEntry("continue"),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /## 🗜️ Compaction · 54,321 tokens before\n\nearlier work summarized/);
  assert.match(text, /## 🌿 Branch Summary\n\nsummary of the other branch/);
});

test("buildViewText chatlog: surfaces assistant errorMessage on error stops", () => {
  const entries: SessionEntry[] = [
    userEntry("do it"),
    assistantEntry([{ type: "text", text: "partial" }], { stopReason: "error", errorMessage: "rate limited" }),
  ];
  assert.match(buildViewText("chatlog", entries), /\*\*⚠️ error\*\*: rate limited/);
});

test("buildViewText chatlog: multi-line errorMessage renders as a fenced block", () => {
  const entries: SessionEntry[] = [
    userEntry("go"),
    assistantEntry([{ type: "text", text: "partial" }], {
      stopReason: "error",
      errorMessage: "API failure\n  at request (client.ts:10)",
    }),
  ];
  assert.match(
    buildViewText("chatlog", entries),
    /\*\*⚠️ error\*\*\n\n```\nAPI failure\n  at request \(client\.ts:10\)\n```/,
  );
});

test("buildViewText chatlog: failed tool output keeps the tail, not the head", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join("\n");
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-9", name: "bash", arguments: {} }]),
    toolResultEntry("call-9", lines, true),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /_… \+5 earlier lines_\n\n```\nline6\n/);
  assert.match(text, /line25/);
  assert.doesNotMatch(text, /line5\n/);
});

test("buildViewText chatlog: renders an aborted turn even without content", () => {
  const entries: SessionEntry[] = [userEntry("go"), assistantEntry([], { stopReason: "aborted" })];
  assert.match(buildViewText("chatlog", entries), /## 🤖 Assistant · #1\n\n_[^\n]+_\n\n\*\*⚠️ aborted\*\*/);
});

test("buildViewText chatlog: renders tool calls as h3 headings", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-6", name: "bash", arguments: {} }]),
    toolResultEntry("call-6", "done"),
  ];
  assert.match(buildViewText("chatlog", entries), /### 🔧 Tool: `bash` — ✅ success\n/);
});

test("buildViewText chatlog: tool call without a paired result shows no result", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-5", name: "bash", arguments: {} }]),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /🔧 Tool: `bash`[\s\S]*⏳ no result/);
  assert.doesNotMatch(text, /✅ success/);
});

test("buildViewText chatlog: lastTurns keeps only the last N rounds with global numbering", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "text", text: "a1" }]),
    userEntry("q2"),
    assistantEntry([{ type: "text", text: "a2" }]),
    userEntry("q3"),
    assistantEntry([{ type: "text", text: "a3" }]),
  ];
  const text = buildViewText("chatlog", entries, 2);
  assert.doesNotMatch(text, /q1|a1/);
  assert.match(text, /_… earlier 1 turn omitted_/);
  assert.match(text, /## 👤 User · #2\n\n_[^\n]+_\n\nq2/);
  assert.match(text, /## 🤖 Assistant · #3\n\n_[^\n]+_\n\na3/);
});

test("buildViewText chatlog: lastTurns >= total rounds renders everything without a notice", () => {
  const entries: SessionEntry[] = [userEntry("q1"), assistantEntry([{ type: "text", text: "a1" }])];
  const text = buildViewText("chatlog", entries, 5);
  assert.match(text, /## 👤 User · #1\n\n_[^\n]+_\n\nq1/);
  assert.doesNotMatch(text, /omitted/);
});

test("buildViewText thinking: lastTurns keeps only thinking from the last N rounds", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "thinking", thinking: "old thought" }]),
    userEntry("q2"),
    assistantEntry([{ type: "thinking", thinking: "new thought" }]),
  ];
  const text = buildViewText("thinking", entries, 1);
  assert.doesNotMatch(text, /old thought/);
  assert.match(text, /\*\*Turn 2\*\*\n\nnew thought/);
});

test("buildViewText chatlog: truncates long tool output to 20 lines with a notice", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join("\n");
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-7", name: "bash", arguments: {} }]),
    toolResultEntry("call-7", lines),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /line20/);
  assert.doesNotMatch(text, /line21/);
  assert.match(text, /_… \+5 more lines_/);
});

test("buildViewText chatlog: tool output containing fences gets a longer fence", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-8", name: "bash", arguments: {} }]),
    toolResultEntry("call-8", "before\n```js\ncode\n```\nafter"),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /````\nbefore\n```js\ncode\n```\nafter\n````/);
});

test("buildViewText context: renders context entries as chatlog sections under its own title", () => {
  // Simulates buildContextEntries() output: compaction summary + kept tail.
  const entries: SessionEntry[] = [
    {
      type: "compaction",
      id: "comp-2",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "summary of dropped history",
      firstKeptEntryId: "u-kept",
      tokensBefore: 1000,
    } as unknown as SessionEntry,
    userEntry("kept question"),
    assistantEntry([{ type: "text", text: "kept answer" }]),
  ];
  const text = buildViewText("context", entries);
  assert.match(text, /^# LLM Context\n/);
  assert.match(text, /## 🗜️ Compaction · 1,000 tokens before\n\nsummary of dropped history/);
  assert.match(text, /## 👤 User · #1\n\n_[^\n]+_\n\nkept question/);
});

test("buildViewText chatlog: renders a placeholder for image content", () => {
  const entries: SessionEntry[] = [
    {
      type: "message",
      id: "u-img",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: {
        role: "user",
        content: [
          { type: "text", text: "look at this" },
          { type: "image", data: "...", mimeType: "image/png" },
        ],
        timestamp: Date.now(),
      },
    } as unknown as SessionEntry,
  ];
  assert.match(buildViewText("chatlog", entries), /look at this\n🖼️ \[image\]/);
});

test("buildViewText chatlog: renders model and thinking level change events", () => {
  const entries: SessionEntry[] = [
    {
      type: "model_change",
      id: "m-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      provider: "anthropic",
      modelId: "claude-x",
    } as unknown as SessionEntry,
    {
      type: "thinking_level_change",
      id: "t-1",
      parentId: null,
      timestamp: new Date().toISOString(),
      thinkingLevel: "high",
    } as unknown as SessionEntry,
    userEntry("hi"),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /_⚙️ model → anthropic\/claude-x_/);
  assert.match(text, /_⚙️ thinking → high_/);
});

test("buildViewText chatlog: assistant meta line shows model, tokens, cost, and time", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { totalTokens: 8432, costTotal: 0.021 }),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(
    text,
    /## 🤖 Assistant · #1\n\n_anthropic\/test · 8,432 tok · \$0\.0210 · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}_\n\na/,
  );
});

test("buildViewText chatlog: shows used/window in k units with percentage when a window is known", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { totalTokens: 8432, costTotal: 0.021 }),
  ];
  const text = buildViewText("chatlog", entries, undefined, (provider, modelId) =>
    provider === "anthropic" && modelId === "test" ? 200000 : undefined,
  );
  assert.match(text, /8\.4k\/200k \(4\.2%\)/);
});

test("buildViewText chatlog: meta line shows cache hit rate when caching was used", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { input: 1000, cacheRead: 9000, cacheWrite: 0 }),
  ];
  assert.match(buildViewText("chatlog", entries), /cache 90\.0%/);
});

test("buildViewText chatlog: meta line shows raw prompt-in and completion-out tokens", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { input: 1000, cacheRead: 9000, output: 500 }),
  ];
  assert.match(buildViewText("chatlog", entries), /in 10,000 · out 500/);
});

test("buildViewText chatlog: meta line shows the prompt-in delta from the previous turn", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "text", text: "a1" }], { input: 10000, output: 200 }),
    userEntry("q2"),
    assistantEntry([{ type: "text", text: "a2" }], { input: 12000, output: 300 }),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /in 10,000 · out 200/);
  assert.doesNotMatch(text, /in 10,000 \(/);
  assert.match(text, /in 12,000 \(\+2,000\) · out 300/);
});

test("buildViewText chatlog: meta line omits cache rate when no cache tokens", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { input: 1000 }),
  ];
  assert.doesNotMatch(buildViewText("chatlog", entries), /cache /);
});

test("buildViewText chatlog: marks a failed tool result as error", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }]),
    toolResultEntry("call-2", "command not found", true),
  ];
  assert.match(buildViewText("chatlog", entries), /🔧 Tool: `bash`[\s\S]*❌ error[\s\S]*command not found/);
});
