import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import {
  buildViewText,
  type ContextPrefix,
  editorExtraArgs,
  estimateContextSize,
  formatViewText,
  NVIM_TRANSCRIPT_LUA,
} from "./index.js";

// ─── editorExtraArgs: vim/nvim flags ─────────────────────────────────────────

test("editorExtraArgs adds readonly/no-swap/no-shada/jump-to-end flags for vim and nvim", () => {
  assert.deepEqual(editorExtraArgs("nvim"), ["-R", "-n", "-i", "NONE", "+normal G"]);
  assert.deepEqual(editorExtraArgs("/usr/bin/vim"), ["-R", "-n", "-i", "NONE", "+normal G"]);
});

test("editorExtraArgs leaves non-vim editors untouched", () => {
  assert.deepEqual(editorExtraArgs("code"), []);
  assert.deepEqual(editorExtraArgs("/usr/local/bin/emacs"), []);
});

test("editorExtraArgs sources transcript lua only for nvim", () => {
  assert.deepEqual(editorExtraArgs("nvim", "/tmp/t.lua"), [
    "-R",
    "-n",
    "-i",
    "NONE",
    "+normal G",
    "-c",
    "luafile /tmp/t.lua",
  ]);
  assert.deepEqual(editorExtraArgs("/usr/bin/vim", "/tmp/t.lua"), [
    "-R",
    "-n",
    "-i",
    "NONE",
    "+normal G",
  ]);
});

const nvimAvailable = spawnSync("nvim", ["--version"], { encoding: "utf8" }).status === 0;

