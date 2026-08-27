import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { compactWorkdir } from "../src/ui/rendering/chrome.js";

// Workdir meta-row rendering contract: full path when it fits, progressive
// left-to-right component compression when it does not, "..." truncation as
// the last resort. Basename (last segment) is never compressed.
// truncateToWidth decorates the ellipsis with ANSI resets; assert the visible
// text only.
function visible(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("compactWorkdir keeps the full path when it fits", () => {
  assert.equal(
    compactWorkdir("~/workspace/project/mixcode-pi", 30),
    "~/workspace/project/mixcode-pi",
  );
});

test("compactWorkdir compresses left components progressively until it fits", () => {
  // 30 wide full; 22 fits with only the first component compressed.
  assert.equal(compactWorkdir("~/workspace/project/mixcode-pi", 22), "~/w/project/mixcode-pi");
  // 16 is the fully compressed form, exactly at the budget.
  assert.equal(compactWorkdir("~/workspace/project/mixcode-pi", 16), "~/w/p/mixcode-pi");
});

test("compactWorkdir truncates with ellipsis when even the compressed form is too wide", () => {
  // "~/w/p/mixcode-pi" is 16 wide; budget 10 keeps 7 chars + "...".
  assert.equal(visible(compactWorkdir("~/workspace/project/mixcode-pi", 10)), "~/w/p/m...");
});

test("compactWorkdir keeps dotfile components readable as '.' + first char", () => {
  assert.equal(compactWorkdir("~/workspace/.config/git", 10), "~/w/.c/git");
});

test("compactWorkdir handles non-home absolute paths the same way", () => {
  assert.equal(compactWorkdir("/opt/foo/bar", 8), "/o/f/bar");
});

test("compactWorkdir compresses a short single-component path only by truncation", () => {
  // Nothing left of the basename to compress; falls back to truncation.
  assert.equal(visible(compactWorkdir("~/project", 6)), "~/p...");
});

test("compactWorkdir respects visible width for CJK components", () => {
  // "~/工作/项目" is 11 cells wide; compressing 工作→工 yields 9 cells.
  assert.equal(compactWorkdir("~/工作/项目", 9), "~/工/项目");
});

test("compactWorkdir leaves already-short paths untouched", () => {
  assert.equal(compactWorkdir("~/x", 5), "~/x");
});
