import assert from "node:assert/strict";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/index.js";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../src/agent/runtime-extension-theme.js";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";

// Kitty CSI-u: codepoint; modifier u  (shift=1, ctrl=4, base=1 → 6)
const CTRL_SHIFT_T = "\x1b[116;6u";
const CTRL_SHIFT_R = "\x1b[114;6u";

test("MixCode defaults bind session open chords without clashing palette/jump", () => {
  const kb = MIXCODE_EXTENSION_KEYBINDINGS_MANAGER;
  assert.deepEqual(kb.getKeys("app.session.tree" as never), ["ctrl+shift+t"]);
  assert.deepEqual(kb.getKeys("app.session.resume" as never), ["ctrl+shift+r"]);
  assert.deepEqual(kb.getKeys("app.session.fork" as never), ["ctrl+shift+f"]);
  assert.deepEqual(kb.getKeys("app.session.new" as never), ["ctrl+shift+n"]);
  assert.deepEqual(kb.getKeys("app.model.cycleForward" as never), ["ctrl+p"]);
  assert.deepEqual(kb.getKeys("app.model.cycleBackward" as never), ["ctrl+t"]);
});

test("ctrl+shift+t opens the session tree selector", () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  const opened: string[] = [];
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
    hasOverlay: () => false,
    treeSelectorDisplay: {
      open: (sessionId: string) => {
        opened.push(sessionId);
        state.treeSelector.open = true;
      },
      refresh: () => undefined,
      close: () => {
        state.treeSelector.open = false;
      },
    },
  };
  const runtime = {
    getTab: () => ({
      session: {
        getTree: () => [
          {
            entry: {
              type: "message",
              id: "leaf",
              parentId: null,
              timestamp: "2026-05-14T00:00:00.000Z",
              message: { role: "user", content: [{ type: "text", text: "hi" }] },
            },
            children: [],
          },
        ],
        getLeafId: () => "leaf",
        getBranch: () => [],
      },
    }),
  };

  assert.ok(MIXCODE_EXTENSION_KEYBINDINGS_MANAGER.matches(CTRL_SHIFT_T, "app.session.tree" as never));
  const out = handleMixCodeKeyInput(
    state,
    CTRL_SHIFT_T,
    tui as never,
    undefined,
    runtime as never,
    undefined,
    () => false,
  );
  assert.deepEqual(out, { consume: true });
  assert.equal(state.treeSelector.open, true);
  assert.deepEqual(opened, ["s1"]);
});

test("ctrl+shift+r mounts the resume session selector", async () => {
  const state = createInitialState("/repo");
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  let mounted = false;
  const tui = {
    requestRender: () => undefined,
    showOverlay: () => ({ hide: () => undefined }),
    hasOverlay: () => false,
  };
  const runtime = {
    getTab: () => ({ session: { getSessionFile: () => "/sessions/current.jsonl" } }),
    listSessions: async () => [],
    listAllSessions: async () => [],
  };

  assert.ok(
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER.matches(CTRL_SHIFT_R, "app.session.resume" as never),
  );
  const out = handleMixCodeKeyInput(
    state,
    CTRL_SHIFT_R,
    tui as never,
    undefined,
    runtime as never,
    undefined,
    () => false,
    {
      getText: () => "",
      setText: () => undefined,
      setInputComponent: () => {
        mounted = true;
      },
      clearInputComponent: () => {
        mounted = false;
      },
    },
  );
  assert.deepEqual(out, { consume: true });
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(mounted, true);
  assert.equal(state.sessionSelector.open, true);
});
