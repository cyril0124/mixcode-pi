import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  buildPrompt,
  commandSuggestions,
  createInitialState,
  createTab,
  applyGoalAction,
  buildGoalPrompt,
  consumeGoalCompletionMarker,
  deleteWorkspace,
  deserializeState,
  extractFileRefs,
  extractSkillRefs,
  stripSkillInjection,
  SKILL_INJECTION_SEPARATOR,
  fuzzyContains,
  fuzzyMatch,
  fuzzyMatchBatch,
  fuzzyMatchBatchScored,
  loadStateFile,
  loadWorkspaces,
  normalizeStartupWorkdir,
  normalizeGoal,
  parseGoalCommandArgs,
  renderGoalSummary,
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

test("generic pickers cover workdir completion and empty selection edges", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-picker-"));
  try {
    await mkdir(join(dir, "alpha"), { recursive: true });
    await mkdir(join(dir, "beta"), { recursive: true });
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.activeTabId = "s1";
    state.availableModels.push({
      provider: "custom",
      modelId: "m1",
      displayName: "custom/m1",
      contextWindow: 42,
    });

    const modelPicker = createPicker("models", state, tab);
    assert.ok(filteredPickerItems(modelPicker).some((item) => item.id === "faux/faux-1"));
    updatePickerQuery(modelPicker, "custom");
    assert.deepEqual(
      filteredPickerItems(modelPicker).map((item) => item.id),
      ["custom/m1"],
    );
    updatePickerQuery(modelPicker, "missing");
    movePickerSelection(modelPicker, 1);
    assert.equal(modelPicker.selectedIndex, 0);
    assert.equal(acceptPickerSelection(modelPicker), undefined);
    assert.equal(completeWorkdirPickerSelection(modelPicker), false);

    const workdirPicker = createPicker("workdir", state, tab);
    assert.equal(workdirPicker.query, dir);
    updatePickerQuery(workdirPicker, "");
    assert.equal(filteredPickerItems(workdirPicker)[0]?.id, dir);
    assert.equal(completeWorkdirPickerSelection(workdirPicker), false);
    updatePickerQuery(workdirPicker, "a");
    assert.equal(filteredPickerItems(workdirPicker)[0]?.completeValue, "alpha/");
    assert.equal(completeWorkdirPickerSelection(workdirPicker), true);
    assert.equal(workdirPicker.query, "alpha/");
    movePickerSelection(workdirPicker, 1);
    assert.ok(filteredPickerItems(workdirPicker).some((item) => item.id === join(dir, "alpha")));
    updatePickerQuery(workdirPicker, `${dir}/`);
    assert.ok(filteredPickerItems(workdirPicker).some((item) => item.id === join(dir, "alpha")));
    updatePickerQuery(workdirPicker, "~/");
    assert.ok(filteredPickerItems(workdirPicker)[0]?.id);
    updatePickerQuery(workdirPicker, "~");
    assert.ok(filteredPickerItems(workdirPicker)[0]?.id);
    updatePickerQuery(workdirPicker, `${join(dir, "missing")}/a`);
    assert.ok(
      filteredPickerItems(workdirPicker).some((item) => /parent unreadable/.test(item.description)),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("goal state applies local actions and completion marker", () => {
  const tab = createTab(1, "s1", "/repo");
  assert.deepEqual(parseGoalCommandArgs(""), { action: "status", text: "" });
  assert.deepEqual(parseGoalCommandArgs("pause ignored words"), {
    action: "pause",
    text: "ignored words",
  });
  assert.deepEqual(parseGoalCommandArgs("ship feature"), { action: "set", text: "ship feature" });
  assert.deepEqual(parseGoalCommandArgs("set ship feature"), {
    action: "set",
    text: "ship feature",
  });
  assert.match(applyGoalAction(tab, "status").message, /No active goal/);
  assert.match(applyGoalAction(tab, "clear").message, /Goal cleared/);
  assert.throws(() => applyGoalAction(tab, "pause"), /No goal to pause/);
  assert.throws(() => applyGoalAction(tab, "complete"), /No goal to complete/);
  assert.throws(() => applyGoalAction(tab, "set", ""), /Goal objective cannot be empty/);
  const set = applyGoalAction(tab, "set", "ship feature", new Date("2026-01-01T00:00:00.000Z"));
  assert.equal(tab.goal?.status, "active");
  assert.match(set.prompt ?? "", /Start working toward this MixCode goal/);
  assert.match(applyGoalAction(tab, "status").message, /created: 2026/);
  assert.match(buildGoalPrompt("resume", "ship feature"), /Resume working/);
  assert.match(
    applyGoalAction(tab, "pause", "", new Date("2026-01-02T00:00:00.000Z")).message,
    /paused/,
  );
  assert.equal(tab.goal?.status, "paused");
  assert.match(applyGoalAction(tab, "resume").prompt ?? "", /MIXCODE_GOAL_COMPLETE/);
  assert.equal(tab.goal?.status, "active");
  consumeGoalCompletionMarker(
    tab,
    "done\nMIXCODE_GOAL_COMPLETE",
    new Date("2026-01-03T00:00:00.000Z"),
  );
  assert.equal(tab.goal?.status, "complete");
  consumeGoalCompletionMarker(
    tab,
    "again\nMIXCODE_GOAL_COMPLETE",
    new Date("2026-01-04T00:00:00.000Z"),
  );
  assert.equal(tab.goal?.updatedAt, "2026-01-03T00:00:00.000Z");
  applyGoalAction(tab, "resume");
  consumeGoalCompletionMarker(tab, buildGoalPrompt("set", "ship feature"));
  assert.equal(tab.goal?.status, "active");
  consumeGoalCompletionMarker(tab, "final response:\nMIXCODE_GOAL_COMPLETE");
  assert.equal(tab.goal?.status, "active");
  assert.match(applyGoalAction(tab, "clear").message, /ship feature/);
  assert.equal(tab.goal, undefined);
  consumeGoalCompletionMarker(tab, "done\nMIXCODE_GOAL_COMPLETE");
  assert.throws(() => applyGoalAction(tab, "resume"), /No goal to resume/);
  assert.throws(() => applyGoalAction(tab, "what"), /Unknown goal action/);
  assert.equal(renderGoalSummary(undefined), "");
  assert.equal(
    renderGoalSummary({
      objective: "",
      status: "active",
      createdAt: "",
      updatedAt: "",
      lastError: "",
      lastErrorAt: "",
    }),
    "",
  );
  assert.equal(
    renderGoalSummary(
      {
        objective: "tiny",
        status: "paused",
        createdAt: "",
        updatedAt: "",
        lastError: "",
        lastErrorAt: "",
      },
      4,
    ),
    "",
  );
  assert.match(
    renderGoalSummary(
      {
        objective: "a very long goal objective",
        status: "error",
        createdAt: "",
        updatedAt: "",
        lastError: "x",
        lastErrorAt: "t",
      },
      18,
    ),
    /\.\.\./,
  );
  assert.equal(normalizeGoal(null), undefined);
  assert.equal(normalizeGoal([]), undefined);
  assert.equal(normalizeGoal({ objective: "", status: "active" }), undefined);
  assert.deepEqual(
    normalizeGoal({
      objective: "",
      status: "error",
      created_at: "c",
      updated_at: "u",
      last_error: "e",
      last_error_at: "t",
    }),
    {
      objective: "",
      status: "error",
      createdAt: "c",
      updatedAt: "u",
      lastError: "e",
      lastErrorAt: "t",
    },
  );
  assert.equal(normalizeGoal({ objective: "x", status: "bad" })?.status, "active");
  const unknownTimeTab = createTab(2, "s2", "/repo", {
    goal: {
      objective: "x",
      status: "active",
      createdAt: "",
      updatedAt: "",
      lastError: "",
      lastErrorAt: "",
    },
  });
  assert.match(applyGoalAction(unknownTimeTab, "status").message, /created: unknown/);
});

test("attachments extract refs outside fenced code and build XML prompt parts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-attachments-"));
  const home = join(dir, "home");
  const workdir = join(dir, "repo");
  try {
    await mkdir(join(workdir, ".agents", "skills", "review"), { recursive: true });
    await mkdir(join(workdir, ".agents", "skills", "not-a-skill", "SKILL.md"), { recursive: true });
    await mkdir(join(home, ".agents", "skills", "nested-ns", "audit"), { recursive: true });
    await writeFile(
      join(workdir, ".agents", "skills", "review", "SKILL.md"),
      "description: Review code\n\nBody",
      "utf8",
    );
    await writeFile(
      join(home, ".agents", "skills", "nested-ns", "audit", "SKILL.md"),
      "---\ndescription: |\n  Check details across files.\n  Report concise findings.\n---\n\n# Audit\n",
      "utf8",
    );
    const text =
      'Use $review $audit on @src/index.ts and @"dir/file name.txt" plus @"dir/file \\"quoted\\".txt"\n```sh\n$PATH @ignored\n```';
    assert.deepEqual(extractSkillRefs(text), ["review", "audit"]);
    assert.deepEqual(extractFileRefs(text), [
      "src/index.ts",
      "dir/file name.txt",
      'dir/file "quoted".txt',
    ]);
    assert.deepEqual(
      extractFileRefs(
        'see @"dir\\\\file.txt" and ignore @"", @"unterminated and email@example.com and @plain.py!',
      ),
      ["dir\\file.txt", "plain.py"],
    );
    const built = await buildPrompt(text, workdir, home);
    assert.deepEqual(
      built.skills.map((skill) => skill.name),
      ["review", "audit"],
    );
    assert.deepEqual(await scanSkillNames(workdir, home), ["audit", "review"]);
    assert.deepEqual(
      (await scanSkillEntries(workdir, home)).map((skill) => skill.path),
      [
        join(home, ".agents", "skills", "nested-ns", "audit", "SKILL.md"),
        join(workdir, ".agents", "skills", "review", "SKILL.md"),
      ],
    );
    assert.deepEqual(
      (await scanSkillEntries(workdir, home)).map((skill) => skill.description),
      ["Check details across files. Report concise findings.", "Review code"],
    );
    assert.equal(built.files[0], join(workdir, "src/index.ts"));
    assert.equal(built.parts.length, 2);
    assert.match(built.parts[1]?.text ?? "", /explicitly invoked the following skills/);
    assert.equal(resolvePromptPath("/tmp/a", workdir), "/tmp/a");
    assert.ok(resolvePromptPath("~/a", workdir).endsWith("/a"));
    assert.equal(
      new Set(resolveSkillDirs(workdir, workdir)).size,
      resolveSkillDirs(workdir, workdir).length,
    );
    // Unknown skills are silently skipped (Codex-style behavior).
    const unknownResult = await buildPrompt("$not-a-skill", workdir, home);
    assert.deepEqual(unknownResult.skills, []);
    assert.equal(unknownResult.parts.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("attachments silently skip unknown or invalid skills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-skill-error-"));
  try {
    // Unknown skill: silently skipped.
    const missingResult = await buildPrompt("$missing", dir, join(dir, "home"));
    assert.deepEqual(missingResult.skills, []);
    // Skill with empty SKILL.md (no description): silently skipped.
    await mkdir(join(dir, ".agents", "skills", "empty"), { recursive: true });
    await writeFile(join(dir, ".agents", "skills", "empty", "SKILL.md"), "", "utf8");
    const emptyResult = await buildPrompt("$empty", dir, join(dir, "home"));
    assert.deepEqual(emptyResult.skills, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("extractSkillRefs filters common environment variables", () => {
  assert.deepEqual(extractSkillRefs("use $PATH and $review"), ["review"]);
  assert.deepEqual(extractSkillRefs("$HOME $USER $SHELL $PWD"), []);
  assert.deepEqual(extractSkillRefs("$GOPATH $JAVA_HOME $NODE_PATH"), []);
  assert.deepEqual(extractSkillRefs("$TMPDIR $EDITOR $DISPLAY"), []);
  // Case-insensitive env var filtering
  assert.deepEqual(extractSkillRefs("$path $home"), []);
  // Non-env-var names pass through
  assert.deepEqual(extractSkillRefs("$my-skill $another"), ["my-skill", "another"]);
});

test("extractSkillRefs supports colon namespaces", () => {
  assert.deepEqual(extractSkillRefs("use $slack:search"), ["slack:search"]);
  assert.deepEqual(extractSkillRefs("$ns:skill-name and $plain"), ["ns:skill-name", "plain"]);
});

test("resolveSkills uses first-wins for same-name skills across directories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-skill-priority-"));
  const home = join(dir, "home");
  try {
    // Project-level skill takes priority over user-level skill with the same name.
    await mkdir(join(dir, ".agents", "skills", "demo"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "demo", "SKILL.md"),
      "description: Demo skill from project",
      "utf8",
    );
    await mkdir(join(home, ".agents", "skills", "demo"), { recursive: true });
    await writeFile(
      join(home, ".agents", "skills", "demo", "SKILL.md"),
      "description: Demo skill from home",
      "utf8",
    );
    const result = await buildPrompt("$demo", dir, home);
    // First-wins: project-level skill is resolved.
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0]?.description, "Demo skill from project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("stripSkillInjection removes injected skill content from prompt", () => {
  const original = "hello $review";
  const injected = `${original}${SKILL_INJECTION_SEPARATOR}<skill>\n<name>review</name>\ncontent\n</skill>`;
  assert.equal(stripSkillInjection(injected), original);
  // No separator: returns text unchanged.
  assert.equal(stripSkillInjection(original), original);
  // Empty string.
  assert.equal(stripSkillInjection(""), "");
});
