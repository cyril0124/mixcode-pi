import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  configureOpenTabsPath,
  createInitialState,
  createTab,
  groupTabsByColor,
  handleSubmittedInput,
  loadStateFile,
  LOCAL_COMMANDS,
  parseInput,
  readOpenTabs,
  renderTabBar,
  saveStateFile,
  serializeState,
  themeForId,
} from "./helpers/mixcode.js";
import type { MixCodeRuntime } from "./helpers/mixcode.js";

const REPO = "/repo";

/** Builds tabs in the given order with colors from `spec`. */
function stateWithTabs(spec: Array<{ id: string; color?: "red" | "green" | "blue" | "gray" }>) {
  const state = createInitialState(REPO);
  state.tabs.push(
    ...spec.map((entry, index) =>
      createTab(index + 1, entry.id, REPO, {
        title: entry.id,
        ...(entry.color ? { color: entry.color } : {}),
      }),
    ),
  );
  state.activeTabId = "home";
  return state;
}

function tabIds(state: ReturnType<typeof stateWithTabs>): string[] {
  return state.tabs.map((tab) => tab.sessionId);
}

test("groupTabsByColor puts colored tabs first in palette order, uncolored last", () => {
  const state = stateWithTabs([
    { id: "plain-a" },
    { id: "blue-a", color: "blue" },
    { id: "red-a", color: "red" },
    { id: "plain-b" },
    { id: "gray-a", color: "gray" },
    { id: "red-b", color: "red" },
  ]);

  groupTabsByColor(state);

  // Palette order is red -> green -> yellow -> blue -> magenta -> cyan -> white -> gray;
  // relative order is preserved inside each group, uncolored tabs keep theirs last.
  assert.deepEqual(tabIds(state), ["red-a", "red-b", "blue-a", "gray-a", "plain-a", "plain-b"]);
});

test("groupTabsByColor renumbers tab.index and keeps the Home selection on the same tab", () => {
  const state = stateWithTabs([
    { id: "plain-a" },
    { id: "red-a", color: "red" },
    { id: "plain-b" },
    { id: "blue-a", color: "blue" },
  ]);
  state.homeSelectedTabIndex = 2; // plain-b

  groupTabsByColor(state);

  assert.deepEqual(tabIds(state), ["red-a", "blue-a", "plain-a", "plain-b"]);
  assert.deepEqual(
    state.tabs.map((tab) => tab.index),
    [1, 2, 3, 4],
  );
  assert.equal(state.tabs[state.homeSelectedTabIndex]?.sessionId, "plain-b");
});

test("groupTabsByColor is idempotent and preserves the active tab by session id", () => {
  const state = stateWithTabs([
    { id: "plain-a" },
    { id: "red-a", color: "red" },
    { id: "green-a", color: "green" },
  ]);
  state.activeTabId = "plain-a";

  groupTabsByColor(state);
  const first = tabIds(state);
  groupTabsByColor(state);

  assert.deepEqual(tabIds(state), first);
  assert.equal(state.activeTabId, "plain-a");
});

test("groupTabsByColor leaves an all-uncolored or empty strip untouched", () => {
  const plain = stateWithTabs([{ id: "a" }, { id: "b" }]);
  groupTabsByColor(plain);
  assert.deepEqual(tabIds(plain), ["a", "b"]);

  const empty = createInitialState(REPO);
  assert.deepEqual(groupTabsByColor(empty), []);
});

test("/group-colored-tabs parses as a local command and is registered with a palette entry", () => {
  assert.deepEqual(parseInput("/group-colored-tabs"), {
    kind: "local-command",
    command: "group-colored-tabs",
    args: "",
  });
  const command = LOCAL_COMMANDS.find((item) => item.name === "group-colored-tabs");
  assert.ok(command, "group-colored-tabs command is registered");
  assert.equal(command.palette?.scope, "both");
  assert.equal(command.palette?.requires, "tabs");
  assert.equal(command.palette?.configRequires, "tabs");
});

test("/group-colored-tabs reorders tabs, publishes the order, and persists it", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-group-colored-tabs-"));
  const openTabsPath = path.join(dir, "open_tabs.json");
  configureOpenTabsPath(openTabsPath);
  try {
    const state = stateWithTabs([
      { id: "plain-a" },
      { id: "red-a", color: "red" },
      { id: "plain-b" },
      { id: "blue-a", color: "blue" },
    ]);
    state.activeTabId = "plain-a";
    let saved: Record<string, unknown> | undefined;
    const runtime = {
      appendSystemMessage: () => undefined,
      getTab: () => undefined,
    } as unknown as MixCodeRuntime;
    const tui = { requestRender: () => undefined, showOverlay: () => ({}) as never };

    await handleSubmittedInput(state, runtime, "/group-colored-tabs", tui, (next) => {
      saved = serializeState(next);
    });

    assert.deepEqual(tabIds(state), ["red-a", "blue-a", "plain-a", "plain-b"]);
    assert.deepEqual(saved?.children, ["red-a", "blue-a", "plain-a", "plain-b"]);
    assert.deepEqual(readOpenTabs(openTabsPath), ["red-a", "blue-a", "plain-a", "plain-b"]);

    // The persisted order is what a restart loads: colored groups lead, uncolored follow.
    const stateFile = path.join(dir, "mixcode_state.json");
    await saveStateFile(stateFile, state);
    const reloaded = await loadStateFile(stateFile, REPO);
    assert.deepEqual(
      reloaded.tabs.map((tab) => tab.sessionId),
      ["red-a", "blue-a", "plain-a", "plain-b"],
    );

    // The rendered strip follows the same order (Home pinned first, then agent chips).
    const strip = renderTabBar(reloaded, 120, themeForId("terminal")).join("\n");
    const titleOrder = ["red-a", "blue-a", "plain-a", "plain-b"].map((id) => {
      const at = strip.indexOf(id);
      assert.ok(at >= 0, `title ${id} missing from the tab bar`);
      return at;
    });
    assert.deepEqual(
      [...titleOrder].sort((a, b) => a - b),
      titleOrder,
      "tab bar did not render the grouped order",
    );
    assert.ok(
      strip.indexOf("MixCode Home") < titleOrder[0]!,
      "Home must stay left of every agent chip",
    );
  } finally {
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
