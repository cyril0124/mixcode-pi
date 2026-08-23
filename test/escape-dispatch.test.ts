import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInitialState,
  createTab,
  handleMixCodeKeyInput,
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
} from "./helpers/mixcode.js";
import { hasAppOverlay, showErrorOverlay } from "../src/ui/app-overlays.js";
import { testOverlayHandle, testTui } from "./helpers/tui.js";
import { testRuntime } from "./helpers/runtime-stub.js";
import { testRuntimeTab } from "./helpers/runtime-tab.js";

// RuntimeTab double: only the members a test exercises are supplied, but their
// names and signatures stay checked against the production interface.
// agentSession/session are class instances, so they get their own Partial.
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
  return testTui({ hasOverlay: () => false });
}

const ESC = "\x1b";

test("escape clears bash-mode editor text without submitting", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "idle" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let text = "!echo should-clear";
  const editorActions = {
    getText: () => text,
    setText: (next: string) => {
      text = next;
    },
  };
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({
        agentSession: {
          isStreaming: false,
          isBashRunning: false,
          getSteeringMessages: () => [],
        },
        queuedPromptCount: 0,
      }),
  });

  const result = handleMixCodeKeyInput(
    state,
    ESC,
    silentTui(),
    undefined,
    runtime,
    undefined,
    () => false,
    editorActions,
  );
  assert.deepEqual(result, { consume: true });
  assert.equal(text, "");
});

test("escape aborts standalone bash on first press (Pi parity)", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "running" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({
        agentSession: {
          isStreaming: false,
          isBashRunning: true,
          getSteeringMessages: () => [],
        },
        queuedPromptCount: 0,
      }),
    abortTab: () => {
      aborts++;
      return true;
    },
  });

  const first = handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.deepEqual(first, { consume: true });
  assert.equal(aborts, 1, "first Esc aborts bash immediately");
  assert.equal(tab.pendingEscapeArmedAt, undefined, "bash Esc does not arm double-confirm");
});

test("escape arms then aborts a normal streaming run", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  });

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(typeof tab.pendingEscapeArmedAt, "number", "first Esc arms abort");
  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(aborts, 1, "second Esc aborts");
  assert.equal(tab.pendingEscapeArmedAt, undefined, "arm cleared after abort");
});

test("escape uses AgentSession streaming state when low-level agent state is stale", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "idle" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => true,
  });

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(typeof tab.pendingEscapeArmedAt, "number");
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
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: false, getSteeringMessages: () => [] } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  });

  // First Esc must arm the abort (be consumed by the abort branch), not fall
  // through to the double-escape tree branch.
  const first = handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.deepEqual(first, { consume: true }, "retry Esc is consumed by abort branch");
  assert.equal(typeof tab.pendingEscapeArmedAt, "number", "retry Esc arms abort");
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
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    abortTab: () => {
      aborts++;
      return true;
    },
  });

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  tab.pendingEscapeArmedAt = Date.now() - PENDING_ESCAPE_CONFIRM_WINDOW_MS - 1;
  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(aborts, 0, "expired arm does not abort");
  assert.equal(typeof tab.pendingEscapeArmedAt, "number", "expired arm re-arms");
});

test("extension custom overlay takes escape before the abort branch", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "thinking" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let focused = 0;
  let aborts = 0;
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({ agentSession: { isStreaming: true, getSteeringMessages: () => [] } }),
    hasExtensionCustomOverlay: () => true,
    focusExtensionCustomOverlay: () => {
      focused++;
    },
    abortTab: () => {
      aborts++;
      return true;
    },
  });

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(focused, 1, "overlay is refocused");
  assert.equal(aborts, 0, "abort branch is not reached");
  assert.equal(tab.pendingEscapeArmedAt, undefined, "abort is not armed behind the overlay");
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
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({
        queuedPromptCount: 1,
        agentSession: { isStreaming: true, getSteeringMessages: () => ["queued prompt"] },
      }),
    abortTab: () => true,
    flushPendingMessage: () => {
      flushed++;
      return Promise.resolve();
    },
  });

  const result = handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.deepEqual(result, { consume: true });
  assert.equal(flushed, 1, "queued flush runs");
  assert.equal(tab.pendingEscapeArmedAt, undefined, "double-escape stop is not armed");
});

test("queued-message flush uses AgentSession streaming state", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", {
    status: "idle",
    pendingMessages: ["queued prompt"],
  });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let aborts = 0;
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({
        queuedPromptCount: 1,
        agentSession: { isStreaming: true, getSteeringMessages: () => ["queued prompt"] },
      }),
    abortTab: () => {
      aborts++;
      return true;
    },
    flushPendingMessage: () => Promise.resolve(),
  });

  handleMixCodeKeyInput(state, ESC, silentTui(), undefined, runtime);
  assert.equal(aborts, 1);
});

test("escape closes a generic app overlay (error overlay 'Esc to close' contract)", () => {
  // Error/text overlays have no dedicated state flag; they rely on the generic
  // Esc fallback in handleMixCodeKeyInput. The overlay panel itself renders an
  // "Esc to close" hint, so this contract is user-visible.
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "idle" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  // Overlay-capable tui: the returned handle tracks visibility so that
  // hasAppOverlay flips on show/hide.
  let visible = false;
  const tui = testTui({
    showOverlay: () => {
      visible = true;
      return testOverlayHandle(() => {
        visible = false;
      });
    },
    hasOverlay: () => visible,
  });

  showErrorOverlay(tui, new Error("boom"));
  assert.equal(hasAppOverlay(tui), true, "error overlay is registered");

  const result = handleMixCodeKeyInput(state, ESC, tui, undefined, undefined);
  assert.deepEqual(result, { consume: true }, "Esc is consumed by the overlay close");
  assert.equal(hasAppOverlay(tui), false, "Esc dismisses the error overlay");
});

test("double escape on an empty editor opens the tree for an idle tab", () => {
  const state = createInitialState("/repo");
  const tab = createTab(1, "s1", "/repo", { status: "idle" });
  state.tabs.push(tab);
  state.activeTabId = "s1";
  let treeOpened = 0;
  // Tree open path calls getTab().session.getTree(); return empty tree so the
  // path is exercised but short-circuits before needing a display host.
  const runtime = testRuntime({
    getTab: () =>
      testRuntimeTab({
        agentSession: { isStreaming: false, getSteeringMessages: () => [] },
        session: {
          getTree: () => {
            treeOpened++;
            return [];
          },
          // SessionManager.getLeafId returns string | null, never undefined.
          getLeafId: () => null,
        },
      }),
  });
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
