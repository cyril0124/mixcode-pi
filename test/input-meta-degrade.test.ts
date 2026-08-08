import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { renderInputMeta, shortModelName } from "../src/ui/rendering/chrome.js";

// Input meta row degradation contract: full "provider/module" model + icons +
// wide gaps when the row fits; progressive degradation as width shrinks —
// drop the provider prefix, then drop icons and tighten gaps to single spaces,
// then fall back to model truncation. Strict modes keep the full short workdir;
// path compaction / ellipsis only happens in the tightest (non-strict) mode.
function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function metaRow(displayName: string, width: number): string {
  // Non-existent path so the git badge stays " - " (no repo) and the row width
  // is deterministic across machines.
  const workdir = join(process.env.HOME ?? "/", "workspace/project/mixcode-pi-demo");
  const tab = createTab(1, "s1", workdir, {
    model: {
      provider: "anthropic",
      modelId: "claude-sonnet-4-5",
      displayName,
      contextWindow: 200_000,
    },
    thinkingLevel: "medium",
  });
  return stripAnsi(renderInputMeta(tab, width, 0, undefined, true, "nerd").join("\n"));
}

test("shortModelName drops everything up to the last slash", () => {
  assert.equal(shortModelName("anthropic/claude-sonnet-4-5"), "claude-sonnet-4-5");
  assert.equal(shortModelName("openrouter/anthropic/claude-3.7-sonnet"), "claude-3.7-sonnet");
  assert.equal(shortModelName("gpt-4o"), "gpt-4o");
});

test("wide rows show the full provider/module model name, icons, and workdir", () => {
  const row = metaRow("anthropic/claude-sonnet-4-5", 120);
  assert.match(row, /anthropic\/claude-sonnet-4-5/);
  assert.match(row, / Medium/);
  assert.match(row, /~\/workspace\/project\/mixcode-pi-demo/);
  assert.doesNotMatch(row, /\.\.\./);
});

test("drop provider before compacting or truncating workdir", () => {
  // Full provider/model leaves too little room for the natural workdir, but the
  // short model name still fits it — must drop the provider, not ellipsize path.
  // Wider right-side context bar needs more columns before icons drop.
  const row = metaRow("anthropic/claude-sonnet-4-5", 98);
  assert.match(row, /claude-sonnet-4-5/);
  assert.doesNotMatch(row, /anthropic\//);
  assert.match(row, / Medium/);
  assert.match(row, /~\/workspace\/project\/mixcode-pi-demo/);
  assert.doesNotMatch(row, /\.\.\./);
});

test("narrow rows drop icons and tighten spacing to single spaces", () => {
  const row = metaRow("anthropic/claude-sonnet-4-5", 55);
  assert.match(row, /claude-sonnet-4-5 Medium/);
  assert.doesNotMatch(row, /|󰚩/);
});

test("very narrow rows fall back to model truncation with an ellipsis", () => {
  const row = metaRow("anthropic/claude-sonnet-4-5", 34);
  // Bar+percent on the right leaves less room; truncation may cut earlier.
  assert.match(row, /cl.*\.\.\./);
});
