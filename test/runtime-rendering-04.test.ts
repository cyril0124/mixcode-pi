import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  renderInputMeta,
  renderTabBar,
} from "./helpers/mixcode.js";

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b_[^\x07]*(?:\x07|\x1b\\)/g, "");
}

test("tab bar marks running, error, and done agents", () => {
  const state = createInitialState("/repo");
  const line = stripAnsi(
    renderTabBar(
      {
        ...state,
        tabs: [
          createTab(8, "run", "/repo", { status: "running" }),
          createTab(9, "err", "/repo", { status: "error" }),
          createTab(10, "done", "/repo", { status: "done" }),
          createTab(11, "idle", "/repo"),
        ],
      },
      160,
    ).join("\n"),
  );
  assert.match(line, /\* Agent-08/);
  assert.match(line, /x Agent-09/);
  assert.match(line, /! Agent-10/);
  assert.match(line, /- Agent-11/);
});

test("tab bar treats unreadDone as a done marker", () => {
  const state = createInitialState("/repo");
  const line = stripAnsi(
    renderTabBar(
      {
        ...state,
        activeTabId: "home",
        tabs: [
          createTab(12, "idle-done", "/repo", { unreadDone: true }),
          createTab(13, "err-done", "/repo", { status: "error", unreadDone: true }),
        ],
      },
      120,
    ).join("\n"),
  );
  assert.match(line, /! Agent-12 /);
  assert.match(line, /x Agent-13 /);
});

test("input meta collapses HOME workdirs and omits queued-count noise", () => {
  const oldHome = process.env.HOME;
  process.env.HOME = "/repo";
  try {
    assert.match(
      stripAnsi(renderInputMeta(createTab(1, "s1", "/repo/project"), 100).join("\n")),
      /~\/project/,
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
  }
  assert.doesNotMatch(
    stripAnsi(
      renderInputMeta(createTab(2, "s2", "/repo", { pendingMessages: ["queued"] }), 100).join("\n"),
    ),
    /queued: 1/,
  );
});

test("extension status text keeps SGR colors and never leaks bare CSI", () => {
  const colored = "\x1b[38;2;250;249;245m\u26a1  FULL\x1b[39m";
  const meta = renderInputMeta(
    createTab(1, "s1", "/repo", {
      extensionUi: {
        statuses: [{ key: "ponytail", text: colored }],
        widgets: [],
        toolsExpanded: false,
        workingVisible: false,
      },
    }),
    120,
  ).join("\n");
  assert.match(meta, /\x1b\[38;2;250;249;245m/);
  assert.doesNotMatch(meta, /(?<!\x1b)\[38;2;250;249;245m/);
});
