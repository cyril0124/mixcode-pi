import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  SkillError,
  buildPrompt,
  commandSuggestions,
  createInitialState,
  createTab,
  deleteWorkspace,
  deserializeState,
  extractFileRefs,
  extractSkillRefs,
  fuzzyContains,
  fuzzyMatch,
  fuzzyMatchBatch,
  fuzzyMatchBatchScored,
  loadStateFile,
  loadWorkspaces,
  normalizeStartupWorkdir,
  parseSgrMouseInput,
  MOUSE_REPORTING_DISABLE,
  MOUSE_REPORTING_ENABLE,
  AUTOWRAP_DISABLE,
  AUTOWRAP_ENABLE,
  parseInput,
  parseJsonObject,
  resolvePromptPath,
  resolveSkillDirs,
  scanSkillNames,
  saveStateFile,
  saveWorkspaces,
  scopedStateDir,
  serializeState,
  stateFileForPort,
  stringifyJson,
  withMouseReporting,
  scanProjectFiles,
  searchProjectFiles,
  scanSkillEntries,
  createPicker,
  filteredPickerItems,
  updatePickerQuery,
  movePickerSelection,
  acceptPickerSelection,
  completeWorkdirPickerSelection,
} from "../src/index.js";
import type { Terminal } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);

test("SGR mouse parser recognizes wheel and leaves non-mouse input untouched", () => {
  assert.deepEqual(parseSgrMouseInput("\x1b[<64;10;5M"), {
    button: 64,
    x: 10,
    y: 5,
    release: false,
    motion: undefined,
    wheel: "up",
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<65;11;6M"), {
    button: 65,
    x: 11,
    y: 6,
    release: false,
    motion: undefined,
    wheel: "down",
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<0;12;7m"), {
    button: 0,
    x: 12,
    y: 7,
    release: true,
    motion: undefined,
    wheel: undefined,
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<66;13;8M"), {
    button: 66,
    x: 13,
    y: 8,
    release: false,
    motion: undefined,
    wheel: undefined,
  });
  assert.deepEqual(parseSgrMouseInput("\x1b[<32;14;9M"), {
    button: 0,
    x: 14,
    y: 9,
    release: false,
    motion: true,
    wheel: undefined,
  });
  assert.equal(parseSgrMouseInput("\x1b[A"), undefined);
});

