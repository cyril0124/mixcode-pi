import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  resolveSkillDirs,
  scanSkillEntries,
  createPicker,
  workdirBreadcrumb,
  filteredPickerItems,
  updatePickerQuery,
  movePickerSelection,
  acceptPickerSelection,
  completeWorkdirPickerSelection,
} from "./helpers/mixcode.js";

test("model picker filters by query and refuses empty selection", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-picker-model-"));
  try {
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
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("workdir picker completes directories and keeps custom path input", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-picker-workdir-"));
  try {
    await fsPromises.mkdir(path.join(dir, "alpha"), { recursive: true });
    await fsPromises.mkdir(path.join(dir, "beta"), { recursive: true });
    const state = createInitialState(dir);
    const tab = createTab(1, "s1", dir);
    state.tabs.push(tab);
    state.activeTabId = "s1";

    const workdirPicker = createPicker("workdir", state, tab);
    assert.equal(workdirPicker.query, "");
    assert.equal(workdirPicker.browsingDir, dir);
    assert.ok(
      filteredPickerItems(workdirPicker).some((item) => item.id === path.join(dir, "alpha")),
    );

    updatePickerQuery(workdirPicker, "al");
    assert.equal(filteredPickerItems(workdirPicker)[0]?.completeValue, path.join(dir, "alpha"));
    assert.equal(completeWorkdirPickerSelection(workdirPicker), true);
    assert.equal(workdirPicker.query, "");
    assert.equal(workdirPicker.browsingDir, path.join(dir, "alpha"));

    updatePickerQuery(workdirPicker, `${dir}/`);
    assert.ok(filteredPickerItems(workdirPicker).some((item) => item.id === dir));
    updatePickerQuery(workdirPicker, `${path.join(dir, "missing")}/a`);
    assert.equal(filteredPickerItems(workdirPicker)[0]?.description, "custom path");
    assert.equal(filteredPickerItems(workdirPicker)[0]?.id, `${path.join(dir, "missing")}/a`);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("workdir breadcrumb keeps the leading slash on the first absolute segment", () => {
  const picker = (browsingDir: string) => ({
    kind: "workdir" as const,
    title: "Change Workdir",
    query: "",
    selectedIndex: 0,
    items: [],
    browsingDir,
  });
  assert.deepEqual(workdirBreadcrumb(picker("/")), ["/"]);
  assert.deepEqual(workdirBreadcrumb(picker("/tmp")), ["/tmp"]);
  assert.deepEqual(workdirBreadcrumb(picker("/tmp/foo")), ["/tmp", "foo"]);
  assert.equal(workdirBreadcrumb(picker("/tmp/foo")).join(" / "), "/tmp / foo");
  const home = process.env.HOME || os.homedir();
  assert.deepEqual(workdirBreadcrumb(picker(home)), ["~"]);
});

test("skill scanning finds flat and nested skills with parsed descriptions", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-attachments-"));
  const home = path.join(dir, "home");
  const workdir = path.join(dir, "repo");
  try {
    await fsPromises.mkdir(path.join(workdir, ".agents", "skills", "review"), { recursive: true });
    await fsPromises.mkdir(path.join(workdir, ".agents", "skills", "not-a-skill", "SKILL.md"), {
      recursive: true,
    });
    await fsPromises.mkdir(path.join(home, ".agents", "skills", "nested-ns", "audit"), {
      recursive: true,
    });
    await fsPromises.writeFile(
      path.join(workdir, ".agents", "skills", "review", "SKILL.md"),
      "---\ndescription: Review code\n---\n\nBody",
      "utf8",
    );
    await fsPromises.writeFile(
      path.join(home, ".agents", "skills", "nested-ns", "audit", "SKILL.md"),
      "---\ndescription: |\n  Check details across files.\n  Report concise findings.\n---\n\n# Audit\n",
      "utf8",
    );
    assert.deepEqual(
      (await scanSkillEntries(workdir, home)).map((skill) => skill.path),
      [
        path.join(home, ".agents", "skills", "nested-ns", "audit", "SKILL.md"),
        path.join(workdir, ".agents", "skills", "review", "SKILL.md"),
      ],
    );
    assert.deepEqual(
      (await scanSkillEntries(workdir, home)).map((skill) => skill.description),
      ["Check details across files.\nReport concise findings.\n", "Review code"],
    );
    assert.equal(
      new Set(resolveSkillDirs(workdir, workdir)).size,
      resolveSkillDirs(workdir, workdir).length,
    );
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("scanSkillEntries uses first-wins for same-name skills across directories", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-skill-priority-"));
  const home = path.join(dir, "home");
  try {
    await fsPromises.mkdir(path.join(dir, ".agents", "skills", "demo"), { recursive: true });
    await fsPromises.writeFile(
      path.join(dir, ".agents", "skills", "demo", "SKILL.md"),
      "---\ndescription: Demo skill from project\n---\n\nBody",
      "utf8",
    );
    await fsPromises.mkdir(path.join(home, ".agents", "skills", "demo"), { recursive: true });
    await fsPromises.writeFile(
      path.join(home, ".agents", "skills", "demo", "SKILL.md"),
      "---\ndescription: Demo skill from home\n---\n\nBody",
      "utf8",
    );
    const entries = await scanSkillEntries(dir, home);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.description, "Demo skill from project");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
