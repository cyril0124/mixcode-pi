import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import type { MixCodeRuntime } from "../src/index.js";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  handleSubmittedInput,
  loadWorkspaces,
  renderWorkspaceOverlay,
  saveWorkspaces,
  snapshotWorkspace,
  type MixCodeState,
  UUIDV7_SESSION_ID_PATTERN,
} from "../src/index.js";
import { restoreWorkspace } from "../src/ui/workspace-restore.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

function createOverlayTui() {
  const overlays: string[] = [];
  const renders: string[] = [];
  let hasOverlay = false;
  return {
    overlays,
    renders,
    requestRender: () => renders.push("render"),
    showOverlay: (component: { render?: (width: number) => string[] } | string) => {
      hasOverlay = true;
      overlays.push(
        typeof component === "string"
          ? component
          : (component.render?.(100).join("\n") ?? String(component)),
      );
      return {
        hide: () => {
          hasOverlay = false;
        },
      };
    },
    hasOverlay: () => hasOverlay,
    hideOverlay: () => {
      hasOverlay = false;
    },
  };
}

function createRuntime(
  sessionFiles: Record<string, string | undefined> = {},
  promptHistory: Record<string, string[]> = {},
) {
  const created: string[] = [];
  const closed: string[] = [];
  const switched: Array<{ sessionId: string; sessionPath: string }> = [];
  const runtime = {
    appendSystemMessage: () => undefined,
    getTab: (sessionId: string) => ({
      session: {
        getSessionFile: () => sessionFiles[sessionId],
      },
    }),
    createTab: async (tab: { sessionId: string }) => {
      created.push(tab.sessionId);
      return {};
    },
    closeTab: async (sessionId: string) => {
      closed.push(sessionId);
    },
    extensionSwitchSession: async (sessionId: string, sessionPath: string) => {
      switched.push({ sessionId, sessionPath });
      sessionFiles[sessionId] = sessionPath;
      return { cancelled: false };
    },
    getPromptHistory: (sessionId: string) => promptHistory[sessionFiles[sessionId] ?? sessionId] ?? [],
  } as unknown as MixCodeRuntime;
  return { runtime, created, closed, switched };
}

test("workspace snapshot stores tab metadata and active tab", () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { title: "plan" });
  const second = createTab(2, "s2", "/repo", { title: "ui", thinkingLevel: "high" });
  state.tabs.push(first, second);
  state.activeTabId = "s2";
  const runtime = createRuntime({ s1: "/sessions/s1.jsonl", s2: "/sessions/s2.jsonl" }).runtime;

  const snapshot = snapshotWorkspace(state, "main", new Date("2026-05-23T00:00:00.000Z"), runtime);

  assert.equal(snapshot.activeSessionId, "s2");
  assert.deepEqual(snapshot.children, ["s1", "s2"]);
  assert.deepEqual(
    snapshot.tabs.map((tab) => ({ id: tab.sessionId, path: tab.sessionPath, title: tab.title })),
    [
      { id: "s1", path: "/sessions/s1.jsonl", title: "plan" },
      { id: "s2", path: "/sessions/s2.jsonl", title: "ui" },
    ],
  );
});

test("workspace snapshot on Home records the selected agent, not tabs[0]", () => {
  const state = createInitialState("/repo");
  state.tabs.push(
    createTab(1, "s1", "/repo", { title: "Agent-01" }),
    createTab(2, "s2", "/repo", { title: "Agent-02" }),
  );
  state.activeTabId = "config";
  state.homeSelectedTabIndex = 1;

  const snapshot = snapshotWorkspace(state, "from-home");

  assert.equal(snapshot.activeSessionId, "s2");
});

