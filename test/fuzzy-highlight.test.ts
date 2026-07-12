import assert from "node:assert/strict";
import { test } from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { fuzzyMatchAllPositions, fuzzyMatchPositions, substringMatchPositions } from "../src/core/fuzzy.js";
import {
  createSessionSelectorState,
  updateSessionSelectorQuery,
} from "../src/core/session-selector.js";
import {
  createInitialState,
  createPicker,
  createTab,
  openCommandPalette,
  openTabJump,
  renderCommandPalette,
  renderPickerOverlay,
  renderTabJumpOverlay,
  stripAnsi,
  updateCommandPaletteQuery,
  updatePickerQuery,
  updateTabJumpQuery,
} from "../src/index.js";
import { highlightRanges } from "../src/ui/rendering/highlight.js";
import { renderSessionSelector } from "../src/ui/session-selector.js";

test("fuzzyMatchPositions finds a greedy leftmost subsequence, or [] when it doesn't fully match", () => {
  assert.deepEqual(fuzzyMatchPositions("mc", "MixCode"), [0, 3]);
  assert.deepEqual(fuzzyMatchPositions("", "abc"), []);
  assert.deepEqual(fuzzyMatchPositions("xyz", "abc"), []);
  // Greedy: the first "a" is claimed at the earliest position, not held back
  // in case a later "a" would give a tighter run -- this mirrors pi-tui's
  // own single-pass fuzzyMatch scan.
  assert.deepEqual(fuzzyMatchPositions("ab", "aab"), [0, 2]);
});

test("fuzzyMatchAllPositions unions positions across whitespace tokens, all-or-nothing per token", () => {
  assert.deepEqual(fuzzyMatchAllPositions("mc od", "MixCode"), [0, 3, 4, 5]);
  // "zz" doesn't match at all -> the whole query fails, even though "mc" alone would.
  assert.deepEqual(fuzzyMatchAllPositions("mc zz", "MixCode"), []);
  assert.deepEqual(fuzzyMatchAllPositions("   ", "MixCode"), []);
});

test("substringMatchPositions finds a contiguous case-insensitive run", () => {
  assert.deepEqual(substringMatchPositions("wor", "Hello World"), [6, 7, 8]);
  assert.deepEqual(substringMatchPositions("zz", "Hello World"), []);
  assert.deepEqual(substringMatchPositions("", "Hello World"), []);
  // Substring search is not fuzzy: a non-contiguous query must not match,
  // even though it would as a fuzzy subsequence.
  assert.deepEqual(substringMatchPositions("ah", "alpha"), []);
  assert.deepEqual(substringMatchPositions("ph", "alpha"), [2, 3]);
});

test("highlightRanges groups consecutive positions into one styled span and leaves gaps to styleRest", () => {
  const result = highlightRanges(
    "abcdef",
    [1, 2, 4],
    (s) => `<${s}>`,
    (s) => `[${s}]`,
  );
  assert.equal(result, "[a]<bc>[d]<e>[f]");
  // Default styleRest is the identity function.
  assert.equal(highlightRanges("abc", [], (s) => `<${s}>`), "abc");
});

test("command palette highlights matched query characters in label and command columns only", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  openCommandPalette(state);
  updateCommandPaletteQuery(state, "thinking");
  const lines = renderCommandPalette(state, 160);
  assert.match(
    stripAnsi(lines.join("\n")),
    /Choose Thinking Tier[\s\S]*\/thinking[\s\S]*Choose the current tab thinking tier/,
  );
  // Scope the assertion to the /thinking row (the query "thinking" also matches
  // the /hide-thinking row, whose bold spans are irrelevant here). On that row
  // "thinking" appears in the label ("Choose Thinking Tier"), the command
  // ("/thinking"), AND the description ("...thinking tier"). The description
  // column never participates in the palette filter, so it must render as
  // static dim text: exactly two bold-open spans (label + command), never three.
  const thinkingRow = lines.find((line) => stripAnsi(line).includes("Choose Thinking Tier"));
  assert.ok(thinkingRow, "palette renders the /thinking row");
  assert.equal((thinkingRow.match(/\x1b\[1m/g) ?? []).length, 2);
});

test("tab jump highlights matched characters in the tab title", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { alias: "alpha" }));
  openTabJump(state);
  updateTabJumpQuery(state, "al");
  const raw = renderTabJumpOverlay(state, 80).join("\n");
  assert.match(stripAnsi(raw), /alpha/);
  assert.match(raw, /\x1b\[1m/);
});

test("pickers highlight matched characters in the label using the same non-tokenized match as the filter", () => {
  const state = createInitialState("/repo");
  state.model = { ...state.model, reasoning: true, thinkingLevelMap: { xhigh: "xhigh" } };
  state.picker = createPicker("thinking", state);
  updatePickerQuery(state.picker, "xh");
  const raw = renderPickerOverlay(state, 80).join("\n");
  assert.match(stripAnsi(raw), /xhigh/);
  assert.match(raw, /\x1b\[1m/);
});

test("session selector highlight never truncates the outer bold wrap for a selected row's remaining text", () => {
  // Regression test for the nesting hazard documented in rendering/highlight.ts:
  // SGR "bold off" is global state, not a stack. If a highlighted span were
  // nested inside theme.bold(...) (applied when a row is selected), the
  // span's own closing code would silently turn bold off for the rest of
  // the row. Matched/unmatched runs must be flat siblings instead.
  const selector = createSessionSelectorState();
  const session: SessionInfo = {
    path: "/sessions/a.jsonl",
    id: "a",
    cwd: "/repo",
    created: new Date("2025-01-01"),
    modified: new Date("2025-01-01"),
    messageCount: 1,
    firstMessage: "hello world message",
    allMessagesText: "hello world message",
  };
  selector.open = true;
  selector.currentSessions = [session];
  selector.selectedIndex = 0;
  updateSessionSelectorQuery(selector, "world");
  const state = createInitialState("/repo");
  state.sessionSelector = selector;
  const raw = renderSessionSelector(state, 80).join("\n");
  assert.match(stripAnsi(raw), /hello world message/);
  // Three independent bold-open spans: prefix "hello ", matched "world", and
  // suffix " message" -- each self-closed. A naive nested implementation
  // would only ever show one outer bold-open for the whole row.
  assert.equal((raw.match(/\x1b\[1m/g) ?? []).length, 3);
});
