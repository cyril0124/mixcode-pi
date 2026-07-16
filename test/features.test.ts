import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { availableThinkingLevelsForModel } from "../src/core/thinking-levels.js";
import {
  AUTO_SAVED_WORKSPACE,
  addAgentTab,
  autoSaveWorkspace,
  closeAgentTab,
  createInitialState,
  createDialogRequest,
  createTab,
  acceptPickerSelection,
  buildDialogAnswerPrompt,
  buildDialogRejectionPrompt,
  completeWorkdirPickerSelection,
  createPicker,
  filteredPickerItems,
  finalizeDialogRequest,
  movePickerSelection,
  moveQuestion,
  moveQuestionOption,
  nextTabId,
  questionProgress,
  renameAgentTab,
  resolveFdBinary,
  restoreWorkspaceOrder,
  scanProjectFiles,
  searchProjectFiles,
  fdFileSuggestions,
  snapshotWorkspace,
  statusFromAgentEvent,
  toggleCurrentQuestionOption,
  upsertWorkspace,
  answerCurrentQuestion,
  updatePickerQuery,
} from "../src/index.js";

test("unknown model capabilities expose only off thinking", () => {
  assert.deepEqual(
    availableThinkingLevelsForModel({
      provider: "legacy",
      modelId: "unknown",
      displayName: "legacy/unknown",
      contextWindow: 1,
    }),
    ["off"],
  );
});

test("workspace snapshots preserve tab order and auto-save name", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "b", "/repo"), createTab(2, "a", "/repo"));
  const now = new Date("2026-05-09T00:00:00.000Z");
  const snapshot = snapshotWorkspace(state, "main", now);
  assert.deepEqual(snapshot.children, ["b", "a"]);
  assert.equal(snapshot.updatedAt, now.toISOString());
  const workspaces = autoSaveWorkspace(state, [snapshot], now);
  assert.ok(workspaces.some((workspace) => workspace.name === AUTO_SAVED_WORKSPACE));
  const replaced = upsertWorkspace(workspaces, { ...snapshot, children: ["a"] });
  assert.deepEqual(replaced.find((workspace) => workspace.name === "main")?.children, ["a"]);
  restoreWorkspaceOrder(state, { ...snapshot, children: ["a", "missing", "b"] });
  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["a", "b"],
  );
  assert.equal(state.activeTabId, "a");
  restoreWorkspaceOrder(state, { ...snapshot, children: [] });
  assert.equal(state.activeTabId, "config");
});

test("question state tracks answers, movement, progress, and bounds", () => {
  const request = createDialogRequest("r1", "s1", [
    {
      header: "H1",
      question: "Choose",
      options: [{ label: "A", description: "a" }],
      multiple: false,
      custom: true,
    },
    { header: "H2", question: "Why", options: [], multiple: false, custom: true },
  ]);
  assert.equal(questionProgress(request), "1/2");
  assert.deepEqual(request.highlightedOptionIndices, [0, 0]);
  moveQuestionOption(request, 1);
  assert.equal(request.highlightedOptionIndices[0], 1);
  toggleCurrentQuestionOption(request);
  assert.equal(request.editingCustomIndex, 0);
  request.editingCustomIndex = undefined;
  assert.equal(buildDialogRejectionPrompt(request), "Question request r1 was rejected by user.");
  answerCurrentQuestion(request, ["A"], "custom");
  moveQuestion(request, 1);
  moveQuestionOption(request, 1);
  answerCurrentQuestion(request, [], "because");
  assert.equal(questionProgress(request), "2/2");
  assert.deepEqual(finalizeDialogRequest(request), [
    { question: "Choose", answers: ["A"], customAnswer: "custom" },
    { question: "Why", answers: [], customAnswer: "because" },
  ]);
  assert.match(buildDialogAnswerPrompt(request), /Selected answers: A/);
  assert.match(buildDialogAnswerPrompt(request), /Custom answer: because/);
  assert.throws(() => moveQuestion(request, 1), /out of range/);
  request.currentQuestionIndex = 99;
  assert.throws(() => answerCurrentQuestion(request, [], ""), /out of range/);
  assert.throws(() => moveQuestionOption(request, 1), /out of range/);
  assert.throws(() => toggleCurrentQuestionOption(request), /out of range/);
  assert.equal(questionProgress(createDialogRequest("empty", "s1", [])), "0/0");
});