test("workspace store round-trips new schema and reads legacy children", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-schema-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    await saveWorkspaces(workspaceFile, [
      {
        name: " main ",
        children: ["s1", ""],
        startupWorkdir: "/repo///",
        updatedAt: "now",
        activeSessionId: "s1",
        tabs: [
          {
            sessionId: "s1",
            sessionPath: "/sessions/s1.jsonl",
            title: "plan",
            workdir: "/repo///",
            model: { provider: "p", modelId: "m", displayName: "p/m", contextWindow: 1 },
            thinkingLevel: "high",
          },
        ],
      },
    ]);
    assert.deepEqual(await loadWorkspaces(workspaceFile), [
      {
        name: "main",
        children: ["s1"],
        startupWorkdir: "/repo",
        updatedAt: "now",
        activeSessionId: "s1",
        tabs: [
          {
            sessionId: "s1",
            sessionPath: "/sessions/s1.jsonl",
            title: "plan",
            workdir: "/repo",
            model: { provider: "p", modelId: "m", displayName: "p/m", contextWindow: 1 },
            thinkingLevel: "high",
          },
        ],
      },
    ]);

    await writeFile(workspaceFile, JSON.stringify([{ name: "legacy", children: ["a", ""] }]), "utf8");
    assert.deepEqual(await loadWorkspaces(workspaceFile), [
      { name: "legacy", children: ["a"], startupWorkdir: "", updatedAt: "", tabs: [] },
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace commands open save input and selector overlays without arguments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-ui-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo", { title: "plan" }));
    state.activeTabId = "config";
    await saveWorkspaces(workspaceFile, [snapshotWorkspace(state, "main")]);
    const { runtime } = createRuntime();
    const tui = createOverlayTui();

    await handleSubmittedInput(state, runtime, "/save-workspace", tui, undefined, undefined, workspaceFile);
    assert.equal(state.workspaceOverlay.open, true);
    assert.equal(state.workspaceOverlay.mode, "save");
    const saveOverlay = stripAnsi(tui.overlays.at(-1) ?? "");
    assert.match(saveOverlay, /Save Workspace/);
    assert.match(saveOverlay, /┌─+┐/);
    assert.match(saveOverlay, /Current layout: 1 tab/);

    await handleSubmittedInput(state, runtime, "/restore-workspace", tui, undefined, undefined, workspaceFile);
    assert.equal(state.workspaceOverlay.mode, "restore");
    assert.match(tui.overlays.at(-1) ?? "", /Project Workspaces/);
    assert.match(tui.overlays.at(-1) ?? "", /Details/);

    await handleSubmittedInput(state, runtime, "/delete-workspace", tui, undefined, undefined, workspaceFile);
    assert.equal(state.workspaceOverlay.mode, "delete");
    assert.match(tui.overlays.at(-1) ?? "", /enter: delete/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("save workspace input confirms overwrite before saving", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-save-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo", { title: "new plan" }));
    state.activeTabId = "s1";
    await saveWorkspaces(workspaceFile, [
      { name: "main", children: ["old"], startupWorkdir: "/repo", updatedAt: "old", tabs: [] },
    ]);
    const { runtime } = createRuntime({ s1: "/sessions/s1.jsonl" });
    const tui = createOverlayTui();

    await handleSubmittedInput(state, runtime, "/save-workspace", tui, undefined, undefined, workspaceFile);
    assert.equal(state.workspaceOverlay.mode, "save");
    for (const char of "main") handleMixCodeKeyInput(state, char, tui, undefined, runtime, undefined, undefined, undefined, undefined, { workspaceFile });
    assert.equal(state.workspaceOverlay.input, "main");
    handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, undefined, undefined, undefined, { workspaceFile });
    assert.equal(state.workspaceOverlay.mode, "save-confirm-overwrite");
    assert.match(tui.overlays.at(-1) ?? "", /Confirm Update Workspace/);

    handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, undefined, undefined, undefined, { workspaceFile });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const saved = await loadWorkspaces(workspaceFile);
    assert.deepEqual(saved[0]?.children, ["s1"]);
    assert.equal(state.tabs[0]?.toast?.message, "Workspace updated: main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore workspace reopens saved sessions, closes extra tabs, and reports missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-restore-"));
  const workspaceFile = join(dir, "workspaces.json");
  const existingSessionPath = join(dir, "s1.jsonl");
  const missingSessionPath = join(dir, "missing.jsonl");
  try {
    await writeFile(existingSessionPath, "{}\n", "utf8");
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "extra", "/repo", { title: "extra" }));
    state.activeTabId = "extra";
    await saveWorkspaces(workspaceFile, [
      {
        name: "main",
        children: ["old-s1", "old-missing"],
        startupWorkdir: "/repo",
        updatedAt: "now",
        activeSessionId: "old-s1",
        tabs: [
          { sessionId: "old-s1", sessionPath: existingSessionPath, title: "plan", workdir: "/repo" },
          { sessionId: "old-missing", sessionPath: missingSessionPath, title: "old qa", workdir: "/repo" },
        ],
      },
    ]);
    const { runtime, created, closed, switched } = createRuntime(
      { extra: join(dir, "extra.jsonl") },
      { [existingSessionPath]: ["old prompt", "new prompt"] },
    );
    const tui = createOverlayTui();

    await handleSubmittedInput(state, runtime, "/restore-workspace main", tui, undefined, undefined, workspaceFile);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.equal(state.tabs.length, 1);
    assert.equal(state.tabs[0]?.title, "plan");
    assert.equal(state.tabs[0]?.workdir, "/repo");
    assert.deepEqual(created, [state.tabs[0]!.sessionId]);
    assert.match(created[0]!, UUIDV7_SESSION_ID_PATTERN);
    assert.deepEqual(closed, ["extra"]);
    assert.equal(switched.length, 1);
    assert.equal(switched[0]?.sessionPath, existingSessionPath);
    assert.deepEqual(state.tabs[0]?.promptHistory, ["new prompt", "old prompt"]);
    assert.deepEqual(state.workspaceOverlay.skippedMissing, ["old qa"]);
    const toastMsg = state.tabs[0]?.toast?.message ?? "";
    assert.match(toastMsg, /Workspace restored: main · restored 1, skipped 1/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("restore workspace order-only path hydrates prompt history", async () => {
  const state = createInitialState("/repo");
  const first = createTab(1, "s1", "/repo", { title: "one" });
  const second = createTab(2, "s2", "/repo", { title: "two" });
  state.tabs.push(first, second);
  state.activeTabId = "s1";
  const runtime = {
    getTab: () => undefined,
    getPromptHistory: (sessionId: string) => (sessionId === "s2" ? ["old", "new"] : []),
  } as unknown as MixCodeRuntime;
  const tui = createOverlayTui();

  await restoreWorkspace(
    state,
    runtime,
    tui,
    {
      name: "main",
      children: ["s2", "s1"],
      startupWorkdir: "/repo",
      updatedAt: "now",
      activeSessionId: "s2",
      tabs: [],
    },
  );

  assert.deepEqual(
    state.tabs.map((tab) => tab.sessionId),
    ["s2", "s1"],
  );
  assert.deepEqual(state.tabs[0]?.promptHistory, ["new", "old"]);
});

test("restore workspace keeps active tab when earlier workspace items are skipped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-active-"));
  const workspaceFile = join(dir, "workspaces.json");
  const secondSessionPath = join(dir, "second.jsonl");
  const thirdSessionPath = join(dir, "third.jsonl");
  try {
    await writeFile(secondSessionPath, "{}\n", "utf8");
    await writeFile(thirdSessionPath, "{}\n", "utf8");
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "extra", "/repo", { title: "extra" }));
    state.activeTabId = "extra";
    await saveWorkspaces(workspaceFile, [
      {
        name: "main",
        children: ["missing-no-path", "second", "third"],
        startupWorkdir: "/repo",
        updatedAt: "now",
        activeSessionId: "third",
        tabs: [
          { sessionId: "missing-no-path", title: "missing", workdir: "/repo" },
          { sessionId: "second", sessionPath: secondSessionPath, title: "second", workdir: "/repo" },
          { sessionId: "third", sessionPath: thirdSessionPath, title: "third", workdir: "/repo" },
        ],
      },
    ]);
    const { runtime } = createRuntime({ extra: join(dir, "extra.jsonl") });
    const tui = createOverlayTui();

    await handleSubmittedInput(state, runtime, "/restore-workspace main", tui, undefined, undefined, workspaceFile);

    assert.equal(state.tabs.find((tab) => tab.sessionId === state.activeTabId)?.title, "third");
    assert.deepEqual(state.workspaceOverlay.skippedMissing, ["missing (no session path saved)"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("delete workspace selector requires confirmation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-workspace-delete-"));
  const workspaceFile = join(dir, "workspaces.json");
  try {
    const state = createInitialState("/repo");
    state.tabs.push(createTab(1, "s1", "/repo"));
    await saveWorkspaces(workspaceFile, [snapshotWorkspace(state, "main")]);
    const { runtime } = createRuntime();
    const tui = createOverlayTui();

    await handleSubmittedInput(state, runtime, "/delete-workspace", tui, undefined, undefined, workspaceFile);
    handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, undefined, undefined, undefined, { workspaceFile });
    assert.equal(state.workspaceOverlay.mode, "delete-confirm");
    assert.match(tui.overlays.at(-1) ?? "", /Delete Workspace "main"/);

    handleMixCodeKeyInput(state, "\r", tui, undefined, runtime, undefined, undefined, undefined, undefined, { workspaceFile });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await assert.rejects(loadWorkspaces(workspaceFile), /ENOENT/);
    assert.equal(state.tabs[0]?.toast?.message, "Workspace deleted: main");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workspace overlay renders empty project state", () => {
  const state = createInitialState("/repo");
  state.workspaceOverlay = {
    ...state.workspaceOverlay,
    open: true,
    mode: "restore",
    workspaces: [],
    workdir: "/repo",
  };

  assert.match(renderWorkspaceOverlay(state, 80).join("\n"), /No saved workspaces for this directory/);
});

