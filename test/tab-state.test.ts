// Tests for the tab-state mutation seam (src/core/tab-state.ts).
//
// These lock the status<->time invariant that was previously maintained by
// hand across runtime-events / runtime-lifecycle / runtime.ts:
//   - entering a working status stamps workingStartedAt
//   - leaving a working status computes lastWorkedDurationSeconds and clears the stamp
//   - the "preserve" path (auto-compaction continuation) keeps an existing stamp
// plus the pending-queue primitives.

import assert from "node:assert/strict";
import { test } from "node:test";
import { createTab } from "../src/core/defaults.js";
import { retryStatusMessage, setTabContextTokens, setTabStatus } from "../src/core/tab-state.js";

function tab() {
  return createTab(1, "s1", "/tmp");
}

test("setTabStatus: entering running stamps workingStartedAt and clears last duration", () => {
  const t = tab();
  t.lastWorkedDurationSeconds = 42;
  const now = new Date("2026-01-01T00:00:00.000Z");
  setTabStatus(t, "running", { now });
  assert.equal(t.status, "running");
  assert.equal(t.workingStartedAt, now.toISOString());
  assert.equal(t.lastWorkedDurationSeconds, undefined);
});

test("setTabStatus: entering thinking preserves an existing stamp (??= semantics)", () => {
  const t = tab();
  const started = "2026-01-01T00:00:00.000Z";
  t.workingStartedAt = started;
  setTabStatus(t, "thinking", { now: new Date("2026-01-01T00:00:05.000Z") });
  assert.equal(t.status, "thinking");
  // thinking keeps the original start time rather than resetting it
  assert.equal(t.workingStartedAt, started);
  assert.equal(t.lastWorkedDurationSeconds, undefined);
});

test("setTabStatus: leaving to idle computes elapsed seconds and clears the stamp", () => {
  const t = tab();
  t.workingStartedAt = "2026-01-01T00:00:00.000Z";
  setTabStatus(t, "idle", { now: new Date("2026-01-01T00:00:07.000Z") });
  assert.equal(t.status, "idle");
  assert.equal(t.lastWorkedDurationSeconds, 7);
  assert.equal(t.workingStartedAt, undefined);
});

test("setTabStatus: preserve keeps the stamp and skips duration when continuing", () => {
  const t = tab();
  const started = "2026-01-01T00:00:00.000Z";
  t.workingStartedAt = started;
  // auto-compaction continuation: stay running, keep the original timer
  setTabStatus(t, "running", {
    now: new Date("2026-01-01T00:00:09.000Z"),
    preserveStartedAt: true,
  });
  assert.equal(t.workingStartedAt, started);
  assert.equal(t.lastWorkedDurationSeconds, undefined);
});

test("setTabStatus: explicit startedAt override is used as the stamp", () => {
  const t = tab();
  const postRun = "2026-01-01T00:00:00.000Z";
  setTabStatus(t, "running", {
    now: new Date("2026-01-01T00:00:03.000Z"),
    startedAt: postRun,
  });
  assert.equal(t.workingStartedAt, postRun);
});

test("setTabStatus: idle with no stamp leaves duration undefined", () => {
  const t = tab();
  setTabStatus(t, "idle", { now: new Date() });
  assert.equal(t.lastWorkedDurationSeconds, undefined);
  assert.equal(t.workingStartedAt, undefined);
});

test("setTabStatus: error clears the active timer like idle", () => {
  const t = tab();
  t.workingStartedAt = "2026-01-01T00:00:00.000Z";
  setTabStatus(t, "error", { now: new Date("2026-01-01T00:00:04.000Z") });
  assert.equal(t.status, "error");
  assert.equal(t.lastWorkedDurationSeconds, 4);
  assert.equal(t.workingStartedAt, undefined);
});

test("setTabStatus: restart overwrites an existing stamp, unlike the default ??= preserve", () => {
  // This guards the seam's most behavior-critical distinction: a fresh agent run
  // (restart) must reset the clock, while turn_start / autoCompact continuation
  // (default ??=) must keep the original start time. A regression swapping these
  // would otherwise pass every other test.
  const started = "2026-01-01T00:00:00.000Z";
  const now = new Date("2026-01-01T00:00:09.000Z");

  const restarted = tab();
  restarted.workingStartedAt = started;
  setTabStatus(restarted, "running", { now, restart: true });
  assert.equal(restarted.workingStartedAt, now.toISOString());

  const preserved = tab();
  preserved.workingStartedAt = started;
  setTabStatus(preserved, "running", { now });
  assert.equal(preserved.workingStartedAt, started);
});

test("setTabStatus: discardTimer drops the stamp without recording a duration", () => {
  // Aborted/failed auto-compaction leaves work silently: status goes idle but
  // no worked-duration is recorded (unlike a normal idle transition, which
  // closes the timer into lastWorkedDurationSeconds).
  const t = tab();
  t.workingStartedAt = "2026-01-01T00:00:00.000Z";
  t.lastWorkedDurationSeconds = 99;
  setTabStatus(t, "idle", { now: new Date("2026-01-01T00:00:08.000Z"), discardTimer: true });
  assert.equal(t.status, "idle");
  assert.equal(t.workingStartedAt, undefined);
  assert.equal(t.lastWorkedDurationSeconds, undefined, "no duration recorded on discard");
});

test("setTabContextTokens distinguishes a real count from cleared (undefined)", () => {
  // The renderer treats undefined as "unknown" vs a number as "known"; the
  // clear path (usage.tokens === null upstream) must not collapse to 0.
  const t = tab();
  setTabContextTokens(t, 1234);
  assert.equal(t.currentContextTokens, 1234);
  setTabContextTokens(t, undefined);
  assert.equal(t.currentContextTokens, undefined);
});

test("retryStatusMessage: absent when no retry is in progress", () => {
  assert.equal(retryStatusMessage(tab(), new Date()), undefined);
});

test("retryStatusMessage: formats a live countdown mirroring Pi's status line", () => {
  const t = tab();
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  t.retryInfo = { attempt: 2, maxAttempts: 3, delayMs: 4000, startedAt };
  // 1.2s elapsed → ceil((4000-1200)/1000) = 3s remaining
  const now = new Date(startedAt + 1200);
  assert.equal(retryStatusMessage(t, now), "Retrying (2/3) in 3s... (esc to cancel)");
});

test("retryStatusMessage: clamps remaining seconds at zero once the delay elapses", () => {
  const t = tab();
  const startedAt = Date.parse("2026-01-01T00:00:00.000Z");
  t.retryInfo = { attempt: 1, maxAttempts: 3, delayMs: 2000, startedAt };
  const now = new Date(startedAt + 5000);
  assert.equal(retryStatusMessage(t, now), "Retrying (1/3) in 0s... (esc to cancel)");
});
