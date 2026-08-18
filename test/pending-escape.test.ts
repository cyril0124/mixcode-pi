import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
  armPendingEscape,
  clearPendingEscape,
  createTab,
  isPendingEscapeActive,
} from "./helpers/mixcode.js";

test("armPendingEscape sets armedAt to the provided now", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 1_700_000_000_000;

  armPendingEscape(tab, now);

  assert.equal(tab.pendingEscapeArmedAt, now);
});

test("isPendingEscapeActive is true inside window and false after window+1", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 1_000;

  armPendingEscape(tab, now);

  assert.equal(isPendingEscapeActive(tab, now), true);
  assert.equal(
    isPendingEscapeActive(tab, now + PENDING_ESCAPE_CONFIRM_WINDOW_MS),
    true,
  );
  assert.equal(
    isPendingEscapeActive(tab, now + PENDING_ESCAPE_CONFIRM_WINDOW_MS + 1),
    false,
  );
});

test("clearPendingEscape clears armedAt", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 9_000;
  armPendingEscape(tab, now);

  clearPendingEscape(tab);
  assert.equal(tab.pendingEscapeArmedAt, undefined);
});
