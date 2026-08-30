import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import * as childProcess from "node:child_process";
import {
  buildGitDiff,
  buildSessionDiff,
  parseGitUnifiedDiff,
  parseHunks,
  parseUnifiedPatch,
  reversePatch,
} from "./session-diff.js";

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

test("buildSessionDiff uses baseline write content when turn starts with overwrite write", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-baseline-"));
  try {
    // Disk already has the post-turn content (write already applied).
    fs.writeFileSync(path.join(cwd, "sample.lua"), "new without info\n");
    const baseline = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-old",
              name: "write",
              arguments: { path: "sample.lua", content: "old with source_info\n" },
            },
          ],
        },
      },
    ];
    const turn = [
      {
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "write-new",
              name: "write",
              arguments: { path: "sample.lua", content: "new without info\n" },
            },
          ],
        },
      },
    ];

    const diff = buildSessionDiff(turn, cwd, baseline);

    assert.equal(diff.trackedFiles, 1);
    assert.equal(diff.files[0]?.status, "modified");
    assert.deepEqual(
      diff.files[0]?.hunks[0]?.rows.map((row) => ({
        kind: row.kind,
        oldText: row.oldText,
        newText: row.newText,
      })),
      [{ kind: "replace", oldText: "old with source_info", newText: "new without info" }],
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildSessionDiff generates a modified-file model without executables on PATH", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-v2-"));
  const previousPath = process.env.PATH;
  try {
    fs.writeFileSync(path.join(cwd, "sample.ts"), "one\nnew\nthree\n");
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
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("parseGitUnifiedDiff parses statuses and counts while skipping binaries", () => {
  const patch = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 111..222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,2 +1,2 @@",
    "-old",
    "+new",
    " keep",
    "diff --git a/src/b.ts b/src/b.ts",
    "new file mode 100644",
    "index 000..333",
    "--- /dev/null",
    "+++ b/src/b.ts",
    "@@ -0,0 +1 @@",
    "+hello",
    "diff --git a/src/deleted.ts b/src/deleted.ts",
    "deleted file mode 100644",
    "index 555..000",
    "--- a/src/deleted.ts",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-goodbye",
    "diff --git a/src/c.bin b/src/c.bin",
    "index 000..444",
    "Binary files a/src/c.bin and b/src/c.bin differ",
    "",
  ].join("\n");

  const files = parseGitUnifiedDiff(patch);
  assert.deepEqual(
    files.map((file) => ({
      path: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    })),
    [
      { path: "src/a.ts", status: "modified", additions: 1, deletions: 1 },
      { path: "src/b.ts", status: "added", additions: 1, deletions: 0 },
      { path: "src/deleted.ts", status: "deleted", additions: 0, deletions: 1 },
    ],
  );
});

test("parseGitUnifiedDiff decodes Git-quoted UTF-8 paths", () => {
  const patch = [
    'diff --git "a/\\346\\265\\213\\350\\257\\225.ts" "b/\\346\\265\\213\\350\\257\\225.ts"',
    "index 111..222 100644",
    '--- "a/\\346\\265\\213\\350\\257\\225.ts"',
    '+++ "b/\\346\\265\\213\\350\\257\\225.ts"',
    "@@ -1 +1 @@",
    "-old",
    "+new",
    "",
  ].join("\n");

  assert.equal(parseGitUnifiedDiff(patch)[0]?.path, "测试.ts");
});

function runGit(cwd: string, args: string[]): void {
  const result = childProcess.spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t.t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t.t",
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
}

test("buildGitDiff reads staged and unstaged changes without configured diff programs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-git-"));
  try {
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "commit.gpgsign", "false"]);
    runGit(cwd, ["config", "color.ui", "always"]);
    runGit(cwd, ["config", "diff.external", "false"]);
    runGit(cwd, ["config", "diff.probe.textconv", "false"]);
    fs.writeFileSync(path.join(cwd, ".gitattributes"), "*.ts diff=probe\n");
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "one\n");
    runGit(cwd, ["add", ".gitattributes", "tracked.ts"]);
    runGit(cwd, ["commit", "-m", "init"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "two\n");
    runGit(cwd, ["add", "tracked.ts"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "three\n");

    const diff = buildGitDiff(cwd, "HEAD");
    assert.equal(diff.files.length, 1);
    assert.equal(diff.files[0]?.path, "tracked.ts");
    assert.equal(diff.files[0]?.status, "modified");
    assert.match(diff.files[0]?.hunks[0]?.rows[0]?.oldText ?? "", /one/);
    assert.match(diff.files[0]?.hunks[0]?.rows[0]?.newText ?? "", /three/);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildGitDiff counts metadata-only and binary changes", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-git-metadata-"));
  try {
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "commit.gpgsign", "false"]);
    runGit(cwd, ["config", "core.filemode", "true"]);
    runGit(cwd, ["config", "diff.renames", "true"]);
    fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([0, 1, 2]));
    fs.writeFileSync(path.join(cwd, "rename.txt"), "same\n");
    fs.writeFileSync(path.join(cwd, "mode.sh"), "#!/bin/sh\n");
    runGit(cwd, ["add", "blob.bin", "rename.txt", "mode.sh"]);
    runGit(cwd, ["commit", "-m", "init"]);

    fs.writeFileSync(path.join(cwd, "blob.bin"), Buffer.from([3, 4, 5, 0]));
    runGit(cwd, ["mv", "rename.txt", "renamed.txt"]);
    fs.chmodSync(path.join(cwd, "mode.sh"), 0o755);
    fs.writeFileSync(path.join(cwd, "empty.txt"), "");
    runGit(cwd, ["add", "-A"]);

    const diff = buildGitDiff(cwd, "HEAD");
    assert.equal(diff.trackedFiles, 4);
    assert.deepEqual(diff.files, []);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildGitDiff accepts output larger than the child-process default buffer", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-git-large-"));
  try {
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(cwd, "large.txt"), `${"a".repeat(1_100_000)}\n`);
    runGit(cwd, ["add", "large.txt"]);
    runGit(cwd, ["commit", "-m", "init"]);
    fs.writeFileSync(path.join(cwd, "large.txt"), `${"b".repeat(1_100_000)}\n`);

    const diff = buildGitDiff(cwd, "HEAD");
    assert.equal(diff.files[0]?.hunks[0]?.rows[0]?.oldText.length, 1_100_000);
    assert.equal(diff.files[0]?.hunks[0]?.rows[0]?.newText.length, 1_100_000);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildGitDiff rejects missing, option-like, and path-like refs", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-git-missing-"));
  try {
    runGit(cwd, ["init"]);
    runGit(cwd, ["config", "commit.gpgsign", "false"]);
    fs.writeFileSync(path.join(cwd, "tracked.ts"), "one\n");
    runGit(cwd, ["add", "tracked.ts"]);
    runGit(cwd, ["commit", "-m", "init"]);

    assert.throws(() => buildGitDiff(cwd, "no-such-ref"), /fatal|bad revision|unknown revision/i);
    assert.throws(() => buildGitDiff(cwd, "--help"), /Invalid git ref/);
    assert.throws(() => buildGitDiff(cwd, "tracked.ts"), /fatal|bad revision|unknown revision/i);
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("buildGitDiff reports a one-line fatal outside a git work tree", () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-diff-git-nongit-"));
  try {
    assert.throws(
      () => buildGitDiff(cwd, "HEAD"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /not a git repository/i);
        assert.doesNotMatch(error.message, /\n/);
        return true;
      },
    );
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
