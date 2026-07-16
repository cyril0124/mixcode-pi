import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIXCODE_KEYMAP,
  describeKeymap,
  describeScopedKeymap,
  fitHeadLines,
  fitTailLines,
} from "../src/index.js";

test("fitTailLines keeps the newest lines and marks overflow", () => {
  assert.deepEqual(fitTailLines(["a", "b"], 3, 10), ["a", "b"]);
  assert.deepEqual(fitTailLines(["a", "b"], 0, 10), []);
  assert.match(fitTailLines(["a", "b", "c"], 2, 10).join("\n"), /\.\.\.[\s\S]*c/);
});

test("fitHeadLines keeps the oldest lines and marks overflow", () => {
  assert.deepEqual(fitHeadLines(["a", "b"], 3, 10), ["a", "b"]);
  assert.deepEqual(fitHeadLines(["a", "b"], 0, 10), []);
  assert.match(fitHeadLines(["a", "b", "c"], 2, 10).join("\n"), /a[\s\S]*\.\.\./);
});

test("keymap export documents global and scoped bindings", () => {
  const lines = describeKeymap();
  assert.ok(lines.some((line) => line.startsWith("ctrl+q:")));

  const scopes = new Set(MIXCODE_KEYMAP.map((item) => item.scope ?? "global"));
  for (const scope of ["global", "picker", "command-palette", "tab-jump", "preview"] as const) {
    assert.equal(scopes.has(scope), true, `${scope} scope should exist`);
  }
  const scoped = describeScopedKeymap();
  for (const scope of ["picker", "command-palette", "tab-jump", "preview"]) {
    assert.equal(
      scoped.some((line) => line.startsWith(`${scope} `)),
      true,
      `${scope} should appear in scoped keymap text`,
    );
  }
});
