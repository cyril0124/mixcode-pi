import assert from "node:assert/strict";
import test from "node:test";
import type { ChatLine } from "../src/agent/runtime.js";
import type { MixCodeTabInfo } from "../src/core/types.js";
import {
  applyChatBlockScrollAnchor,
  applyScrollFreezeAnchor,
  keepScrolledViewStable,
  rememberChatBlockScrollAnchor,
  rememberScrollFreezeAnchor,
} from "../src/ui/rendering/agent-surface-scroll.js";

test("rememberScrollFreezeAnchor skips ANSI-only blank rows", () => {
  const tab = { chatScrollOffset: 8 } as MixCodeTabInfo;
  keepScrolledViewStable(tab, 100, 40, 6);
  keepScrolledViewStable(tab, 120, 40, 6);
  assert.ok(tab.chatScrollOffset > 8);

  const blank = `\x1b[48;2;30;30;30m${" ".repeat(10)}\x1b[49m`;
  const content = "real-message-line";
  rememberScrollFreezeAnchor(tab, [blank, content, "next"], 40, 6);

  const lines = [
    ...Array.from({ length: 50 }, () => blank),
    content,
    "next",
    ...Array.from({ length: 50 }, (_, i) => `below-${i}`),
  ];
  applyScrollFreezeAnchor(tab, lines, 6, 40);

  const start = Math.max(0, lines.length - (tab.chatScrollOffset + 6));
  // content was visible row 1 when remembered; freeze should keep it there
  assert.equal(lines[start + 1], content);
});

test("chat block scroll anchor survives width reflow", () => {
  const tab = { chatScrollOffset: 20 } as MixCodeTabInfo;
  const target: ChatLine = { role: "assistant", text: "long body ".repeat(40) };
  const other: ChatLine = { role: "user", text: "prompt" };

  // First layout at width 80: target block starts at 10, height 20.
  keepScrolledViewStable(tab, 100, 80, 10);
  rememberChatBlockScrollAnchor(
    tab,
    [
      { line: other, start: 0, height: 4 },
      { line: target, start: 10, height: 20 },
    ],
    15,
    ["target-line-mid", "more"],
    80,
    10,
  );

  // Second layout at width 40: same ChatLine reflows to height 40 starting at 8.
  keepScrolledViewStable(tab, 140, 40, 10);
  applyChatBlockScrollAnchor(
    tab,
    [
      { line: other, start: 0, height: 4 },
      { line: target, start: 8, height: 40 },
    ],
    80,
    10,
    40,
  );

  // Progress within the block (~(15-10)/20 = 0.25) should map to row 10 of height 40.
  // With viewport row 0, start ≈ 8 + 10 = 18 → offset = 80 - (18 + 10) = 52.
  const start = Math.max(0, 80 - (tab.chatScrollOffset + 10));
  assert.ok(start >= 8 && start < 8 + 40, `start ${start} should land inside reflowed target block`);
  assert.ok(Math.abs(start - 18) <= 2, `start ${start} should be near progress-mapped row 18`);
});
