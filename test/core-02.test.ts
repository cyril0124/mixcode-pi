import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import {
  commandSuggestions,
  createInitialState,
  createTab,
  deleteWorkspace,
  deserializeState,
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
  resolveSkillDirs,
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
    assert.equal(workdirPicker.query, "");
    assert.equal(workdirPicker.browsingDir, dir);
    // Empty query lists directory contents
    assert.ok(filteredPickerItems(workdirPicker).some((item) => item.id === join(dir, "alpha")));
    // Filter by 'al' to match only alpha
    updatePickerQuery(workdirPicker, "al");
    assert.equal(filteredPickerItems(workdirPicker)[0]?.completeValue, join(dir, "alpha"));
    assert.equal(completeWorkdirPickerSelection(workdirPicker), true);
    assert.equal(workdirPicker.query, "");
    assert.equal(workdirPicker.browsingDir, join(dir, "alpha"));
    // Path-style queries (containing / or ~) are treated as custom path input
    updatePickerQuery(workdirPicker, `${dir}/`);
    assert.ok(filteredPickerItems(workdirPicker).some((item) => item.id === dir));
    updatePickerQuery(workdirPicker, "~/");
    assert.ok(filteredPickerItems(workdirPicker)[0]?.id);
    updatePickerQuery(workdirPicker, "~");
    assert.ok(filteredPickerItems(workdirPicker)[0]?.id);
    updatePickerQuery(workdirPicker, `${join(dir, "missing")}/a`);
    assert.equal(filteredPickerItems(workdirPicker)[0]?.description, "custom path");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("skill scanning finds flat and nested skills with parsed descriptions", async () => {
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
    assert.equal(
      new Set(resolveSkillDirs(workdir, workdir)).size,
      resolveSkillDirs(workdir, workdir).length,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("scanSkillEntries uses first-wins for same-name skills across directories", async () => {
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
    const entries = await scanSkillEntries(dir, home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.description, "Demo skill from project");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