test("nvim transcript lua sets wrap/conceal, heading winbar, and heading matches", {
  skip: nvimAvailable ? false : "nvim not on PATH",
}, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-nvim-"));
  try {
    const md = path.join(dir, "t.md");
    const lua = path.join(dir, "t.lua");
    await fs.writeFile(
      md,
      [
        "# LLM Context",
        "",
        "---",
        "",
        "## 👤 User · #1",
        "",
        "_2026-08-26 10:00:00_",
        "",
        "q",
        "",
        "---",
        "",
        "## 🤖 Assistant · #1",
        "",
        "_anthropic/test · 12s · 2026-08-26 10:00:12_",
        "",
        "hello",
        "",
        "## Fake heading from the model",
        "",
        "```js",
        "decoy",
        "still",
        "```",
        "",
        "### 🔧 Tool: bash — ✅ success",
        "",
        "```json",
        "{",
        '  "cmd": "x"',
        "}",
        "```",
        "",
        "```text",
        "world",
        "more",
        "```",
        "",
        "### 📘 Skill: sample — ✅ success",
        "",
        "_/tmp/skills/sample/SKILL.md_",
        "",
        "Does things.",
        "",
        "# Sample Body",
        "",
        "after tool prose",
        "",
        "```js",
        "nope",
        "stillnope",
        "```",
        "",
      ].join("\n"),
    );
    await fs.writeFile(lua, NVIM_TRANSCRIPT_LUA);
    const dump = path.join(dir, "dump.lua");
    await fs.writeFile(
      dump,
      [
        "local lines = vim.api.nvim_buf_get_lines(0, 0, -1, false)",
        "local function line_of(text)",
        "  for i, l in ipairs(lines) do if l == text then return i end end",
        "  return -1",
        "end",
        'local fake = line_of("## Fake heading from the model")',
        'local ft = vim.fn.foldtextresult(line_of("world"))',
        'local ftin = vim.fn.foldtextresult(line_of("{"))',
        'local dimns = vim.api.nvim_get_namespaces()["mpi_transcript_dim"]',
        "local dmarks = dimns and vim.api.nvim_buf_get_extmarks(0, dimns, 0, -1, { details = true }) or {}",
        "local nconceal = 0",
        'for _, m in ipairs(dmarks) do if m[4] and m[4].conceal == "" then nconceal = nconceal + 1 end end',
        'vim.api.nvim_win_set_cursor(0, { line_of("hello"), 0 })',
        'vim.cmd("normal [t")',
        "local jumped = vim.api.nvim_win_get_cursor(0)[1]",
        "vim.api.nvim_win_set_cursor(0, { fake, 0 })",
        'vim.api.nvim_exec_autocmds("CursorMoved", { buffer = 0 })',
        "local stc = vim.wo.statuscolumn",
        "local function col(l) return vim.api.nvim_eval_statusline(stc, { use_statuscol_lnum = l }).str end",
        'local stc_h = col(line_of("## 🤖 Assistant · #1"))',
        'local stc_s = col(line_of("### 📘 Skill: sample — ✅ success"))',
        'local stc_b = col(line_of("hello"))',
        "local span = _G.MpiTranscriptTurn",
        "io.stdout:write(table.concat({",
        "  tostring(vim.wo.conceallevel), tostring(vim.wo.wrap), tostring(vim.wo.linebreak),",
        "  vim.wo.winbar, tostring(vim.tbl_count(vim.fn.getmatches())), vim.wo.foldmethod,",
        '  tostring(vim.fn.foldclosed(line_of("world"))),',
        '  tostring(vim.fn.foldclosed(line_of("decoy"))),',
        '  tostring(vim.fn.foldclosed(line_of("nope"))),',
        '  stc_h, tostring(span.s), tostring(line_of("## 🤖 Assistant · #1")),',
        '  tostring(span.e), tostring(line_of("## Fake heading from the model")),',
        '  ft, ftin, tostring(jumped), tostring(line_of("## 🤖 Assistant · #1")), tostring(nconceal),',
        "  stc_b, stc_s",
        "}, string.char(10)))",
      ].join("\n"),
    );
    const r = spawnSync(
      "nvim",
      [
        "--headless",
        "-u",
        "NONE",
        "-n",
        md,
        "+normal G",
        "-c",
        `luafile ${lua}`,
        "-c",
        `luafile ${dump}`,
        "-c",
        "qa",
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.error?.message ?? r.stderr);
    const out = r.stdout.trim().split("\n");
    assert.equal(out[0], "2");
    assert.equal(out[1], "true");
    assert.equal(out[2], "true");
    assert.match(out[3] ?? "", /Assistant · #1/);
    assert.match(out[3] ?? "", /12s/);
    assert.match(out[3] ?? "", /\[t/);
    assert.doesNotMatch(out[3] ?? "", /Fake/);
    assert.equal(out[4], "7");
    assert.equal(out[5], "manual");
    assert.notEqual(out[6], "-1");
    assert.equal(out[7], "-1");
    assert.equal(out[8], "-1");
    // Statuscolumn renders the role mark itself (no native signs): heading
    // rows carry the two-cell mark, body rows a two-space placeholder.
    assert.match(out[9] ?? "", /^A [│ ]\d+ $/);
    // stdout.trim() strips the final line's trailing pad space.
    assert.match(out[19] ?? "", /^ {2}[│ ]\d+ ?$/);
    // Skill headings carry their own S gutter mark (Question highlight).
    assert.match(out[20] ?? "", /^S [│ ]\d+ ?$/);
    assert.equal(out[10], out[11]);
    assert.ok(Number(out[12]) >= Number(out[13]));
    assert.match(out[14] ?? "", /bash/);
    assert.match(out[14] ?? "", /out/);
    assert.match(out[15] ?? "", /bash/);
    assert.match(out[15] ?? "", /in/);
    assert.equal(out[16], out[17]);
    assert.ok(Number(out[18]) >= 2);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
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

function userEntry(text: string, at?: string): SessionEntry {
  return {
    type: "message",
    id: `u-${text}`,
    parentId: null,
    timestamp: at ?? new Date().toISOString(),
    message: { role: "user", content: text, timestamp: Date.now() },
  } as unknown as SessionEntry;
}

function assistantEntry(
  content: Array<{
    type: string;
    text?: string;
    thinking?: string;
    redacted?: boolean;
    id?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  }>,
  opts?: {
    stopReason?: string;
    errorMessage?: string;
    totalTokens?: number;
    costTotal?: number;
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    at?: string;
  },
): SessionEntry {
  return {
    type: "message",
    id: `a-${Math.random()}`,
    parentId: null,
    timestamp: opts?.at ?? new Date().toISOString(),
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
  assert.match(text, /🔧 Tool: bash[\s\S]*✅ success[\s\S]*all tests passed/);
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
      {
        type: "toolCall",
        id: "call-3",
        name: "bash",
        arguments: { command: "git status", timeout: 60 },
      },
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
  assert.match(text, /## 📦 Compaction · 54,321 tokens before\n\nearlier work summarized/);
  assert.match(text, /## 🌿 Branch Summary\n\nsummary of the other branch/);
});

test("buildViewText chatlog: surfaces assistant errorMessage on error stops", () => {
  const entries: SessionEntry[] = [
    userEntry("do it"),
    assistantEntry([{ type: "text", text: "partial" }], {
      stopReason: "error",
      errorMessage: "rate limited",
    }),
  ];
  assert.match(buildViewText("chatlog", entries), /\*\*❗ error\*\*: rate limited/);
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
    /\*\*❗ error\*\*\n\n```\nAPI failure\n {2}at request \(client\.ts:10\)\n```/,
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
  assert.match(
    buildViewText("chatlog", entries),
    /## 🤖 Assistant · #1\n\n_[^\n]+_\n\n\*\*❗ aborted\*\*/,
  );
});

test("buildViewText chatlog: renders tool calls as h3 headings", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-6", name: "bash", arguments: {} }]),
    toolResultEntry("call-6", "done"),
  ];
  assert.match(buildViewText("chatlog", entries), /### 🔧 Tool: bash — ✅ success\n/);
});

test("buildViewText chatlog: tool call without a paired result shows no result", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-5", name: "bash", arguments: {} }]),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /🔧 Tool: bash[\s\S]*⏳ no result/);
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
  const text = buildViewText("chatlog", entries, { lastTurns: 2 });
  assert.doesNotMatch(text, /q1|a1/);
  assert.match(text, /_… earlier 1 turn omitted_/);
  assert.match(text, /## 👤 User · #2\n\n_[^\n]+_\n\nq2/);
  assert.match(text, /## 🤖 Assistant · #3\n\n_[^\n]+_\n\na3/);
});

test("buildViewText chatlog: lastTurns >= total rounds renders everything without a notice", () => {
  const entries: SessionEntry[] = [userEntry("q1"), assistantEntry([{ type: "text", text: "a1" }])];
  const text = buildViewText("chatlog", entries, { lastTurns: 5 });
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
  const text = buildViewText("thinking", entries, { lastTurns: 1 });
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

test("buildViewText chatlog: fullToolOutput renders every line without a truncation notice", () => {
  const lines = Array.from({ length: 25 }, (_, i) => `line${i + 1}`).join("\n");
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-10", name: "bash", arguments: {} }]),
    toolResultEntry("call-10", lines),
  ];
  const text = buildViewText("chatlog", entries, { fullToolOutput: true });
  assert.match(text, /line1\n/);
  assert.match(text, /line25/);
  assert.doesNotMatch(text, /more lines|earlier lines/);
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
  assert.match(text, /## 📦 Compaction · 1,000 tokens before\n\nsummary of dropped history/);
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
  assert.match(buildViewText("chatlog", entries), /look at this\n📷 \[image\]/);
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
  assert.match(text, /_🔄 model → anthropic\/claude-x_/);
  assert.match(text, /_🔄 thinking → high_/);
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
  const text = buildViewText("chatlog", entries, {
    contextWindowFor: (provider, modelId) =>
      provider === "anthropic" && modelId === "test" ? 200000 : undefined,
  });
  assert.match(text, /8\.4k\/200k \(4\.2%\)/);
});

test("buildViewText chatlog: meta line shows cache hit rate when caching was used", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { input: 1000, cacheRead: 9000, cacheWrite: 0 }),
  ];
  assert.match(buildViewText("chatlog", entries), /cache 90\.0%/);
});

test("buildViewText chatlog: meta line shows uncached-in and completion-out tokens", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { input: 1000, cacheRead: 9000, output: 500 }),
  ];
  assert.match(buildViewText("chatlog", entries), /in 1,000 · out 500/);
});

test("buildViewText chatlog: context tokens carry the delta from the previous turn", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "text", text: "a1" }], { totalTokens: 10000 }),
    userEntry("q2"),
    assistantEntry([{ type: "text", text: "a2" }], { totalTokens: 12000 }),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /10,000 tok · /);
  assert.doesNotMatch(text, /10,000 tok \(/);
  assert.match(text, /12,000 tok \(\+2,000\)/);
});

