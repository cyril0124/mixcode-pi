import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  createInitialState,
  createSessionSelectorState,
  editTextInExternalEditor,
  getFilteredSessions,
  handleMixCodeKeyInput,
  parseCommandArgs,
  runLuaScript,
  substituteArgs,
} from "../src/index.js";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";

const execFileAsync = promisify(execFile);

function session(id: string, modified: string): SessionInfo {
  return {
    path: `/sessions/${id}.jsonl`,
    id,
    cwd: "/repo",
    created: new Date("2025-01-01T00:00:00Z"),
    modified: new Date(modified),
    messageCount: 1,
    firstMessage: id,
    allMessagesText: id,
  };
}

test("parseCommandArgs preserves quoted empty arguments", () => {
  assert.deepEqual(parseCommandArgs('"" two'), ["", "two"]);
  assert.deepEqual(parseCommandArgs("one '' three"), ["one", "", "three"]);
  assert.equal(
    substituteArgs("first=[$1] second=[$2]", parseCommandArgs('"" two')),
    "first=[] second=[two]",
  );
});

test("parseCommandArgs preserves ordinary backslashes inside double quotes", () => {
  assert.deepEqual(parseCommandArgs('"C:\\tmp\\file" "\\d+" "say \\"hi\\""'), [
    "C:\\tmp\\file",
    "\\d+",
    'say "hi"',
  ]);
});

test("runLuaScript rejects non-string open_tab fields with clear field errors", async () => {
  await assert.rejects(
    () => runLuaScript("mixcode.open_tab({ name = 123, prompt = 'p' })", "bad.lua"),
    /name.*string/,
  );
  await assert.rejects(
    () => runLuaScript("mixcode.open_tab({ name = 'n', prompt = false })", "bad.lua"),
    /prompt.*string/,
  );
});

test("session selector recent mode sorts by modified time descending", () => {
  const selector = createSessionSelectorState();
  selector.sortMode = "recent";
  selector.currentSessions = [
    session("old", "2025-01-01T00:00:00Z"),
    session("new", "2025-01-03T00:00:00Z"),
  ];
  assert.deepEqual(
    getFilteredSessions(selector).map((node) => node.session.id),
    ["new", "old"],
  );
});

test("session selector rename mode ignores arrow escape sequences", () => {
  const state = createInitialState("/repo");
  state.sessionSelector.open = true;
  state.sessionSelector.renameMode = true;
  state.sessionSelector.renameInput = "abc";
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }) as never,
    hasOverlay: () => true,
    hideOverlay: () => undefined,
  };

  assert.deepEqual(handleMixCodeKeyInput(state, "\x1b[A", tui), { consume: true });
  assert.equal(state.sessionSelector.renameInput, "abc");
});

test("external editor supports executable paths containing spaces", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-editor-space-"));
  try {
    const editorDir = join(dir, "editor dir");
    await mkdir(editorDir);
    const script = join(editorDir, "editor.sh");
    await writeFile(script, "#!/bin/sh\nprintf 'edited through spaced path\\n' > \"$1\"\n", "utf8");
    await chmod(script, 0o755);
    assert.equal(
      await editTextInExternalEditor("initial", { editor: script, tempRoot: dir }),
      "edited through spaced path\n",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("standalone binary entry references materialized assets that exist in installed dependencies", () => {
  const source = readFileSyncFromRepo("src/cli/binary-entry.ts");
  const match = source.match(/import photonWasmPath from "(\.\.\/\.\.\/[^"]+photon_rs_bg\.wasm)"/);
  assert.ok(match);
  const relativePath = match[1]!.replace(/^\.\.\/\.\.\//, "");
  assert.equal(existsSync(relativePath), true);
});

test("package bin symlink starts the CLI instead of silently exiting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-bin-link-"));
  try {
    const linkPath = join(dir, "mixcode-pi");
    await symlink(join(process.cwd(), "src", "cli", "main.ts"), linkPath);
    const { stdout } = await execFileAsync(process.execPath, ["--import", "tsx", linkPath, "--help"], {
      timeout: 10_000,
    });
    assert.match(stdout, /Usage: mixcode-pi \[options\]/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

function readFileSyncFromRepo(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
