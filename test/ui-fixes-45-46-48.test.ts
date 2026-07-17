import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  createInitialState,
  createTab,
  renderCommandPalette,
  renderTabJumpOverlay,
  stripAnsi,
} from "../src/index.js";
import { createSessionSelectorState } from "../src/core/session-selector.js";
import { handleSessionSelectorKey } from "../src/ui/session-selector.js";
import type { MixCodeKeyRuntime } from "../src/ui/app-types.js";

test("command palette windows long lists so the selected item stays visible", () => {
  const state = createInitialState("/repo");
  // Agent scope has many more palette entries than Home/config.
  state.tabs.push(createTab(1, "s1", "/repo"));
  state.activeTabId = "s1";
  state.commandPaletteOpen = true;
  state.commandPalette = { query: "", selectedIndex: 35 };
  const extensionCommands = Array.from({ length: 40 }, (_, i) => ({
    name: `cmd-${String(i).padStart(2, "0")}`,
    description: `desc ${i}`,
  }));

  const plain = stripAnsi(renderCommandPalette(state, 100, extensionCommands).join("\n"));
  const rows = plain.split("\n").filter((line) => /\/cmd-\d{2}|cmd-\d{2}/.test(line)).length;
  assert.ok(rows < 40, `expected windowed palette rows, got ${rows}`);
  assert.match(plain, /more above|more below/);
  assert.match(plain, /›/);
});

test("tab jump windows long lists around tabJumpIndex", () => {
  const state = createInitialState("/repo");
  for (let i = 1; i <= 30; i++) {
    state.tabs.push(
      createTab(i, `s${i}`, "/repo", { title: `Agent-${String(i).padStart(2, "0")}` }),
    );
  }
  state.tabJumpOpen = true;
  state.tabJumpQuery = "";
  state.tabJumpIndex = 25;

  const plain = stripAnsi(renderTabJumpOverlay(state, 80).join("\n"));
  const agentRows = plain.split("\n").filter((line) => /Agent-\d{2}/.test(line)).length;
  assert.ok(agentRows < 30, `expected windowed tab jump rows, got ${agentRows}`);
  assert.match(plain, /more above|more below/);
  assert.match(plain, /Agent-2[5-9]|Agent-30/);
  assert.doesNotMatch(plain, /Agent-01/);
});

test("resume rename updates title of any open tab, not only active", async () => {
  const root = await mkdtemp(join(tmpdir(), "mixcode-rename-open-"));
  try {
    const otherSession = SessionManager.create(root, root);
    const otherPath = otherSession.getSessionFile()!;
    otherSession.appendSessionInfo("Old-Other-Name");

    const state = createInitialState("/repo");
    const active = createTab(1, "s-active", "/repo", { title: "Active-Tab" });
    const other = createTab(2, "s-other", "/repo", { title: "Old-Other-Name" });
    state.tabs.push(active, other);
    state.activeTabId = "s-active";

    const selector = createSessionSelectorState();
    selector.open = true;
    selector.renameMode = true;
    selector.renameTargetPath = otherPath;
    selector.renameInput = "New-Other-Name";
    selector.currentSessionPath = null;
    selector.currentSessions = [
      {
        path: otherPath,
        cwd: root,
        mtime: Date.now(),
        firstMessage: "",
        messageCount: 0,
        name: "Old-Other-Name",
      } as never,
    ];
    state.sessionSelector = selector;

    const runtime = {
      getTab: (sessionId: string) => {
        if (sessionId !== "s-other") return undefined;
        return {
          session: {
            getSessionFile: () => otherPath,
          },
        };
      },
    } as unknown as MixCodeKeyRuntime;

    const tui = {
      requestRender: () => undefined,
      showOverlay: () => ({ hide: () => undefined }) as never,
      hasOverlay: () => true,
      hideOverlay: () => undefined,
    };

    assert.equal(handleSessionSelectorKey(state, "\r", tui, runtime), true);
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));

    assert.equal(other.title, "New-Other-Name");
    assert.equal(active.title, "Active-Tab");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
