import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { availableThinkingLevelsForModel } from "../src/core/thinking-levels.js";
import {
  activateTab,
  closeAgentTab,
  createInitialState,
  createTab,
  acceptPickerSelection,
  completeWorkdirPickerSelection,
  createPicker,
  filteredPickerItems,
  movePickerSelection,
  nextTabId,
  renameAgentTab,
  snapshotWorkspace,
  upsertWorkspace,
  updatePickerQuery,
} from "./helpers/mixcode.js";

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

test("workspace snapshots preserve tab order", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "b", "/repo"), createTab(2, "a", "/repo"));
  const now = new Date("2026-05-09T00:00:00.000Z");
  const snapshot = snapshotWorkspace(state, "main", now);
  assert.deepEqual(snapshot.children, ["b", "a"]);
  assert.equal(snapshot.updatedAt, now.toISOString());
  const replaced = upsertWorkspace([snapshot], { ...snapshot, children: ["a"] });
  assert.deepEqual(replaced.find((workspace) => workspace.name === "main")?.children, ["a"]);
});

function pushTab(state: ReturnType<typeof createInitialState>, sessionId: string) {
  const tab = createTab(state.tabs.length + 1, sessionId, state.workdir);
  state.tabs.push(tab);
  activateTab(state, sessionId);
  return tab;
}

test("tab operations add, close, rename, and rotate through config", () => {
  const state = createInitialState("/repo");
  const one = pushTab(state, "s1");
  const two = pushTab(state, "s2");
  assert.equal(one.index, 1);
  assert.equal(two.index, 2);
  renameAgentTab(state, "s2", " Worker ");
  assert.equal(state.tabs[1]?.title, "Worker");
  assert.throws(() => renameAgentTab(state, "s2", " "), /cannot be empty/);
  assert.throws(() => renameAgentTab(state, "s1", "Worker"), /already in use/);
  assert.equal(state.tabs[0]?.title, "Agent-01");
  renameAgentTab(state, "s2", "Worker");
  assert.equal(state.tabs[1]?.title, "Worker");
  assert.equal(nextTabId(state, 1), "home");
  state.activeTabId = "home";
  assert.equal(nextTabId(state, -1), "s2");
  const removed = closeAgentTab(state, "s2");
  assert.equal(removed.sessionId, "s2");
  assert.equal(state.activeTabId, "home");
  state.activeTabId = "s1";
  closeAgentTab(state, "s1");
  assert.equal(state.activeTabId, "home");
  pushTab(state, "s3");
  pushTab(state, "s4");
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

test("picker query starts selection at the first filtered result", () => {
  const state = createInitialState("/repo");
  state.availableModels.push(
    {
      provider: "openai",
      modelId: "gpt-alpha",
      displayName: "openai/gpt-alpha",
      contextWindow: 100_000,
    },
    {
      provider: "openai",
      modelId: "gpt-beta",
      displayName: "openai/gpt-beta",
      contextWindow: 100_000,
    },
    {
      provider: "openai",
      modelId: "gpt-gamma",
      displayName: "openai/gpt-gamma",
      contextWindow: 100_000,
    },
    {
      provider: "anthropic",
      modelId: "claude",
      displayName: "anthropic/claude",
      contextWindow: 100_000,
    },
  );
  const tab = createTab(1, "s1", "/repo", { model: state.availableModels.at(-1)! });
  const picker = createPicker("models", state, tab);
  assert.equal(picker.selectedIndex, 4);

  updatePickerQuery(picker, "gpt");

  assert.equal(picker.selectedIndex, 0);
  assert.equal(acceptPickerSelection(picker)?.id, filteredPickerItems(picker)[0]?.id);
});

test("workdir picker completes direct child directories only", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-picker-"));
  try {
    await fsPromises.mkdir(path.join(dir, "alpha"), { recursive: true });
    await fsPromises.mkdir(path.join(dir, "beta"), { recursive: true });
    await fsPromises.writeFile(path.join(dir, "app.ts"), "");

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
    assert.equal(acceptPickerSelection(picker)?.id, path.join(dir, "alpha"));

    // Path-style query (contains /) treated as custom path input
    updatePickerQuery(picker, "alpha/");
    assert.equal(acceptPickerSelection(picker)?.id, path.join(dir, "alpha"));

    updatePickerQuery(picker, "missing/path");
    assert.equal(filteredPickerItems(picker)[0]?.description, "custom path");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("workdir picker covers home absolute and empty query branches", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-branches-"));
  const oldHome = process.env.HOME;
  try {
    const home = path.join(dir, "home");
    await fsPromises.mkdir(path.join(home, "proj"), { recursive: true });
    await fsPromises.mkdir(path.join(dir, "abs"), { recursive: true });
    process.env.HOME = home;

    const state = createInitialState(path.join(dir, "base"));
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
    assert.equal(acceptPickerSelection(picker)?.id, path.join(home, "p"));

    // Absolute path with partial match treated as custom path
    updatePickerQuery(picker, `${dir}/a`);
    assert.equal(acceptPickerSelection(picker)?.id, path.join(dir, "a"));

    assert.equal(completeWorkdirPickerSelection(createPicker("models", state)), false);
    // no-match filter on unreadable dir still shows error, no completeValue
    updatePickerQuery(picker, "no-match");
    picker.selectedIndex = 1;
    assert.equal(completeWorkdirPickerSelection(picker), false);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("workdir picker reuses directory listing across query keystrokes", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-workdir-cache-"));
  try {
    // Enough entries that repeated readdir+sort is clearly more expensive than filter-only.
    await Promise.all(
      Array.from({ length: 2500 }, (_, i) => fsPromises.mkdir(path.join(dir, `d${String(i).padStart(4, "0")}`))),
    );
    await fsPromises.mkdir(path.join(dir, "target-hit"));

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
    assert.equal(picker.browsingDir, path.join(dir, "target-hit"));
    updatePickerQuery(picker, "");
    assert.deepEqual(filteredPickerItems(picker), []);
    assert.equal(picker.workdirListingCache?.browsingDir, path.join(dir, "target-hit"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
