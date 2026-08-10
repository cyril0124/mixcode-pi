import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  commandSuggestions,
  createInitialState,
  createTab,
  deleteWorkspace,
  deserializeState,
  fuzzyMatch,
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
  parseJsoncObject,
  saveStateFile,
  saveWorkspaces,
  scopedStateDir,
  serializeState,
  stateFileForPort,
  withMouseReporting,
} from "../src/index.js";
import type { Terminal } from "@earendil-works/pi-tui";

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
  let starts = 0;
  let stops = 0;
  let clears = 0;
  const terminal: Terminal = {
    start: () => {
      starts++;
    },
    stop: () => {
      stops++;
    },
    drainInput: async () => undefined,
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
    moveBy: () => undefined,
    hideCursor: () => undefined,
    showCursor: () => undefined,
    clearLine: () => undefined,
    clearFromCursor: () => undefined,
    clearScreen: () => {
      clears++;
    },
    setTitle: () => undefined,
    setProgress: () => undefined,
  };

  const mouseTerminal = withMouseReporting(terminal);
  mouseTerminal.start(
    () => undefined,
    () => undefined,
  );
  mouseTerminal.write("hello");
  mouseTerminal.clearScreen();
  mouseTerminal.stop();

  assert.equal(starts, 1);
  assert.equal(stops, 1);
  // Wrapper re-sends disable sequences around clearScreen; stop restores again.
  assert.ok(clears >= 1);
  assert.equal(writes[0], `${AUTOWRAP_DISABLE}${MOUSE_REPORTING_ENABLE}`);
  assert.equal(writes[1], "hello");
  assert.equal(writes[2], `${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
  assert.equal(writes.at(-1), `${MOUSE_REPORTING_DISABLE}${AUTOWRAP_ENABLE}`);
});

test("fuzzyMatch adapts Pi TUI score (lower better; undefined = no match)", () => {
  assert.equal(fuzzyMatch("", "abc"), 0);
  assert.equal(fuzzyMatch("a", ""), undefined);
  assert.equal(fuzzyMatch("mc", "MixCode"), -10.7);
  assert.equal(fuzzyMatch("abcdef", "abc"), undefined);
  assert.equal(fuzzyMatch("cm", "MixCode"), undefined);
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
  assert.deepEqual(parseInput("/settings"), {
    kind: "local-command",
    command: "settings",
    args: "",
  });
  assert.deepEqual(parseInput("/save-workspace main"), {
    kind: "local-command",
    command: "save-workspace",
    args: "main",
  });
  assert.deepEqual(parseInput("/view chatlog"), {
    kind: "local-command",
    command: "view",
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
  assert.deepEqual(parseInput("/login"), {
    kind: "local-command",
    command: "login",
    args: "",
  });
  assert.deepEqual(parseInput("/login openai"), {
    kind: "local-command",
    command: "login",
    args: "openai",
  });
  assert.deepEqual(parseInput("/logout"), {
    kind: "local-command",
    command: "logout",
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
  assert.ok(commandSuggestions("/set").includes("settings"));
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
  assert.throws(() => parseJsonObject("[]"), /Expected JSON object/);
  assert.throws(() => parseJsonObject("{"), SyntaxError);
});

test("jsonc helper accepts comments and trailing commas", () => {
  assert.deepEqual(
    parseJsoncObject(`{
      // Comments are accepted.
      "items": [1, 2,],
      "text": "literal ,} and escaped \\" quote",
    }`),
    { items: [1, 2], text: 'literal ,} and escaped " quote' },
  );
  assert.throws(() => parseJsoncObject("[]"), /Expected JSON object/);
  assert.throws(() => parseJsoncObject('{"a":1,'), SyntaxError);
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
      reasoning: true,
      thinkingLevelMap: { max: "max" },
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
        thinkingLevel: "max",
      }),
    );
    const serialized = serializeState(state);
    assert.deepEqual(serialized.children, ["s1", "s2"]);
    assert.equal((serialized.workdirs as Record<string, string>).s1, "/repo");
    assert.equal((serialized.tab_titles as Record<string, string>).s1, "Renamed Agent");
    assert.deepEqual((serialized.tab_models as Record<string, unknown>).s2, tabTwoModel);
    assert.equal((serialized.tab_variants as Record<string, string>).s2, "max");
    const restored = deserializeState(serialized, "/fallback");
    assert.equal(restored.theme, "claude-warm");
    assert.equal(restored.activeTabId, "config");
    assert.equal(restored.tabs[0]?.sessionId, "s1");
    assert.equal(restored.tabs[0]?.title, "Renamed Agent");
    assert.equal(restored.tabs[0]?.workdir, "/repo");
    assert.equal(restored.tabs[0]?.alias, "alpha");
    assert.equal(restored.tabs[0]?.unreadDone, true);
    assert.deepEqual(restored.tabs[0]?.previewMessages, [{ role: "assistant", text: "preview" }]);

    assert.deepEqual(restored.tabs[0]?.pendingMessages, ["queued"]);
    assert.equal(restored.tabs[1]?.model.modelId, "tab-two-model");
    assert.equal(restored.tabs[1]?.contextLimit, 123_000);
    assert.equal(restored.tabs[1]?.thinkingLevel, "max");

    assert.equal(stateFileForPort(dir, 0), join(dir, "mixcode_state.json"));
    assert.equal(stateFileForPort(dir, 3010), join(dir, "mixcode_state_3010.json"));
    assert.notEqual(scopedStateDir(dir, "/repo-a"), scopedStateDir(dir, "/repo-b"));
    assert.equal(scopedStateDir(dir, "/repo-a///"), scopedStateDir(dir, "/repo-a"));

    const stateFile = stateFileForPort(dir, 3010);
    await saveStateFile(stateFile, state);
    assert.equal((await loadStateFile(stateFile, "/fallback")).workdir, "/repo/");
    const concurrentState = createInitialState("/repo");
    const concurrentFile = stateFileForPort(dir, 4010);
    await Promise.all(
      Array.from({ length: 8 }, () => saveStateFile(concurrentFile, concurrentState)),
    );
    assert.equal((await loadStateFile(concurrentFile, "/fallback")).workdir, "/repo");
    await assert.rejects(
      writeFile(stateFile, "[]").then(() => loadStateFile(stateFile, "/fallback")),
      /Invalid state file/,
    );
    const invalidTheme = deserializeState({ theme: "not-a-theme" }, "/fallback");
    assert.equal(invalidTheme.theme, "not-a-theme");
    const fallback = deserializeState({ variant: "bad" }, "/fallback");
    assert.equal(fallback.workdir, "/fallback");
    assert.equal(fallback.activeTabId, "config");
    const defaultTitle = createInitialState("/fallback");
    defaultTitle.tabs.push(createTab(1, "default-title", "/fallback"));
    const defaultTitleRestored = deserializeState(serializeState(defaultTitle), "/fallback");
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


test("deleteWorkspace rejects unknown names", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-ws-unknown-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    await saveWorkspaces(workspaceFile, [
      { name: "keep", children: ["s1"], startupWorkdir: "/repo", updatedAt: "now" },
    ]);
    await assert.rejects(deleteWorkspace(workspaceFile, "missing"), /Unknown workspace: missing/);
    assert.equal((await loadWorkspaces(workspaceFile)).length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
