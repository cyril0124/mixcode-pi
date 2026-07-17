import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PENDING_ESCAPE_CONFIRM_WINDOW_MS,
  armPendingEscape,
  clearPendingEscape,
  createTab,
  hasPendingEscape,
  isPendingEscapeActive,
} from "../src/index.js";

test("armPendingEscape sets action and armedAt to the provided now", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 1_700_000_000_000;

  armPendingEscape(tab, "abort-agent", now);

  assert.equal(tab.pendingEscapeAction, "abort-agent");
  assert.equal(tab.pendingEscapeArmedAt, now);
});

test("isPendingEscapeActive is true inside window and false after window+1", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 1_000;

  armPendingEscape(tab, "abort-agent", now);

  assert.equal(isPendingEscapeActive(tab, "abort-agent", now), true);
  assert.equal(
    isPendingEscapeActive(tab, "abort-agent", now + PENDING_ESCAPE_CONFIRM_WINDOW_MS),
    true,
  );
  assert.equal(
    isPendingEscapeActive(tab, "abort-agent", now + PENDING_ESCAPE_CONFIRM_WINDOW_MS + 1),
    false,
  );
});

test("hasPendingEscape is true while active; when expired returns false and clears fields", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 5_000;

  armPendingEscape(tab, "abort-agent", now);

  assert.equal(hasPendingEscape(tab, "abort-agent", now + 1), true);
  assert.equal(tab.pendingEscapeAction, "abort-agent");
  assert.equal(tab.pendingEscapeArmedAt, now);

  assert.equal(
    hasPendingEscape(tab, "abort-agent", now + PENDING_ESCAPE_CONFIRM_WINDOW_MS + 1),
    false,
  );
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(tab.pendingEscapeArmedAt, undefined);
});

test("clearPendingEscape clears matching action and armedAt together", () => {
  const tab = createTab(1, "s1", "/repo");
  const now = 9_000;
  armPendingEscape(tab, "abort-agent", now);

  clearPendingEscape(tab, "abort-agent");
  assert.equal(tab.pendingEscapeAction, undefined);
  assert.equal(tab.pendingEscapeArmedAt, undefined);
});
