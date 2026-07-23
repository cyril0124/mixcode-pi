import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSessionDiff, parseHunks, parseUnifiedPatch, reversePatch } from "./session-diff.js";

test("reversePatch reconstructs a full-file pure deletion", () => {
  const patch = ["--- f.txt", "+++ f.txt", "@@ -1,2 +0,0 @@", "-hello", "-world", ""].join("\n");

  assert.equal(reversePatch("", parseHunks(patch)), "hello\nworld\n");
});

test("reversePatch inserts a zero-context deletion at the new-side position", () => {
  const patch = ["@@ -2,2 +1,0 @@", "-line2", "-line3", ""].join("\n");

  assert.equal(reversePatch("keep\n", parseHunks(patch)), "keep\nline2\nline3\n");
});

test("reversePatch skips a superseded non-empty hunk", () => {
  const patch = ["@@ -1,1 +1,1 @@", "-old", "+gone", ""].join("\n");

  assert.equal(reversePatch("other\n", parseHunks(patch)), "other\n");
});

test("parseUnifiedPatch aligns an unbalanced change block for side-by-side display", () => {
  const patch = [
    "--- sample.ts",
    "+++ sample.ts",
    "@@ -1,3 +1,2 @@",
    "-old one",
    "-old two",
    "+new one",
    " keep",
    "",
  ].join("\n");

  assert.deepEqual(
    parseUnifiedPatch(patch)[0]?.rows.map((row) => ({
      kind: row.kind,
      oldLineNumber: row.oldLineNumber,
      newLineNumber: row.newLineNumber,
    })),
    [
      { kind: "replace", oldLineNumber: 1, newLineNumber: 1 },
      { kind: "delete", oldLineNumber: 2, newLineNumber: undefined },
      { kind: "equal", oldLineNumber: 3, newLineNumber: 2 },
    ],
  );
});

test("parseUnifiedPatch preserves no-newline markers on both sides", () => {
  const patch = [
    "--- sample.ts",
    "+++ sample.ts",
    "@@ -1 +1 @@",
    "-old",
    "\\ No newline at end of file",
    "+new",
    "\\ No newline at end of file",
    "",
  ].join("\n");

  const row = parseUnifiedPatch(patch)[0]?.rows[0];
  assert.equal(row?.kind, "replace");
  assert.equal(row?.oldNoNewline, true);
  assert.equal(row?.newNoNewline, true);
});

test("buildSessionDiff generates a modified-file model without executables on PATH", () => {
  const cwd = mkdtempSync(join(tmpdir(), "mpi-diff-v2-"));
  const previousPath = process.env.PATH;
  try {
    writeFileSync(join(cwd, "sample.ts"), "one\nnew\nthree\n");
    const patch = [
      "--- sample.ts",
      "+++ sample.ts",
      "@@ -1,3 +1,3 @@",
      " one",
      "-old",
      "+new",
      " three",
      "",
    ].join("\n");
    const entries = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "edit-1",
              name: "edit",
              arguments: {
                path: "sample.ts",
                edits: [{ oldText: "old", newText: "new" }],
              },
            },
          ],
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "edit-1",
          isError: false,
          details: { patch },
          content: [{ type: "text", text: "ok" }],
        },
      },
    ];

    process.env.PATH = "";
    const diff = buildSessionDiff(entries, cwd);

    assert.equal(diff.trackedFiles, 1);
    assert.equal(diff.files.length, 1);
    assert.equal(diff.additions, 1);
    assert.equal(diff.deletions, 1);
    assert.deepEqual(
      diff.files[0]?.hunks[0]?.rows.map((row) => ({
        kind: row.kind,
        oldLineNumber: row.oldLineNumber,
        newLineNumber: row.newLineNumber,
        oldText: row.oldText,
        newText: row.newText,
      })),
      [
        { kind: "equal", oldLineNumber: 1, newLineNumber: 1, oldText: "one", newText: "one" },
        { kind: "replace", oldLineNumber: 2, newLineNumber: 2, oldText: "old", newText: "new" },
        { kind: "equal", oldLineNumber: 3, newLineNumber: 3, oldText: "three", newText: "three" },
      ],
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(cwd, { recursive: true, force: true });
  }
});