test("buildViewText chatlog: context delta joins the percentage when a window is known", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "text", text: "a1" }], { totalTokens: 10000 }),
    userEntry("q2"),
    assistantEntry([{ type: "text", text: "a2" }], { totalTokens: 12000 }),
  ];
  const text = buildViewText("chatlog", entries, { contextWindowFor: () => 200000 });
  assert.match(text, /10k\/200k \(5\.0%\)/);
  assert.match(text, /12k\/200k \(6\.0%, \+2,000\)/);
});

test("buildViewText chatlog: meta line omits cache rate when no cache tokens", () => {
  const entries: SessionEntry[] = [
    userEntry("q"),
    assistantEntry([{ type: "text", text: "a" }], { input: 1000 }),
  ];
  assert.doesNotMatch(buildViewText("chatlog", entries), /cache /);
});

test("buildViewText chatlog: flags a significant cache miss only on the paying assistant turn", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    // Seeds the cache: 150k prompt tokens written.
    assistantEntry([{ type: "text", text: "a1" }], { cacheWrite: 150000 }),
    userEntry("q2"),
    // Re-bills 145k prompt tokens with only 5k read back → 140k missed.
    assistantEntry([{ type: "text", text: "a2" }], { input: 140000, cacheRead: 5000 }),
  ];
  const text = buildViewText("chatlog", entries, {
    priceSource: { getModel: () => ({ cost: { cacheRead: 0.3 } }) },
  });
  assert.match(text, /\*\*❗ Cache miss: 140k tokens re-billed\*\*/);
  assert.equal(text.match(/Cache miss/g)?.length, 1);
});

