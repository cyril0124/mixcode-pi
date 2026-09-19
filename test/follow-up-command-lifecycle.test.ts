import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createInitialState, createTab } from "../src/core/defaults.js";
import type { MixCodeState, MixCodeTabInfo } from "../src/core/types.js";
import { openQuitConfirm } from "../src/ui/app-actions.js";
import { handleQuitConfirmKey, dispatchOwnedOverlayKey } from "../src/ui/app-key-handlers.js";
import { handleSubmittedInput } from "../src/ui/app-submit.js";
import { takeQueuedCommandCompletion } from "../src/ui/queued-command-completion.js";
import { MIXCODE_FAUX_MODEL, MixCodeRuntime } from "./helpers/mixcode.js";
import { testTui } from "./helpers/tui.js";

async function withRuntime(
  run: (context: {
    runtime: MixCodeRuntime;
    state: MixCodeState;
    tab: MixCodeTabInfo;
    other: MixCodeTabInfo;
    releaseGates: Array<() => void>;
  }) => Promise<void>,
): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-command-lifecycle-"));
  const runtime = new MixCodeRuntime({ sessionsRoot: dir });
  const state = createInitialState(dir);
  const releaseGates: Array<() => void> = [];
  const errors: unknown[] = [];
  try {
    const tab = createTab(1, "command-owner", dir);
    const other = createTab(2, "other", dir);
    state.tabs.push(tab, other);
    state.activeTabId = tab.sessionId;
    for (const item of state.tabs) {
      await runtime.createTab(item, {
        systemPrompt: "system",
        thinkingLevel: "off",
        workdir: dir,
        model: MIXCODE_FAUX_MODEL,
      });
    }
    await run({ runtime, state, tab, other, releaseGates });
  } catch (error) {
    errors.push(error);
  } finally {
    const tabs = runtime.listTabs();
    for (const tab of tabs) tab.tab.followUpsPaused = true;
    const drains = Promise.allSettled(tabs.map((tab) => tab.followUpDrain));
    // Remove UI owners before releasing the shared slot so a waiting dialog
    // cancels instead of opening during teardown after a failed assertion.
    state.tabs = [];
    takeQueuedCommandCompletion(state)?.reject(new Error("Error: Queued command cancelled"));
    for (const release of releaseGates) release();
    const results = await drains;
    await runtime.closeAllTabs();
    runtime.beginShutdown();
    await fs.rm(dir, { recursive: true, force: true });
    const failures = results.filter(
      (result): result is PromiseRejectedResult =>
        result.status === "rejected" &&
        !(
          result.reason instanceof Error &&
          result.reason.message === "Error: Queued command cancelled"
        ),
    );
    errors.push(...failures.map((result) => result.reason));
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Command fixture failed");
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

for (const command of [
  "close-session",
  "delete-session",
  "close-all-sessions",
  "delete-all-sessions",
]) {
  test(`queued /${command} cancellation pauses subsequent tasks`, async () => {
    await withRuntime(async ({ runtime, state, tab, other }) => {
      tab.followUpsPaused = true;
      const tui = testTui();
      await handleSubmittedInput(state, runtime, `/follow-up /${command}`, tui);
      await handleSubmittedInput(state, runtime, "/follow-up /color blue", tui);
      state.activeTabId = other.sessionId;
      const resumed = runtime.resumeFollowUps(tab.sessionId);
      const rejected = assert.rejects(resumed, /Error: Queued command cancelled/);
      await nextTurn();
      assert.equal(state.activeTabId, command.includes("all") ? other.sessionId : tab.sessionId);
      state.activeTabId = other.sessionId;
      assert.equal(tab.color, undefined);
      assert.deepEqual(tab.pendingFollowUps, ["/color blue"]);
      assert.equal(dispatchOwnedOverlayKey(state, tab, "n", tui, runtime), true);
      await rejected;
      assert.equal(tab.followUpsPaused, true);
      assert.equal(state.tabs.includes(tab), true);
      assert.equal(state.activeTabId, other.sessionId);
      await runtime.resumeFollowUps(tab.sessionId);
      assert.equal(tab.color, "blue");
      assert.equal(other.color, undefined);
    });
  });
}

test("two queued confirmations retain the first overlay until cancellation and explicit resume", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    const tui = testTui();
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /close-session", tui);
    await handleSubmittedInput(state, runtime, "/follow-up /delete-session", tui);
    const resumed = runtime.resumeFollowUps(tab.sessionId);
    const rejected = assert.rejects(resumed, /Error: Queued command cancelled/);
    await nextTurn();
    assert.deepEqual(state.sessionActionConfirm, { action: "close", sessionId: tab.sessionId });
    dispatchOwnedOverlayKey(state, tab, "n", tui, runtime);
    await rejected;
    assert.equal(state.sessionActionConfirm, null);
    const second = runtime.resumeFollowUps(tab.sessionId);
    const secondRejected = assert.rejects(second, /Error: Queued command cancelled/);
    await nextTurn();
    assert.deepEqual(state.sessionActionConfirm, { action: "delete", sessionId: tab.sessionId });
    dispatchOwnedOverlayKey(state, tab, "\x1b", tui, runtime);
    await secondRejected;
  });
});

