import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences as stripAnsi, visibleWidth } from "@earendil-works/pi-tui";
import {
  highlightChatSelectionLine,
  normalizeChatSelection,
  pointInChatSurface,
  screenToChatSelectionPoint,
  selectedChatText,
  type ChatSelectionState,
} from "./helpers/mixcode.js";

const selection: ChatSelectionState = {
  anchor: { row: 1, col: 6 },
  focus: { row: 2, col: 5 },
  dragging: true,
};

test("chat selection normalizes reverse drag order", () => {
  assert.deepEqual(
    normalizeChatSelection({
      anchor: { row: 3, col: 2 },
      focus: { row: 1, col: 4 },
      dragging: true,
    }),
    { start: { row: 1, col: 4 }, end: { row: 3, col: 2 } },
  );
});

test("screen points clamp into chat surface coordinates", () => {
  const bounds = { top: 5, left: 1, width: 20, height: 4 };
  assert.equal(pointInChatSurface(bounds, { row: 6, col: 10 }), true);
  assert.equal(pointInChatSurface(bounds, { row: 4, col: 10 }), false);
  assert.deepEqual(screenToChatSelectionPoint(bounds, 8, 40), { row: 3, col: 20 });
});

test("selectedChatText copies visible text across rows without ANSI styling", () => {
  const lines = ["ignored", "hello \x1b[31mworld\x1b[39m   ", "again there", "ignored"];
  assert.equal(selectedChatText(lines, selection), "world\nagain");
});

test("highlightChatSelectionLine highlights the selected visible cells", () => {
  const highlighted = highlightChatSelectionLine(
    "hello world",
    1,
    selection,
    (text) => `[${text}]`,
  );
  assert.equal(highlighted, "hello [world]");
});

function mark(text: string): string {
  return `[${text}]`;
}

function drag(col0: number, col1: number): ChatSelectionState {
  return { anchor: { row: 0, col: col0 }, focus: { row: 0, col: col1 }, dragging: true };
}

test("highlightChatSelectionLine keeps a CJK grapheme when the end column is on its right half", () => {
  const line = "你好世界";
  const highlighted = highlightChatSelectionLine(line, 0, drag(0, 3), mark);
  assert.equal(highlighted.replace(/\[|\]/g, ""), line);
  assert.equal(highlighted, "[你好]世界");
});

test("highlightChatSelectionLine keeps a CJK grapheme when the start column is on its right half", () => {
  const line = "你好世界";
  const highlighted = highlightChatSelectionLine(line, 0, drag(1, 3), mark);
  assert.equal(highlighted.replace(/\[|\]/g, ""), line);
  assert.equal(highlighted, "[你好]世界");
});

test("highlightChatSelectionLine does not drop CJK at odd end columns", () => {
  const line = "你好世界";
  for (let end = 0; end <= visibleWidth(line); end++) {
    const highlighted = highlightChatSelectionLine(line, 0, drag(0, end), mark);
    assert.equal(highlighted.replace(/\[|\]/g, ""), line, `dropped CJK at end col ${end}`);
  }
});

test("highlightChatSelectionLine keeps ASCII letters under an inclusive end cell", () => {
  const highlighted = highlightChatSelectionLine("hello", 0, drag(1, 5), mark);
  assert.equal(highlighted, "h[ello]");
});

test("selectedChatText copies CJK graphemes at half-cell bounds", () => {
  const lines = ["你好世界"];
  assert.equal(selectedChatText(lines, drag(0, 3)), "你好");
  assert.equal(selectedChatText(lines, drag(1, 3)), "你好");
  assert.equal(selectedChatText(lines, drag(3, 5)), "好世");
});

test("highlightChatSelectionLine ignores collapsed selection", () => {
  assert.equal(highlightChatSelectionLine("你好", 0, drag(1, 1), mark), "你好");
});

test("highlightChatSelectionLine overlays selection on block backgrounds", () => {
  const line = "\x1b[48;2;40;50;40m  read foo.md\x1b[49m";
  const highlighted = highlightChatSelectionLine(
    line,
    0,
    drag(0, 12),
    (text) => `\x1b[48;2;58;58;74m${text}\x1b[49m`,
  );
  assert.equal(stripAnsi(highlighted), stripAnsi(line));
  assert.match(highlighted, /\x1b\[48;2;40;50;40m\x1b\[48;2;58;58;74m/);
});

test("highlightChatSelectionLine preserves wide characters at cell boundaries", () => {
  const line =
    "  - 得出的结论是：@oh-my-pi/* 不是 @earendil-works/pi-* 的直接兼容替换，主要风险在 Bun 运行时、TS 源码导出、native bindings、包结构";
  const highlighted = highlightChatSelectionLine(
    line,
    0,
    drag(4, 5),
    (text) => `\x1b[48;2;122;74;58m${text}\x1b[49m`,
  );
  const plain = stripAnsi(highlighted);
  assert.equal(plain, line);
  assert.equal(visibleWidth(plain), visibleWidth(line));
  assert.equal(highlighted.includes("\x1b[48;2;122;74;58m得\x1b[49m"), true);
});
