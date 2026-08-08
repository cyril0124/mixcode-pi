import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { buildLabeledTopBorder } from "../src/ui/editor-top-border.js";
import {
  contextBarAndPercentText,
  exactContextUsageText,
  renderInputMeta,
} from "../src/ui/rendering/chrome.js";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;:]*m/g, "");
}

const identity = (s: string) => s;

test("exactContextUsageText keeps used/limit compact form", () => {
  const tab = createTab(1, "s1", "/repo", {
    currentContextTokens: 10,
    contextLimit: 200_000,
  });
  assert.equal(exactContextUsageText(tab), "0.01k/200k");
});

test("exactContextUsageText marks overridden limits", () => {
  const tab = createTab(1, "s1", "/repo", {
    currentContextTokens: 100_000,
    contextLimit: 200_000,
    contextLimitOverridden: true,
  });
  assert.equal(exactContextUsageText(tab), "100k/200k*");
});

test("contextBarAndPercentText shows open-tui style bar and percent without absolute counts", () => {
  const tab = createTab(1, "s1", "/repo", {
    currentContextTokens: 100_000,
    contextLimit: 200_000,
  });
  const plain = stripAnsi(contextBarAndPercentText(tab));
  assert.match(plain, /\uf0c9 \[█+░*\] 50\.0%/);
  assert.doesNotMatch(plain, /100k|200k/);
});

test("top border embeds exact context next to the title", () => {
  const line = stripAnsi(
    buildLabeledTopBorder({
      width: 48,
      title: "Agent-1",
      vimMode: false,
      contextText: "12.3k/200k",
      dash: identity,
      vimLabel: identity,
      titleLabel: identity,
      contextLabel: identity,
    }),
  );
  assert.equal(visibleLen(line), 48);
  assert.match(line, /─ Agent-1 · 12\.3k\/200k ──$/);
});

test("top border drops context before the title when width is tight", () => {
  const line = stripAnsi(
    buildLabeledTopBorder({
      width: 16,
      title: "Agent-1",
      vimMode: false,
      contextText: "12.3k/200k",
      dash: identity,
      vimLabel: identity,
      titleLabel: identity,
      contextLabel: identity,
    }),
  );
  assert.equal(visibleLen(line), 16);
  assert.match(line, /Agent-1/);
  assert.doesNotMatch(line, /12\.3k/);
});

test("input meta row uses bar+percent, not absolute token counts", () => {
  const tab = createTab(1, "s1", "/nonexistent-no-git", {
    currentContextTokens: 10,
    contextLimit: 200_000,
  });
  const plain = stripAnsi(renderInputMeta(tab, 100).join("\n"));
  assert.match(plain, /\uf0c9 \[[█░]+\] 0\.0%/);
  assert.doesNotMatch(plain, /0\.01k\/200k/);
});

function visibleLen(text: string): number {
  // ASCII-only fixtures; keep the helper local and tiny.
  return [...text].length;
}
