import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { handleMixCodeKeyInput } from "../src/ui/app-input.js";
import {
  closeWorkspaceOverlay,
  openWorkspaceSelector,
} from "../src/ui/components/workspace-overlay.js";
import { createInitialState, createTab } from "./helpers/mixcode.js";

function createOverlayTui() {
  let overlayOpen = false;
  return {
    requestRender: () => undefined,
    showOverlay: () => {
      overlayOpen = true;
      return { hide: () => (overlayOpen = false) } as never;
    },
    hideOverlay: () => {
      overlayOpen = false;
    },
    hasOverlay: () => overlayOpen,
  };
}

function createEditorActions() {
  let text = "";
  return {
    actions: {
      hasInputComponent: () => false,
      getText: () => text,
      setText: (next: string) => {
        text = next;
      },
    },
    text: () => text,
  };
}

async function openFocusedWorkspaceOverlay() {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-modal-routing-"));
  const workspaceFile = path.join(dir, "workspaces.json");
  await fsPromises.writeFile(workspaceFile, "[]", "utf8");
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { title: "main" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  tab.pendingFollowUps.push("queued steer message");
  const tui = createOverlayTui();
  await openWorkspaceSelector(state, tui, workspaceFile, "restore");
  return { state, tab, tui, dir };
}

/** Input-capable component overlays are modal: editor chords must fall through to TUI focus dispatch. */
test("ctrl+u and ctrl+t fall through to a focused component overlay without touching the hidden editor", async () => {
  const { state, tab, tui, dir } = await openFocusedWorkspaceOverlay();
  try {
    assert.equal(state.workspaceOverlay.open, true);
    const editor = createEditorActions();

    // Ctrl+U (dequeue/edit queued) must NOT fire behind the modal.
    assert.equal(handleMixCodeKeyInput(state, "\x15", tui, undefined, undefined, undefined, () => false, editor.actions), undefined);
    assert.equal(tab.pendingFollowUps.length, 1);
    assert.equal(editor.text(), "");
    assert.equal(tab.vimEnterArmedAt, undefined);

    // Ctrl+T must not open Tab Jump over the modal (stale routing flags).
    assert.equal(handleMixCodeKeyInput(state, "\x14", tui, undefined, undefined, undefined, () => false, editor.actions), undefined);
    assert.equal(state.tabJumpOpen, false);
    assert.equal(state.workspaceOverlay.open, true);

    // Negative control: once the overlay closes, the editor owns ctrl+u again.
    closeWorkspaceOverlay(state, tui);
    assert.deepEqual(handleMixCodeKeyInput(state, "\x15", tui, undefined, undefined, undefined, () => false, editor.actions), { consume: true });
    assert.equal(tab.pendingFollowUps.length, 0);
    assert.equal(editor.text(), "queued steer message");
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
