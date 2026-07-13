import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHunks, reversePatch } from "./index.js";

test("reversePatch: full-file pure deletion reconstructs old content", () => {
  // Pi generateUnifiedPatch(old="hello\nworld\n", new="") shape.
  const patch = ["--- f.txt", "+++ f.txt", "@@ -1,2 +0,0 @@", "-hello", "-world", ""].join("\n");
  const initial = reversePatch("", parseHunks(patch));
  assert.equal(initial, "hello\nworld\n");
});

test("reversePatch: pure deletion with zero context inserts at newStart", () => {
  // contextLines=0 deletion of trailing lines: @@ -2,2 +1,0 @@
  const patch = ["@@ -2,2 +1,0 @@", "-line2", "-line3", ""].join("\n");
  const initial = reversePatch("keep\n", parseHunks(patch));
  assert.equal(initial, "keep\nline2\nline3\n");
});

test("reversePatch: still skips superseded non-empty new-side hunks", () => {
  // new-side "gone" is absent from final content → skip (later edit overwrote it)
  const patch = ["@@ -1,1 +1,1 @@", "-old", "+gone", ""].join("\n");
  const initial = reversePatch("other\n", parseHunks(patch));
  assert.equal(initial, "other\n");
});

test("reversePatch: normal contextual deletion still reverses by content", () => {
  const patch = ["@@ -1,3 +1,2 @@", " prefix", "-middle", " suffix", ""].join("\n");
  const initial = reversePatch("prefix\nsuffix\n", parseHunks(patch));
  assert.equal(initial, "prefix\nmiddle\nsuffix\n");
});
