import assert from "node:assert/strict";
import { test } from "node:test";
import {
  highlightChatSelectionLine,
  normalizeChatSelection,
  pointInChatSurface,
  screenToChatSelectionPoint,
  selectedChatText,
  stripAnsi,
  type ChatSelectionState,
} from "../src/index.js";

const selection: ChatSelectionState = {
  anchor: { row: 1, col: 6 },
  focus: { row: 2, col: 5 },
  dragging: true,
};

test("chat selection normalizes reverse drag order", () => {
  assert.deepEqual(
    normalizeChatSelection({ anchor: { row: 3, col: 2 }, focus: { row: 1, col: 4 }, dragging: true }),
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
  const lines = [
    "ignored",
    "hello \x1b[31mworld\x1b[39m   ",
    "again there",
    "ignored",
  ];
  assert.equal(selectedChatText(lines, selection), "world\nagain");
});

test("highlightChatSelectionLine highlights the selected visible cells", () => {
  const highlighted = highlightChatSelectionLine("hello world", 1, selection, (text) => `[${text}]`);
  assert.equal(highlighted, "hello [world]");
});

test("stripAnsi removes CSI and OSC control sequences", () => {
  assert.equal(stripAnsi("a\x1b[31mb\x1b[39m\x1b]133;A\x07c"), "abc");
});
