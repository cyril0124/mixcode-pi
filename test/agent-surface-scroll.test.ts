import assert from "node:assert/strict";
import test from "node:test";
import type { MixCodeTabInfo } from "../src/core/types.js";
import {
  applyScrollFreezeAnchor,
  keepScrolledViewStable,
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
