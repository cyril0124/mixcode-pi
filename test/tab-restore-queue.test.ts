/**
 * Contract: restoring tabs one at a time must never wait on the user. A tab
 * parked in an extension dialog (its session exists, it waits on a human) hands
 * the queue to the next tab, and a failing tab does not strand the tabs behind it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreTabsInOrder } from "../src/cli/tab-restore-queue.js";
import { createTab } from "../src/core/defaults.js";

const WORKDIR = "/tmp/mixcode-restore-queue";

test("restoreTabsInOrder restores tabs in listed order", async () => {
  const tabs = [createTab(1, "s1", WORKDIR), createTab(2, "s2", WORKDIR)];
  const restored: string[] = [];
  await restoreTabsInOrder(tabs, {
    restore: async (tab) => {
      restored.push(tab.sessionId);
    },
  });
  assert.deepEqual(restored, ["s1", "s2"]);
});

test("a tab waiting on an extension dialog hands the queue to the next tab", async () => {
  const parked = createTab(1, "s1", WORKDIR);
  const next = createTab(2, "s2", WORKDIR);
  const answered = Promise.withResolvers<void>();
  let userAnswered = false;
  const restored: string[] = [];
  const awaiting: string[] = [];
  await restoreTabsInOrder([parked, next], {
    restore: async (tab) => {
      restored.push(tab.sessionId);
      if (tab !== parked) return;
      // session_start ran an extension handler that opened a dialog and now
      // awaits the answer, so this restore stays pending until the user replies.
      parked.extensionUi.waitingForInputs.push({ id: "dialog-1", kind: "custom" });
      await answered.promise;
    },
    onAwaitingInput: (tab) => awaiting.push(tab.sessionId),
  });

  // The queue ran through every tab while the first restore was still parked.
  assert.deepEqual(restored, ["s1", "s2"]);
  assert.deepEqual(awaiting, ["s1"]);
  assert.equal(userAnswered, false);

  // Answering later completes the parked restore; the queue already moved on.
  userAnswered = true;
  parked.extensionUi.waitingForInputs = [];
  answered.resolve();
  await new Promise((resolve) => setTimeout(resolve, 20));
});

test("a failing tab does not strand the tabs behind it", async () => {
  const broken = createTab(1, "s1", WORKDIR);
  const ok = createTab(2, "s2", WORKDIR);
  const restored: string[] = [];
  const failures: Array<{ sessionId: string; error: unknown }> = [];
  await restoreTabsInOrder([broken, ok], {
    restore: async (tab) => {
      if (tab === broken) throw new Error("extension load failed");
      restored.push(tab.sessionId);
    },
    onError: (tab, error) => failures.push({ sessionId: tab.sessionId, error }),
  });

  assert.deepEqual(restored, ["s2"]);
  assert.equal(failures.length, 1);
  assert.equal(failures[0]!.sessionId, "s1");
  assert.equal((failures[0]!.error as Error).message, "extension load failed");
});