test("mouse reporting terminal enables and disables SGR mouse events", async () => {
  const writes: string[] = [];
  const calls: string[] = [];
  let starts = 0;
  let stops = 0;
  let drains = 0;
  let clears = 0;
  const terminal: Terminal = {
    start: () => {
      starts++;
    },
    stop: () => {
      stops++;
    },
    drainInput: async () => {
      drains++;
    },
    write: (data: string) => {
      writes.push(data);
    },
    get columns() {
      return 80;
    },
    get rows() {
      return 24;
    },
    get kittyProtocolActive() {
      return true;
    },
    moveBy: (lines) => calls.push(`move:${lines}`),
    hideCursor: () => calls.push("hide"),
    showCursor: () => calls.push("show"),
    clearLine: () => calls.push("clearLine"),
    clearFromCursor: () => calls.push("clearFromCursor"),
    clearScreen: () => {
      clears++;
    },
    setTitle: (title) => calls.push(`title:${title}`),
    setProgress: (active) => calls.push(`progress:${active}`),
  };

  const mouseTerminal = withMouseReporting(terminal);
  await mouseTerminal.drainInput();
  assert.equal(writes.length, 0);
  assert.equal(drains, 1);

  mouseTerminal.start(
    () => undefined,
    () => undefined,
  );
  assert.equal(mouseTerminal.columns, 80);
  assert.equal(mouseTerminal.rows, 24);
  assert.equal(mouseTerminal.kittyProtocolActive, true);
  mouseTerminal.write("hello");
  mouseTerminal.moveBy(2);
  mouseTerminal.hideCursor();
  mouseTerminal.showCursor();
  mouseTerminal.clearLine();
  mouseTerminal.clearFromCursor();
  mouseTerminal.clearScreen();
  mouseTerminal.setTitle("MixCode");
  mouseTerminal.setProgress(true);
  await mouseTerminal.drainInput();
  mouseTerminal.stop();
  await mouseTerminal.drainInput();

  assert.equal(starts, 1);
  assert.equal(stops, 1);
  assert.equal(drains, 3);
  assert.equal(clears, 2);
  assert.equal(writes[0], `${AUTOWRAP_DISABLE}${MOUSE_REPORTING_ENABLE}`);
  assert.equal(writes[1], "hello");
  assert.equal(writes[2], `${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
  assert.equal(writes[3], `${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
  assert.equal(writes.length, 4);
  assert.deepEqual(calls, [
    "move:2",
    "hide",
    "show",
    "clearLine",
    "clearFromCursor",
    "title:MixCode",
    "progress:true",
  ]);
});

test("fuzzy matching mirrors Pi TUI scoring semantics", () => {
  assert.equal(fuzzyContains("mc", "MixCode"), true);
  assert.equal(fuzzyContains("cm", "MixCode"), false);
  assert.equal(fuzzyContains("", ""), true);
  assert.equal(fuzzyMatch("", "abc"), 0);
  assert.equal(fuzzyMatch("a", ""), undefined);
  assert.equal(fuzzyMatch("mc", "MixCode"), -10.7);
  assert.equal(fuzzyMatch("abcdef", "abc"), undefined);
  assert.deepEqual(fuzzyMatchBatch("ab", ["ab", "alphabet", "cab"], 2), [
    [-124.9, "ab"],
    [-6.5, "alphabet"],
  ]);
  assert.deepEqual([...fuzzyMatchBatchScored("mc", ["MixCode", "abc"]).entries()], [[0, -10.7]]);
});

test("commands parse prompts, slash commands, shell commands, and suggestions", () => {
  assert.deepEqual(parseInput("hello"), { kind: "prompt", args: "hello" });
  assert.deepEqual(parseInput("!pwd"), {
    kind: "shell",
    command: "shell",
    args: "pwd",
    excludeFromContext: false,
  });
  assert.deepEqual(parseInput("!!pwd"), {
    kind: "shell",
    command: "shell",
    args: "pwd",
    excludeFromContext: true,
  });
  assert.deepEqual(parseInput("/theme mixcode"), {
    kind: "local-command",
    command: "theme",
    args: "mixcode",
  });
  assert.deepEqual(parseInput("/save-workspace main"), {
    kind: "local-command",
    command: "save-workspace",
    args: "main",
  });
  assert.deepEqual(parseInput("/export chatlog"), {
    kind: "local-command",
    command: "export",
    args: "chatlog",
  });
  assert.deepEqual(parseInput("/import ./session.jsonl /repo"), {
    kind: "local-command",
    command: "import",
    args: "./session.jsonl /repo",
  });
  assert.deepEqual(parseInput("/system-tools --editor=false"), {
    kind: "local-command",
    command: "system-tools",
    args: "--editor=false",
  });
  assert.deepEqual(parseInput("/session"), {
    kind: "local-command",
    command: "session",
    args: "",
  });
  assert.deepEqual(parseInput("/reload"), {
    kind: "local-command",
    command: "reload",
    args: "",
  });
  assert.deepEqual(parseInput("/vim"), {
    kind: "local-command",
    command: "vim",
    args: "",
  });
  assert.deepEqual(parseInput("/hotkeys"), {
    kind: "local-command",
    command: "hotkeys",
    args: "",
  });
  assert.deepEqual(parseInput("/unknown x"), {
    kind: "local-command",
    command: "unknown",
    args: "x",
  });
  assert.ok(commandSuggestions("/th").includes("theme"));
  assert.ok(commandSuggestions("/system").includes("system-tools"));
  assert.ok(commandSuggestions("/se").includes("session"));
  assert.ok(commandSuggestions("/re").includes("reload"));
  assert.ok(commandSuggestions("/vi").includes("vim"));
  assert.ok(commandSuggestions("/hot").includes("hotkeys"));
  assert.equal(commandSuggestions("tog").includes("toggle-todo"), false);
  assert.ok(commandSuggestions("im").includes("import"));
});

test("json helpers expose malformed and non-object input clearly", () => {
  assert.deepEqual(parseJsonObject('{"a":1}'), { a: 1 });
  assert.equal(stringifyJson({ a: 1 }, true), '{\n  "a": 1\n}');
  assert.equal(stringifyJson({ a: 1 }), '{"a":1}');
  assert.throws(() => parseJsonObject("[]"), /Expected JSON object/);
  assert.throws(() => parseJsonObject("{"), SyntaxError);
});

test("state serializes, persists, normalizes workspaces, and deletes empty workspace file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-state-"));
  try {
    const state = createInitialState("/repo/");
    state.activeTabId = "s1";
    const tabTwoModel = {
      provider: "custom",
      modelId: "tab-two-model",
      displayName: "custom/tab-two-model",
      contextWindow: 123_000,
    };
    state.tabs.push(
      createTab(1, "s1", "/repo", {
        title: "Renamed Agent",
        alias: "alpha",
        unreadDone: true,
        previewMessages: [{ role: "assistant", text: "preview" }],
        previewIndex: 0,
        pendingMessages: ["queued"],
      }),
      createTab(2, "s2", "/repo", {
        model: tabTwoModel,
        contextLimit: tabTwoModel.contextWindow,
        thinkingLevel: "xhigh",
      }),
    );
    const serialized = serializeState(state, 3010);
    assert.equal(serialized.port, 3010);
    assert.deepEqual(serialized.children, ["s1", "s2"]);
    assert.equal((serialized.workdirs as Record<string, string>).s1, "/repo");
    assert.equal((serialized.tab_titles as Record<string, string>).s1, "Renamed Agent");
    assert.deepEqual((serialized.tab_models as Record<string, unknown>).s2, tabTwoModel);
    assert.equal((serialized.tab_variants as Record<string, string>).s2, "xhigh");
    const restored = deserializeState(serialized, "/fallback");
    assert.equal(restored.theme, "claude-warm");
    assert.equal(restored.activeTabId, "s1");
    assert.equal(restored.tabs[0]?.sessionId, "s1");
    assert.equal(restored.tabs[0]?.title, "Renamed Agent");
    assert.equal(restored.tabs[0]?.workdir, "/repo");
    assert.equal(restored.tabs[0]?.alias, "alpha");
    assert.equal(restored.tabs[0]?.unreadDone, true);
    assert.deepEqual(restored.tabs[0]?.previewMessages, [{ role: "assistant", text: "preview" }]);

    assert.deepEqual(restored.tabs[0]?.pendingMessages, ["queued"]);
    assert.equal(restored.tabs[1]?.model.modelId, "tab-two-model");
    assert.equal(restored.tabs[1]?.contextLimit, 123_000);
    assert.equal(restored.tabs[1]?.thinkingLevel, "xhigh");

    assert.equal(stateFileForPort(dir, 0), join(dir, "mixcode_state.json"));
    assert.equal(stateFileForPort(dir, 3010), join(dir, "mixcode_state_3010.json"));
    assert.notEqual(scopedStateDir(dir, "/repo-a"), scopedStateDir(dir, "/repo-b"));
    assert.equal(scopedStateDir(dir, "/repo-a///"), scopedStateDir(dir, "/repo-a"));

    const stateFile = stateFileForPort(dir, 3010);
    await saveStateFile(stateFile, state, 3010);
    assert.equal((await loadStateFile(stateFile, "/fallback")).workdir, "/repo/");
    const concurrentState = createInitialState("/repo");
    const concurrentFile = stateFileForPort(dir, 4010);
    await Promise.all(
      Array.from({ length: 8 }, () => saveStateFile(concurrentFile, concurrentState, 4010)),
    );
    assert.equal((await loadStateFile(concurrentFile, "/fallback")).workdir, "/repo");
    await assert.rejects(
      writeFile(stateFile, "[]").then(() => loadStateFile(stateFile, "/fallback")),
      /Invalid state file/,
    );
    assert.throws(() => deserializeState({ theme: "not-a-theme" }, "/fallback"), /Unknown theme/);
    const fallback = deserializeState({ variant: "bad", active_tab: 1 }, "/fallback");
    assert.equal(fallback.workdir, "/fallback");
    assert.equal(fallback.activeTabId, "config");
    const defaultTitle = createInitialState("/fallback");
    defaultTitle.tabs.push(createTab(1, "default-title", "/fallback"));
    const defaultTitleRestored = deserializeState(serializeState(defaultTitle, 0), "/fallback");
    assert.equal(defaultTitleRestored.tabs[0]?.title, "Agent-01");
    const minimal = deserializeState(
      {
        children: ["", "x"],
        workdirs: [],
        tab_titles: { x: "Worker" },
        tab_aliases: [],
        preview_messages: { x: "bad" },
        preview_indices: { x: "bad" },
        pending_messages: { x: "bad" },
      },
      "/fallback",
    );
    assert.deepEqual(
      minimal.tabs.map((tab) => tab.sessionId),
      ["x"],
    );
    assert.equal(minimal.tabs[0]?.title, "Worker");
    assert.deepEqual(minimal.tabs[0]?.previewMessages, []);
    assert.equal(minimal.tabs[0]?.previewIndex, 0);
    assert.deepEqual(minimal.tabs[0]?.pendingMessages, []);
    const normalizedPreview = deserializeState(
      {
        children: ["x"],
        preview_messages: {
          x: [
            { role: "shell", text: "cmd" },
            { role: "weird", text: "u" },
            { role: "assistant", text: "" },
            null,
          ],
        },
        preview_indices: { x: 1 },
      },
      "/fallback",
    );
    assert.deepEqual(normalizedPreview.tabs[0]?.previewMessages, [
      { role: "shell", text: "cmd" },
      { role: "user", text: "u" },
    ]);
    assert.equal(normalizedPreview.tabs[0]?.previewIndex, 1);

    const workspaceFile = join(dir, "workspaces.json");
    await saveWorkspaces(workspaceFile, [
      { name: " main ", children: ["s1", ""], startupWorkdir: "/repo///", updatedAt: "now" },
      { name: "", children: ["bad"], startupWorkdir: "", updatedAt: "" },
    ]);
    assert.deepEqual(await loadWorkspaces(workspaceFile), [
      { name: "main", children: ["s1"], startupWorkdir: "/repo", updatedAt: "now", tabs: [] },
    ]);
    await writeFile(
      workspaceFile,
      JSON.stringify([
        { name: "partial", children: ["x"] },
        { name: 1, children: [] },
        { name: "bad", children: "x" },
      ]),
      "utf8",
    );
    assert.deepEqual(await loadWorkspaces(workspaceFile), [
      { name: "partial", children: ["x"], startupWorkdir: "", updatedAt: "", tabs: [] },
    ]);
    assert.equal(normalizeStartupWorkdir(" /tmp/// "), "/tmp");
    await assert.rejects(
      writeFile(workspaceFile, "{}").then(() => loadWorkspaces(workspaceFile)),
      /Invalid workspace file/,
    );
    await saveWorkspaces(workspaceFile, [
      { name: "main", children: ["s1"], startupWorkdir: "/repo", updatedAt: "now" },
      { name: "keep", children: ["s2"], startupWorkdir: "/repo", updatedAt: "later" },
    ]);
    await deleteWorkspace(workspaceFile, "main");
    assert.equal((await loadWorkspaces(workspaceFile)).length, 1);
    await deleteWorkspace(workspaceFile, "keep");
    await assert.rejects(readFile(workspaceFile), /ENOENT/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project file utilities scan and rank project references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-file-picker-"));
  try {
    await mkdir(join(dir, "src", "nested"), { recursive: true });
    await mkdir(join(dir, "alpha"), { recursive: true });
    await mkdir(join(dir, "alpha", "deep"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "image.png"), "");
    await writeFile(join(dir, "src", "index.ts"), "");
    await writeFile(join(dir, "src", "nested", "feature test.ts"), "");
    await writeFile(join(dir, "alpha", "one.ts"), "");
    await writeFile(join(dir, "alpha", "deep", "two.ts"), "");
    await writeFile(join(dir, "loose"), "");
    await writeFile(join(dir, "node_modules", "pkg", "index.js"), "");
    await writeFile(join(dir, ".git", "config"), "");

    const files = await scanProjectFiles(dir);
    assert.ok(files.includes("src/"));
    assert.ok(files.includes("src/index.ts"));
    assert.ok(files.includes("src/nested/feature test.ts"));
    assert.equal(
      files.some((file) => file.startsWith("node_modules/pkg")),
      false,
    );
    assert.ok((await scanProjectFiles(dir, 1)).length <= 1);
    assert.ok((await scanProjectFiles(dir, 2)).length <= 2);
    assert.deepEqual(await scanProjectFiles(dir, 0), []);
    assert.equal((await scanProjectFiles(dir, 3)).length, 3);

    assert.deepEqual(searchProjectFiles("", files, 2), files.slice(0, 2));
    assert.deepEqual(searchProjectFiles("src/", files), ["src/index.ts", "src/nested/"]);
    assert.deepEqual(searchProjectFiles("alpha/", files), ["alpha/deep/", "alpha/one.ts"]);
    assert.deepEqual(searchProjectFiles("src/nested/", files), ["src/nested/feature test.ts"]);
    assert.deepEqual(searchProjectFiles("src/nested/feature test.ts", files), [
      "src/nested/feature test.ts",
    ]);
    assert.ok(searchProjectFiles("feature", files).includes("src/nested/feature test.ts"));
    assert.ok(searchProjectFiles("two", files).includes("alpha/deep/two.ts"));
    assert.equal(
      searchProjectFiles("image", ["refs/pi/packages/ai/src/image.ts", "image.png"])[0],
      "image.png",
    );
    assert.deepEqual(searchProjectFiles("loose", ["alpha/loose", "beta/loose"], 1), [
      "alpha/loose",
    ]);
    assert.deepEqual(searchProjectFiles("beta/loose", ["alpha/loose", "beta/loose"], 1), [
      "beta/loose",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project file scans respect git ignore rules", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-file-picker-gitignore-"));
  try {
    await execFileAsync("git", ["init"], { cwd: dir });
    await mkdir(join(dir, "src"), { recursive: true });
    await mkdir(join(dir, "ignored-dir"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "ignored-dir/\n*.log\n");
    await writeFile(join(dir, "src", "visible.ts"), "");
    await writeFile(join(dir, "src", "ignored.log"), "");
    await writeFile(join(dir, "ignored-dir", "hidden.ts"), "");

    const files = await scanProjectFiles(dir);
    assert.ok(files.includes("src/"));
    assert.ok(files.includes("src/visible.ts"));
    assert.equal(files.includes("src/ignored.log"), false);
    assert.equal(files.includes("ignored-dir/"), false);
    assert.equal(files.includes("ignored-dir/hidden.ts"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