test("buildViewText chatlog: omits cache-miss notices without a price source", () => {
  const entries: SessionEntry[] = [
    userEntry("q1"),
    assistantEntry([{ type: "text", text: "a1" }], { cacheWrite: 150000 }),
    userEntry("q2"),
    assistantEntry([{ type: "text", text: "a2" }], { input: 140000, cacheRead: 5000 }),
  ];
  assert.doesNotMatch(buildViewText("chatlog", entries), /Cache miss/);
});

test("buildViewText chatlog: meta line shows the elapsed time since the previous message", () => {
  const entries: SessionEntry[] = [
    userEntry("q", "2026-08-26T10:00:00.000Z"),
    assistantEntry([{ type: "text", text: "a" }], { at: "2026-08-26T10:00:12.000Z" }),
    userEntry("q2", "2026-08-26T10:05:00.000Z"),
    assistantEntry([{ type: "text", text: "b" }], { at: "2026-08-26T10:01:23.000Z" }),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /· 12s · /);
  // Clock going backwards (entry 4 predates entry 3) must not render a duration.
  assert.doesNotMatch(text, /· -/);
});

test("buildViewText chatlog: no duration on the first assistant turn without a prior message", () => {
  const entries: SessionEntry[] = [assistantEntry([{ type: "text", text: "a" }])];
  assert.doesNotMatch(buildViewText("chatlog", entries), /s · \d{4}-/);
});