for (const command of [
  "close-session",
  "delete-session",
  "close-all-sessions",
  "delete-all-sessions",
]) {
  test(`confirmed queued /${command} waits for persistence and drops old tasks`, async () => {
    await withRuntime(async ({ runtime, state, tab, other, releaseGates }) => {
      const tui = testTui();
      tab.followUpsPaused = true;
      await handleSubmittedInput(state, runtime, `/follow-up /${command}`, tui);
      await handleSubmittedInput(state, runtime, "/follow-up /color blue", tui);
      state.activeTabId = other.sessionId;
      let settled = false;
      const resumed = runtime.resumeFollowUps(tab.sessionId).then(() => {
        settled = true;
      });
      await nextTurn();
      assert.equal(state.activeTabId, command.includes("all") ? other.sessionId : tab.sessionId);
      state.activeTabId = other.sessionId;
      assert.equal(settled, false);
      const persisting = Promise.withResolvers<void>();
      const persist = Promise.withResolvers<void>();
      releaseGates.push(persist.resolve);
      dispatchOwnedOverlayKey(state, tab, "y", tui, runtime, () => {
        persisting.resolve();
        return persist.promise;
      });
      await persisting.promise;
      assert.equal(settled, false);
      persist.resolve();
      await resumed;
      assert.equal(runtime.getTab(tab.sessionId), undefined);
      assert.equal(state.tabs.includes(tab), false);
      assert.deepEqual(tab.pendingFollowUps, []);
      assert.equal(tab.color, undefined);
      assert.equal(other.color, undefined);
      assert.equal(state.activeTabId, command.includes("all") ? "home" : other.sessionId);
    });
  });
}

test("confirmations queued on different tabs never overwrite each other", async () => {
  await withRuntime(async ({ runtime, state, tab, other }) => {
    const tui = testTui();
    tab.followUpsPaused = true;
    other.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /close-session", tui);
    state.activeTabId = other.sessionId;
    await handleSubmittedInput(state, runtime, "/follow-up /delete-session", tui);
    const first = assert.rejects(
      runtime.resumeFollowUps(tab.sessionId),
      /Error: Queued command cancelled/,
    );
    const second = assert.rejects(
      runtime.resumeFollowUps(other.sessionId),
      /Error: Queued command cancelled/,
    );
    await nextTurn();
    assert.equal(state.activeTabId, tab.sessionId);
    assert.deepEqual(state.sessionActionConfirm, { action: "close", sessionId: tab.sessionId });
    dispatchOwnedOverlayKey(state, tab, "n", tui, runtime);
    await first;
    await nextTurn();
    assert.deepEqual(state.sessionActionConfirm, { action: "delete", sessionId: other.sessionId });
    dispatchOwnedOverlayKey(state, other, "n", tui, runtime);
    await second;
    assert.equal(state.activeTabId, other.sessionId);
    assert.deepEqual(
      state.tabs.map((item) => item.sessionId),
      [tab.sessionId, other.sessionId],
    );
  });
});

test("a direct confirmation cannot replace a queued confirmation", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    const tui = testTui();
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /close-session", tui);
    const rejected = assert.rejects(
      runtime.resumeFollowUps(tab.sessionId),
      /Error: Queued command cancelled/,
    );
    await nextTurn();
    await assert.rejects(
      handleSubmittedInput(state, runtime, "/delete-all-sessions", tui),
      /Error: Another session confirmation is already open/,
    );
    assert.deepEqual(state.sessionActionConfirm, { action: "close", sessionId: tab.sessionId });
    assert.equal(state.deleteAllSessionsConfirmOpen, false);
    dispatchOwnedOverlayKey(state, tab, "n", tui, runtime);
    await rejected;
  });
});