test("question option toggles single, multiple, empty, and invalid option states", () => {
  const request = createDialogRequest("r2", "s1", [
    {
      header: "Single",
      question: "Pick one",
      options: [
        { label: "A", description: "" },
        { label: "B", description: "" },
      ],
      multiple: false,
      custom: false,
    },
    {
      header: "Multi",
      question: "Pick many",
      options: [
        { label: "C", description: "" },
        { label: "D", description: "" },
      ],
      multiple: true,
      custom: false,
    },
    { header: "Empty", question: "No options", options: [], multiple: false, custom: false },
  ]);

  toggleCurrentQuestionOption(request);
  assert.deepEqual(request.selectedAnswers[0], ["A"]);
  toggleCurrentQuestionOption(request);
  assert.deepEqual(request.selectedAnswers[0], []);
  moveQuestionOption(request, 1);
  toggleCurrentQuestionOption(request);
  assert.deepEqual(request.selectedAnswers[0], ["B"]);
  moveQuestion(request, 1);
  toggleCurrentQuestionOption(request);
  moveQuestionOption(request, 1);
  toggleCurrentQuestionOption(request);
  assert.deepEqual(request.selectedAnswers[1], ["C", "D"]);
  toggleCurrentQuestionOption(request);
  assert.deepEqual(request.selectedAnswers[1], ["C"]);
  moveQuestion(request, 1);
  toggleCurrentQuestionOption(request);
  assert.deepEqual(request.selectedAnswers[2], []);
  request.currentQuestionIndex = 0;
  request.highlightedOptionIndices[0] = 99;
  assert.throws(() => toggleCurrentQuestionOption(request), /Question option index out of range/);

  const sparse = createDialogRequest("r3", "s1", [
    {
      header: "Sparse",
      question: "Defaults?",
      options: [{ label: "A", description: "" }],
      multiple: false,
      custom: false,
    },
  ]);
  sparse.highlightedOptionIndices = [];
  sparse.selectedAnswers = [];
  sparse.customAnswers = [];
  moveQuestionOption(sparse, 0);
  toggleCurrentQuestionOption(sparse);
  assert.deepEqual(sparse.selectedAnswers[0], ["A"]);
  sparse.selectedAnswers = [];
  sparse.customAnswers = [];
  assert.deepEqual(finalizeDialogRequest(sparse), [
    { question: "Defaults?", answers: [], customAnswer: "" },
  ]);
  assert.match(buildDialogAnswerPrompt(sparse), /\(no selected option\)/);
  assert.doesNotMatch(buildDialogAnswerPrompt(sparse), /Custom answer:/);
});

test("tab operations add, close, rename, and rotate through config", () => {
  const state = createInitialState("/repo");
  const one = addAgentTab(state, "s1");
  const two = addAgentTab(state, "s2");
  assert.equal(one.index, 1);
  assert.equal(two.index, 2);
  assert.throws(() => addAgentTab(state, "s1"), /already exists/);
  renameAgentTab(state, "s2", " Worker ");
  assert.equal(state.tabs[1]?.title, "Worker");
  assert.throws(() => renameAgentTab(state, "s2", " "), /cannot be empty/);
  assert.equal(nextTabId(state, 1), "config");
  state.activeTabId = "config";
  assert.equal(nextTabId(state, -1), "s2");
  const removed = closeAgentTab(state, "s2");
  assert.equal(removed.sessionId, "s2");
  assert.equal(state.activeTabId, "config");
  state.activeTabId = "s1";
  closeAgentTab(state, "s1");
  assert.equal(state.activeTabId, "config");
  addAgentTab(state, "s3");
  addAgentTab(state, "s4");
  state.activeTabId = "s3";
  closeAgentTab(state, "s3");
  assert.equal(state.activeTabId, "s4");
  assert.throws(() => closeAgentTab(state, "missing"), /Unknown tab/);
  assert.throws(() => renameAgentTab(state, "missing", "x"), /Unknown tab/);
});

test("picker state filters, moves, and accepts selections", () => {
  const state = createInitialState("/repo");
  state.availableModels.push({
    provider: "openai",
    modelId: "gpt-4.1",
    displayName: "openai/gpt-4.1",
    contextWindow: 1_000_000,
  });
  const tab = createTab(1, "s1", "/repo", {
    model: state.availableModels[1]!,
    thinkingLevel: "high",
  });
  const models = createPicker("models", state, tab);
  assert.equal(models.selectedIndex, 1);
  updatePickerQuery(models, "faux");
  assert.deepEqual(
    filteredPickerItems(models).map((item) => item.id),
    ["faux/faux-1"],
  );
  assert.equal(acceptPickerSelection(models)?.id, "faux/faux-1");
  movePickerSelection(models, 1);
  assert.equal(models.selectedIndex, 0);

  tab.model = { ...tab.model, reasoning: true, thinkingLevelMap: { max: "max" } };
  const thinking = createPicker("thinking", state, tab);
  assert.equal(acceptPickerSelection(thinking)?.id, "high");
  updatePickerQuery(thinking, "max");
  assert.deepEqual(
    filteredPickerItems(thinking).map((item) => item.id),
    ["max"],
  );
  updatePickerQuery(thinking, "zz");
  assert.deepEqual(filteredPickerItems(thinking), []);
  movePickerSelection(thinking, 1);
  assert.equal(thinking.selectedIndex, 0);

  const emptyModelState = createInitialState("/fallback");
  emptyModelState.availableModels = [];
  assert.equal(acceptPickerSelection(createPicker("models", emptyModelState)), undefined);
  const workdir = createPicker("workdir", state);
  assert.equal(workdir.browsingDir, "/repo");
});