test("save workspace overlay renders a bordered input field", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo", { title: "plan" }));
  state.workspaceOverlay = {
    ...state.workspaceOverlay,
    open: true,
    mode: "save",
    input: "main",
    workdir: "/repo",
  };

  const text = stripAnsi(renderWorkspaceOverlay(state, 80).join("\n"));
  assert.match(text, /Name/);
  assert.match(text, /┌─+┐/);
  assert.match(text, /│main/);
  assert.doesNotMatch(text, /main_+/);
});

test("workspace overlay shows tab details before constrained-height clipping", () => {
  const state = createInitialState("/repo");
  const tabs = Array.from({ length: 7 }, (_, index) =>
    createTab(index + 1, `s${index + 1}`, "/repo", { title: `Agent-${index + 1}` }),
  );
  state.tabs.push(...tabs);
  state.workspaceOverlay = {
    ...state.workspaceOverlay,
    open: true,
    mode: "restore",
    workdir: "/repo",
    workspaces: [snapshotWorkspace(state, "main", new Date("2026-05-23T03:12:00.000Z"))],
  };

  const lines = stripAnsi(renderWorkspaceOverlay(state, 100).join("\n")).split("\n");
  assert.match(lines.slice(0, 12).join("\n"), /1\. Agent-1/);
  assert.match(lines.join("\n"), /7\. Agent-7/);
});