test("bulk close cancels another tab's waiting confirmation without opening a stale overlay", async () => {
  await withRuntime(async ({ runtime, state, tab, other }) => {
    const tui = testTui();
    tab.followUpsPaused = true;
    other.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /close-all-sessions", tui);
    state.activeTabId = other.sessionId;
    await handleSubmittedInput(state, runtime, "/follow-up /delete-all-sessions", tui);
    const first = runtime.resumeFollowUps(tab.sessionId);
    const second = assert.rejects(
      runtime.resumeFollowUps(other.sessionId),
      /Error: Queued command cancelled/,
    );
    await nextTurn();
    assert.equal(state.closeAllSessionsConfirmOpen, true);
    assert.equal(state.deleteAllSessionsConfirmOpen, false);
    dispatchOwnedOverlayKey(state, tab, "y", tui, runtime);
    await first;
    await second;
    assert.deepEqual(state.tabs, []);
    assert.equal(state.deleteAllSessionsConfirmOpen, false);
  });
});

test("queued confirmation rejects when the confirmed action cannot persist state", async () => {
  await withRuntime(async ({ runtime, state, tab }) => {
    const tui = testTui();
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /close-session", tui);
    const resumed = assert.rejects(
      runtime.resumeFollowUps(tab.sessionId),
      /Error: persistence failed/,
    );
    await nextTurn();
    dispatchOwnedOverlayKey(state, tab, "y", tui, runtime, () => {
      throw new Error("Error: persistence failed");
    });
    await resumed;
    assert.equal(state.sessionActionConfirm, null);
    assert.equal(state.tabs.includes(tab), false);
  });
});

for (const command of ["follow-up", "follow-up-next"]) {
  test(`/${command} preserves quotes, internal spaces and newlines through runtime delivery`, async () => {
    await withRuntime(async ({ runtime, state, tab }) => {
      tab.followUpsPaused = true;
      const text = 'quote "two  words"\nnext   line';
      await handleSubmittedInput(state, runtime, `/${command} ${text}`, testTui());
      assert.deepEqual(tab.pendingFollowUps, [text]);
      await runtime.resumeFollowUps(tab.sessionId);
      assert.deepEqual(
        runtime
          .getTab(tab.sessionId)!
          .chat.filter((line) => line.role === "user")
          .map((line) => line.text),
        [text],
      );
    });
  });
}

test("replacing a queued confirmation with quit cancels active and waiting dialogs", async () => {
  await withRuntime(async ({ runtime, state, tab, other }) => {
    const tui = testTui();
    tab.followUpsPaused = true;
    other.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /close-session", tui);
    await handleSubmittedInput(state, runtime, "/follow-up /color red", tui);
    state.activeTabId = other.sessionId;
    await handleSubmittedInput(state, runtime, "/follow-up /delete-session", tui);
    await handleSubmittedInput(state, runtime, "/follow-up /color blue", tui);
    const first = assert.rejects(
      runtime.resumeFollowUps(tab.sessionId),
      /Queued command cancelled/,
    );
    const second = assert.rejects(
      runtime.resumeFollowUps(other.sessionId),
      /Queued command cancelled/,
    );
    await nextTurn();
    state.activeTabId = other.sessionId;
    openQuitConfirm(state, tui);
    handleQuitConfirmKey(state, "n", tui, runtime);
    await Promise.all([first, second]);
    assert.equal(state.sessionActionConfirm, null);
    assert.equal(state.quitConfirmOpen, false);
    assert.equal(tab.followUpsPaused, true);
    assert.equal(other.followUpsPaused, true);
    await runtime.resumeFollowUps(tab.sessionId);
    await runtime.resumeFollowUps(other.sessionId);
    assert.equal(tab.color, "red");
    assert.equal(other.color, "blue");
  });
});

test("queued invalid color reports Error on the original tab after focus switches", async () => {
  await withRuntime(async ({ runtime, state, tab, other }) => {
    tab.followUpsPaused = true;
    await handleSubmittedInput(state, runtime, "/follow-up /color invalid", testTui());
    state.activeTabId = other.sessionId;
    await runtime.resumeFollowUps(tab.sessionId);
    assert.equal(
      runtime
        .getTab(tab.sessionId)!
        .chat.some((line) => line.text.startsWith("Error: Unknown color: invalid")),
      true,
    );
    assert.equal(
      runtime.getTab(other.sessionId)!.chat.some((line) => line.text.includes("Unknown color")),
      false,
    );
  });
});