test("workdir picker completes direct child directories only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-picker-"));
  try {
    await mkdir(join(dir, "alpha"), { recursive: true });
    await mkdir(join(dir, "beta"), { recursive: true });
    await writeFile(join(dir, "app.ts"), "");

    const state = createInitialState(dir);
    const picker = createPicker("workdir", state);
    assert.equal(picker.query, "");
    assert.equal(picker.browsingDir, dir);
    // Filter by 'al' to match only alpha
    updatePickerQuery(picker, "al");
    assert.deepEqual(
      filteredPickerItems(picker).map((item) => item.label),
      ["alpha/"],
    );
    assert.deepEqual(
      filteredPickerItems(picker).map((item) => item.description),
      ["directory"],
    );
    assert.equal(acceptPickerSelection(picker)?.id, join(dir, "alpha"));

    // Path-style query (contains /) treated as custom path input
    updatePickerQuery(picker, "alpha/");
    assert.equal(acceptPickerSelection(picker)?.id, join(dir, "alpha"));

    updatePickerQuery(picker, "missing/path");
    assert.equal(filteredPickerItems(picker)[0]?.description, "custom path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workdir picker covers home absolute and empty query branches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-branches-"));
  const oldHome = process.env.HOME;
  try {
    const home = join(dir, "home");
    await mkdir(join(home, "proj"), { recursive: true });
    await mkdir(join(dir, "abs"), { recursive: true });
    process.env.HOME = home;

    const state = createInitialState(join(dir, "base"));
    const picker = createPicker("workdir", state);
    // browsingDir is non-existent, shows error item
    assert.match(filteredPickerItems(picker)[0]?.description ?? "", /error/);

    updatePickerQuery(picker, "");
    assert.match(filteredPickerItems(picker)[0]?.description ?? "", /error/);

    // ~ resolves to home directory
    updatePickerQuery(picker, "~");
    assert.equal(acceptPickerSelection(picker)?.id, home);

    // ~/p is treated as custom path input (starts with ~)
    updatePickerQuery(picker, "~/p");
    assert.deepEqual(
      filteredPickerItems(picker).map((item) => item.label),
      ["~/p"],
    );
    assert.equal(acceptPickerSelection(picker)?.id, join(home, "p"));

    // Absolute path with partial match treated as custom path
    updatePickerQuery(picker, `${dir}/a`);
    assert.equal(acceptPickerSelection(picker)?.id, join(dir, "a"));

    assert.equal(completeWorkdirPickerSelection(createPicker("models", state)), false);
    // no-match filter on unreadable dir still shows error, no completeValue
    updatePickerQuery(picker, "no-match");
    picker.selectedIndex = 1;
    assert.equal(completeWorkdirPickerSelection(picker), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await rm(dir, { recursive: true, force: true });
  }
});

