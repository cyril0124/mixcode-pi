import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
} from "../src/index.js";

// Baseline behavior contracts for Escape-key dispatch. These lock the observable
// behavior before the dispatch is refactored into a single ordered entry point,
// so a regression in ordering or in the working-state check fails loudly.
//
// The dispatch has several branches that must keep their relative priority:
//   1. extension custom overlay focus  (Esc refocuses the overlay)
//   2. queued-message flush            (Esc flushes pending prompts)
//   3. streaming/working abort         (Esc arms, second Esc aborts)
//   4. empty-editor double-Esc         (opens tree / fork / nothing)
// Plus the working-state check must treat retry/compaction (isStreaming=false
// but a working tab status) as abortable, not fall through to the tree.

function silentTui() {
  return {
    requestRender: () => undefined,
    showOverlay: () => ({}) as never,
    hasOverlay: () => false,
  };
}

const ESC = "\x1b";

test("escape arms then aborts a normal streaming run", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  };

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(tab.pendingEscapeAction, "abort-agent", "first Esc arms abort");
  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(aborts, 1, "second Esc aborts");
  assert.equal(tab.pendingEscapeAction, undefined, "arm cleared after abort");
});

test("escape aborts during retry when the agent is not streaming (regression guard)", () => {
  // During auto-retry the SDK is sleeping between attempts, so isStreaming is
  // false while the tab status stays "thinking". The abort path must still
  // engage here — otherwise Esc falls through and (double-Esc) opens the tree,
  // which was the original bug.
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "thinking",
    retryInfo: { attempt: 2, maxAttempts: 10, delayMs: 4000, startedAt: Date.now() },
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: false } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  };

  // First Esc must arm the abort (be consumed by the abort branch), not fall
  // through to the double-escape tree branch.
  const first = handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.deepEqual(first, { consume: true }, "retry Esc is consumed by abort branch");
  assert.equal(tab.pendingEscapeAction, "abort-agent", "retry Esc arms abort");
  assert.equal(tab.lastEscapeTime, undefined, "retry Esc does not arm the tree double-press");

  const second = handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.deepEqual(second, { consume: true });
  assert.equal(aborts, 1, "second Esc aborts the retry");
});

test("expired abort arm re-arms instead of aborting", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  };

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  tab.pendingEscapeArmedAt = Date.now() - PENDING_ESCAPE_CONFIRM_WINDOW_MS - 1;
  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(aborts, 0, "expired arm does not abort");
  assert.equal(tab.pendingEscapeAction, "abort-agent", "expired arm re-arms");
});

test("extension custom overlay takes escape before the abort branch", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let focused = 0;
  let aborts = 0;
  const runtime = {
    getTab: () => ({ agent: { state: { isStreaming: true } } }),
    hasExtensionCustomOverlay: () => true,
    focusExtensionCustomOverlay: () => {
      focused++;
    },
    abortTab: () => {
      aborts++;
      return true;
    },
  };

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(focused, 1, "overlay is refocused");
  assert.equal(aborts, 0, "abort branch is not reached");
  assert.equal(tab.pendingEscapeAction, undefined, "abort is not armed behind the overlay");
});

test("queued-message flush wins over double-escape stop", () => {
  // With queued prompts and an active run, Esc flushes the queue (aborting the
  // run as part of the flush) rather than arming the double-escape stop.
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "thinking",
    pendingMessages: ["queued prompt"],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let flushed = 0;
  const runtime = {
    getTab: () => ({
      agent: { state: { isStreaming: true } },
      queuedPromptCount: 1,
      agentSession: { getSteeringMessages: () => ["queued prompt"] },
    }),
    abortTab: () => true,
    flushPendingMessage: () => {
      flushed++;
      return Promise.resolve();
    },
  };

  const result = handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.deepEqual(result, { consume: true });
  assert.equal(flushed, 1, "queued flush runs");
  assert.equal(tab.pendingEscapeAction, undefined, "double-escape stop is not armed");
});

test("double escape on an empty editor opens the tree for an idle tab", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "idle" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let treeOpened = 0;
  // Tree open path calls getTab().session.getTree(); return empty tree so the
  // path is exercised but short-circuits before needing a display host.
  const runtime = {
    getTab: () => ({
      agent: { state: { isStreaming: false } },
      session: {
        getTree: () => {
          treeOpened++;
          return [];
        },
        getLeafId: () => undefined,
      },
    }),
  };
  const editor = { getText: () => "", setText: () => undefined };

  const first = handleMixCodeKeyInput(
    state,
    ESC,
    silentTui(),
    undefined,
    runtime,
    undefined,
    () => false,
    editor,
  );
  assert.deepEqual(first, { consume: true });
  assert.ok(tab.lastEscapeTime, "first Esc arms the tree double-press");
  assert.equal(treeOpened, 0, "single Esc does not open the tree");

  const second = handleMixCodeKeyInput(
    state,
    ESC,
    silentTui(),
    undefined,
    runtime,
    undefined,
    () => false,
    editor,
  );
  assert.deepEqual(second, { consume: true });
  assert.equal(treeOpened, 1, "double Esc reaches the tree open path");
});
