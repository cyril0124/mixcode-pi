import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { buildTranscriptEditorScript, NVIM_TRANSCRIPT_LUA, VIM_TRANSCRIPT_VIM } from "./index.js";

type Editor = "nvim" | "vim";

/** Return foldclosed() for every buffer line after loading the view script. */
async function closedFolds(editor: Editor, markdown: string[], script: string): Promise<number[]> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "transcript-folds-"));
  try {
    const markdownPath = path.join(dir, "view.md");
    const scriptPath = path.join(dir, editor === "nvim" ? "view.lua" : "view.vim");
    const dumpPath = path.join(dir, "dump.vim");
    const resultPath = path.join(dir, "folds.json");
    await fs.writeFile(markdownPath, `${markdown.join("\n")}\n`);
    await fs.writeFile(scriptPath, script);
    await fs.writeFile(
      dumpPath,
      [
        `call writefile([json_encode(map(range(1, line('$')), 'foldclosed(v:val)'))], '${resultPath}')`,
        "qa!",
      ].join("\n"),
    );
    const args = editor === "nvim" ? ["--headless", "--clean", "-n"] : ["--clean", "-n", "-es"];
    const result = spawnSync(
      editor,
      [
        ...args,
        markdownPath,
        "-c",
        `${editor === "nvim" ? "luafile" : "source"} ${scriptPath}`,
        "-c",
        `source ${dumpPath}`,
      ],
      { encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
    return JSON.parse(await fs.readFile(resultPath, "utf8")) as number[];
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

for (const editor of ["nvim", "vim"] as const) {
  const available = spawnSync(editor, ["--version"], { timeout: 5_000 }).status === 0;
  test(`${editor} defaults to folding only tool bodies above 20 text lines`, {
    skip: available ? false : `${editor} not on PATH`,
  }, async () => {
    const markdown: string[] = ["# Chatlog", ""];
    const expected: number[] = [-1, -1];
    for (const count of [0, 1, 19, 20, 21]) {
      markdown.push("### 🔧 Tool: bash — ✅ success", "");
      expected.push(-1, -1);
      for (const language of ["json", ""]) {
        markdown.push(`\`\`\`${language}`);
        expected.push(-1);
        const bodyStart = markdown.length + 1;
        // One very wide text line is still one line, regardless of terminal wrapping.
        markdown.push(...Array.from({ length: count }, () => "x".repeat(200)));
        expected.push(...Array.from({ length: count }, () => (count > 20 ? bodyStart : -1)));
        markdown.push("```", "");
        expected.push(-1, -1);
      }
    }
    const script = editor === "nvim" ? NVIM_TRANSCRIPT_LUA : VIM_TRANSCRIPT_VIM;
    assert.deepEqual(await closedFolds(editor, markdown, script), expected);
  });

  test(`${editor} honors a custom threshold and zero for single-line tool bodies`, {
    skip: available ? false : `${editor} not on PATH`,
  }, async () => {
    const markdown = [
      "### 🔧 Tool: bash — ✅ success",
      "",
      "```json",
      "{}",
      "```",
      "",
      "```",
      "first",
      "",
      "last",
      "```",
      "",
    ];
    assert.deepEqual(
      await closedFolds(editor, markdown, buildTranscriptEditorScript(editor, 2)),
      [-1, -1, -1, -1, -1, -1, -1, 8, 8, 8, -1, -1],
    );
    assert.deepEqual(
      await closedFolds(editor, markdown, buildTranscriptEditorScript(editor, 0)),
      [-1, -1, -1, 4, -1, -1, -1, 8, 8, 8, -1, -1],
    );
  });

  test(`${editor} folds past generated truncation notices but stops at assistant prose`, {
    skip: available ? false : `${editor} not on PATH`,
  }, async () => {
    const markdown = [
      "### 🔧 Tool: bash — ❌ error",
      "",
      "```json",
      "{}",
      "```",
      "",
      "_… +50 earlier lines_",
      "",
      "```",
      "error one",
      "error two",
      "```",
      "",
      "_… +50 more lines_",
      "",
      "Assistant explanation",
      "```",
      "prose code",
      "```",
      "",
      "### 🔧 Tool: read — ✅ success",
      "",
      "```",
      "unterminated tool body",
      "another line",
    ];
    assert.deepEqual(
      await closedFolds(editor, markdown, buildTranscriptEditorScript(editor, 0)),
      [
        -1, -1, -1, 4, -1, -1, -1, -1, -1, 10, 10, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1, -1,
        -1, -1,
      ],
    );
  });
}