test("workdir picker reuses directory listing across query keystrokes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-cache-"));
  try {
    // Enough entries that repeated readdir+sort is clearly more expensive than filter-only.
    await Promise.all(
      Array.from({ length: 2500 }, (_, i) => mkdir(join(dir, `d${String(i).padStart(4, "0")}`))),
    );
    await mkdir(join(dir, "target-hit"));

    const state = createInitialState(dir);
    const picker = createPicker("workdir", state);

    // Warm + populate cache (UI only shows 20 rows; contract is the full listing cache).
    updatePickerQuery(picker, "");
    assert.equal(picker.workdirListingCache?.dirs.length, 2501);
    assert.ok(
      picker.workdirListingCache?.dirs.includes("target-hit"),
      "expected cache to include target-hit",
    );

    const t0 = performance.now();
    for (let i = 0; i < 40; i++) {
      updatePickerQuery(picker, i % 2 === 0 ? "d1" : "d12");
      filteredPickerItems(picker);
    }
    updatePickerQuery(picker, "target");
    const hits = filteredPickerItems(picker);
    const elapsed = performance.now() - t0;

    assert.deepEqual(
      hits.map((item) => item.label),
      ["target-hit/"],
    );
    // Cached path: 40 filters over 2500 names should stay well under a full 40× readdir budget.
    // Uncached was ~40–80ms/key on large dirs; allow generous CI headroom.
    assert.ok(
      elapsed < 200,
      `workdir query loop too slow with cache expected; elapsed=${elapsed.toFixed(1)}ms`,
    );

    // browsingDir change must drop the old listing (navigate into target-hit).
    picker.selectedIndex = 0;
    assert.equal(completeWorkdirPickerSelection(picker), true);
    assert.equal(picker.browsingDir, join(dir, "target-hit"));
    updatePickerQuery(picker, "");
    assert.deepEqual(filteredPickerItems(picker), []);
    assert.equal(picker.workdirListingCache?.browsingDir, join(dir, "target-hit"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("project file scan narrows project tree and ranks basename matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-picker-"));
  try {
    await mkdir(join(dir, "src", "nested"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "");
    await writeFile(join(dir, "src", "nested", "feature.test.ts"), "");
    await writeFile(join(dir, "node_modules", "pkg", "ignored.ts"), "");
    const files = await scanProjectFiles(dir);
    assert.deepEqual(files, ["src/", "src/index.ts", "src/nested/", "src/nested/feature.test.ts"]);
    assert.deepEqual(searchProjectFiles("", files, 1), ["src/"]);
    assert.deepEqual(searchProjectFiles("src/", files, 2), ["src/index.ts", "src/nested/"]);
    assert.deepEqual(searchProjectFiles("ft", files), ["src/nested/feature.test.ts"]);
    assert.deepEqual(searchProjectFiles("nested", files, 1), ["src/nested/"]);
    assert.deepEqual(await scanProjectFiles(dir, 1), ["src/"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("directory completion expands nested dirs matched by trailing path", () => {
  const files = [
    "src/",
    "src/core/",
    "src/core/file-picker.ts",
    "src/core/fuzzy.ts",
    "src/ui/",
    "src/ui/completion.ts",
    "package.json",
  ];
  // Top-level directory still expands via root-anchored match.
  assert.deepEqual(searchProjectFiles("src/", files), ["src/core/", "src/ui/"]);
  // A nested directory typed by its own name (real path "src/core/") must
  // expand its direct children even though the query is not root-anchored.
  assert.deepEqual(searchProjectFiles("core/", files), [
    "src/core/file-picker.ts",
    "src/core/fuzzy.ts",
  ]);
});

test("fd-backed file search expands nested dirs and reflects fresh files (pi parity)", async (t) => {
  const fdPath = resolveFdBinary();
  if (!fdPath) {
    t.skip("fd not installed");
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "mixcode-fd-search-"));
  try {
    await mkdir(join(dir, "src", "core"), { recursive: true });
    await writeFile(join(dir, "src", "core", "alpha.ts"), "");
    await writeFile(join(dir, "src", "core", "beta.ts"), "");
    const signal = new AbortController().signal;
    // A nested directory typed by its own name expands its direct children,
    // matching pi's `fd --full-path` behavior (the originally reported bug).
    const nested = await fdFileSuggestions("core/", { workdir: dir, fdPath, signal });
    const nestedPaths = nested.map((m) => m.displayPath).sort();
    assert.deepEqual(nestedPaths, ["src/core/alpha.ts", "src/core/beta.ts"]);
    // A file created after the initial scan is visible immediately, since fd
    // queries the live tree rather than a cached snapshot.
    await writeFile(join(dir, "src", "core", "gamma.ts"), "");
    const refreshed = await fdFileSuggestions("gamma", { workdir: dir, fdPath, signal });
    assert.ok(refreshed.some((m) => m.displayPath === "src/core/gamma.ts"));
    // Directories sort ahead of files for the same matching term.
    const dirsFirst = await fdFileSuggestions("core", { workdir: dir, fdPath, signal });
    assert.equal(dirsFirst[0]?.displayPath, "src/core/");
    assert.equal(dirsFirst[0]?.isDirectory, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("status mapping follows pi agent events", () => {
  assert.equal(statusFromAgentEvent({ type: "agent_start" }), "running");
  assert.equal(statusFromAgentEvent({ type: "turn_start" }), "thinking");
  assert.equal(statusFromAgentEvent({ type: "agent_end", messages: [] }), "idle");
  assert.equal(
    statusFromAgentEvent({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "x",
      result: {},
      isError: true,
    }),
    "error",
  );
  assert.equal(
    statusFromAgentEvent({
      type: "tool_execution_end",
      toolCallId: "1",
      toolName: "x",
      result: {},
      isError: false,
    }),
    "running",
  );
  assert.equal(
    statusFromAgentEvent({ type: "turn_end", message: {} as never, toolResults: [] }),
    undefined,
  );
});