test("buildViewText chatlog: marks a failed tool result as error", () => {
  const entries: SessionEntry[] = [
    assistantEntry([{ type: "toolCall", id: "call-2", name: "bash", arguments: {} }]),
    toolResultEntry("call-2", "command not found", true),
  ];
  assert.match(
    buildViewText("chatlog", entries),
    /🔧 Tool: bash[\s\S]*❌ error[\s\S]*command not found/,
  );
});

// ─── Skill reads: read of SKILL.md renders a skill card ────────────────────

function skillFile(frontmatter: string, body: string): string {
  return `---\n${frontmatter}\n---\n\n${body}`;
}

function readCall(id: string, filePath: string): Parameters<typeof assistantEntry>[0][number] {
  return { type: "toolCall", id, name: "read", arguments: { file_path: filePath } };
}

test("buildViewText chatlog: successful SKILL.md read renders a skill card, not a generic tool block", () => {
  const entries: SessionEntry[] = [
    assistantEntry([readCall("call-sk1", "/home/u/.agents/skills/simple-plan/SKILL.md")]),
    toolResultEntry(
      "call-sk1",
      skillFile(
        "name: simple-plan\ndescription: Write complete plans",
        "# Simple Plan\n\nbody line",
      ),
    ),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /### 📘 Skill: simple-plan — ✅ success/);
  assert.match(text, /_\/home\/u\/\.agents\/skills\/simple-plan\/SKILL\.md_/);
  assert.match(text, /Write complete plans/);
  assert.match(text, /# Simple Plan\n\nbody line/);
  // Args JSON is redundant with the path line; the raw file dump is replaced.
  assert.doesNotMatch(text, /```json/);
  assert.doesNotMatch(text, /🔧 Tool: read/);
});

test("buildViewText chatlog: skill body keeps the 20-line cap with a notice; full uncaps", () => {
  const body = Array.from({ length: 25 }, (_, i) => `body${i + 1}`).join("\n");
  const entries: SessionEntry[] = [
    assistantEntry([readCall("call-sk2", "/skills/big/SKILL.md")]),
    toolResultEntry("call-sk2", skillFile("name: big", body)),
  ];
  const cut = buildViewText("chatlog", entries);
  assert.match(cut, /body20/);
  assert.doesNotMatch(cut, /body21/);
  assert.match(cut, /_… \+5 more lines_/);
  const full = buildViewText("chatlog", entries, { fullToolOutput: true });
  assert.match(full, /body25/);
  assert.doesNotMatch(full, /more lines/);
});

test("buildViewText chatlog: failed SKILL.md read keeps the generic tool rendering", () => {
  const entries: SessionEntry[] = [
    assistantEntry([readCall("call-sk3", "/skills/lost/SKILL.md")]),
    toolResultEntry("call-sk3", "Error: ENOENT", true),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /### 🔧 Tool: read — ❌ error/);
  assert.match(text, /```json/);
  assert.doesNotMatch(text, /📘/);
});

test("buildViewText chatlog: SKILL.md read without frontmatter keeps the generic tool rendering", () => {
  const entries: SessionEntry[] = [
    assistantEntry([readCall("call-sk4", "/skills/raw/SKILL.md")]),
    toolResultEntry("call-sk4", "# just markdown"),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /🔧 Tool: read/);
  assert.match(text, /```json/);
});

test("buildViewText chatlog: ordinary read of a non-SKILL file keeps the generic rendering", () => {
  const entries: SessionEntry[] = [
    assistantEntry([readCall("call-r1", "/src/index.ts")]),
    toolResultEntry("call-r1", "const x = 1;"),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /### 🔧 Tool: read — ✅ success/);
  assert.match(text, /```json/);
});

test("buildViewText chatlog: folded multiline description joins into one paragraph; name falls back to the directory", () => {
  const entries: SessionEntry[] = [
    assistantEntry([readCall("call-sk5", "/skills/my-skill/SKILL.md")]),
    toolResultEntry("call-sk5", skillFile("description: first\n  second continued", "body")),
  ];
  const text = buildViewText("chatlog", entries);
  assert.match(text, /### 📘 Skill: my-skill — ✅ success/);
  assert.match(text, /first second continued/);
});

// ─── Context size estimate ───────────────────────────────────────────────────

const NO_TOOLS: ContextPrefix = { systemPrompt: "", tools: [] };

test("estimateContextSize counts the compaction summary, not just surviving messages", () => {
  const summary = "s".repeat(4000); // 1000 tokens at chars/4
  const entries: SessionEntry[] = [
    {
      type: "compaction",
      id: "comp-size",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary,
      firstKeptEntryId: "u-kept",
      tokensBefore: 152_000,
    } as unknown as SessionEntry,
    userEntry("kept"),
  ];

  const estimate = estimateContextSize(entries, NO_TOOLS);
  // A compaction entry is not a message entry; counting entries directly would
  // drop the summary — the single largest item in a freshly compacted context.
  assert.ok(estimate.messages >= 1000, `summary not counted: ${estimate.messages}`);
  assert.equal(estimate.messageCount, 2);
});

test("estimateContextSize ignores stale pre-compaction usage on kept messages", () => {
  const entries: SessionEntry[] = [
    {
      type: "compaction",
      id: "comp-stale",
      parentId: null,
      timestamp: new Date().toISOString(),
      summary: "short summary",
      firstKeptEntryId: "u-kept",
      tokensBefore: 152_000,
    } as unknown as SessionEntry,
    // Survived the cut, so it still reports the pre-compaction context size.
    assistantEntry([{ type: "text", text: "brief reply" }], { totalTokens: 152_000 }),
  ];

  // Seeding from that usage would report ~152k for a context that is now tiny.
  assert.ok(estimateContextSize(entries, NO_TOOLS).total < 1000);
});

test("estimateContextSize adds the system prompt and tool schemas to the message total", () => {
  const entries: SessionEntry[] = [userEntry("hi")];
  const tools = [
    { name: "read", description: "Read a file", parameters: { type: "object", properties: {} } },
  ] as unknown as ContextPrefix["tools"];

  const bare = estimateContextSize(entries, NO_TOOLS);
  const withPrefix = estimateContextSize(entries, { systemPrompt: "p".repeat(4000), tools });

  assert.equal(bare.systemPrompt, 0);
  assert.equal(bare.tools, 0);
  assert.equal(withPrefix.systemPrompt, 1000);
  assert.ok(withPrefix.tools > 0);
  assert.equal(withPrefix.messages, bare.messages);
  assert.equal(withPrefix.total, 1000 + withPrefix.tools + bare.messages);
});

test("context view reports full context size even when the display is cut to N turns", () => {
  const entries: SessionEntry[] = [
    userEntry("one"),
    assistantEntry([{ type: "text", text: "first" }]),
    userEntry("two"),
    assistantEntry([{ type: "text", text: "second" }]),
  ];
  const prefix: ContextPrefix = { systemPrompt: "sys", tools: [] };

  const full = buildViewText("context", entries, { contextPrefix: prefix });
  const cut = buildViewText("context", entries, { contextPrefix: prefix, lastTurns: 1 });
  const sizeLine = /_~\d[\d.k]*(?:\/[\d.k]+ \([\d.]+%\))? estimated — .* across (\d+) messages_/;

  const fullMatch = full.match(sizeLine);
  const cutMatch = cut.match(sizeLine);
  assert.ok(fullMatch, "context view is missing the size line");
  // The cut hides rounds from the reader; the model still receives all of them.
  assert.equal(cutMatch?.[1], fullMatch[1]);
  assert.match(cut, /earlier 1 turn omitted/);

  // Other targets keep their existing header.
  assert.doesNotMatch(buildViewText("chatlog", entries, { contextPrefix: prefix }), sizeLine);
});
