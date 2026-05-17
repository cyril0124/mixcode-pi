import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
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
  restoreWorkspaceOrder,
  scanProjectFiles,
  searchProjectFiles,
  snapshotWorkspace,
  statusFromAgentEvent,
  toggleCurrentQuestionOption,
  upsertWorkspace,
  answerCurrentQuestion,
  updatePickerQuery,
} from "../src/index.js";

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

  const thinking = createPicker("thinking", state, tab);
  assert.equal(acceptPickerSelection(thinking)?.id, "high");
  updatePickerQuery(thinking, "xh");
  assert.deepEqual(
    filteredPickerItems(thinking).map((item) => item.id),
    ["xhigh"],
  );
  updatePickerQuery(thinking, "zz");
  assert.deepEqual(filteredPickerItems(thinking), []);
  movePickerSelection(thinking, 1);
  assert.equal(thinking.selectedIndex, 0);

  const emptyModelState = createInitialState("/fallback");
  emptyModelState.availableModels = [];
  const emptyModels = createPicker("models", emptyModelState);
  assert.equal(acceptPickerSelection(emptyModels), undefined);
  const theme = createPicker("theme", state);
  assert.equal(theme.title, "Choose Theme");
  const workdir = createPicker("workdir", state);
  assert.equal(workdir.items[0]?.id, "/repo");
  assert.equal(workdir.query, "/repo");
});

test("workdir picker completes direct child directories only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workdir-picker-"));
  try {
    await mkdir(join(dir, "alpha"), { recursive: true });
    await mkdir(join(dir, "beta"), { recursive: true });
    await writeFile(join(dir, "app.ts"), "");

    const state = createInitialState(dir);
    const picker = createPicker("workdir", state);
    assert.equal(picker.query, dir);
    updatePickerQuery(picker, "a");
    assert.deepEqual(
      filteredPickerItems(picker).map((item) => item.label),
      ["alpha/", "a"],
    );
    assert.deepEqual(
      filteredPickerItems(picker).map((item) => item.description),
      ["directory", "custom workdir"],
    );
    assert.equal(acceptPickerSelection(picker)?.id, join(dir, "alpha"));

    updatePickerQuery(picker, "alpha/");
    assert.equal(acceptPickerSelection(picker)?.id, join(dir, "alpha"));

    updatePickerQuery(picker, "missing/path");
    assert.match(filteredPickerItems(picker)[0]?.description ?? "", /parent unreadable/);
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
    assert.equal(filteredPickerItems(picker)[0]?.id, join(dir, "base"));

    updatePickerQuery(picker, "");
    assert.equal(filteredPickerItems(picker)[0]?.id, join(dir, "base"));

    updatePickerQuery(picker, "~");
    assert.equal(acceptPickerSelection(picker)?.id, home);

    updatePickerQuery(picker, "~/p");
    assert.deepEqual(
      filteredPickerItems(picker).map((item) => item.label),
      ["~/proj/", "~/p"],
    );
    assert.equal(acceptPickerSelection(picker)?.id, join(home, "proj/"));

    updatePickerQuery(picker, `${dir}/a`);
    assert.equal(acceptPickerSelection(picker)?.id, join(dir, "abs"));

    assert.equal(completeWorkdirPickerSelection(createPicker("models", state)), false);
    updatePickerQuery(picker, "no-match");
    picker.selectedIndex = 1;
    assert.equal(completeWorkdirPickerSelection(picker), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
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

test("project file completion scans and ranks nested matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-global-picker-"));
  try {
    await mkdir(join(dir, "src", "nested"), { recursive: true });
    await mkdir(join(dir, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(dir, "src", "index.ts"), "");
    await writeFile(join(dir, "src", "nested", "feature.test.ts"), "");
    await writeFile(join(dir, "node_modules", "pkg", "ignored.ts"), "");

    const files = await scanProjectFiles(dir);
    assert.deepEqual(files, ["src/", "src/index.ts", "src/nested/", "src/nested/feature.test.ts"]);
    assert.ok(!files.some((file) => file.includes("ignored.ts")));
    assert.equal(searchProjectFiles("ft", files)[0], "src/nested/feature.test.ts");
    assert.deepEqual(searchProjectFiles("src/", files, 5), ["src/index.ts", "src/nested/"]);
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
