import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionId, UUIDV7_SESSION_ID_PATTERN } from "../src/core/session-ids.js";

test("createSessionId() returns a UUID v7 session id", () => {
  assert.match(createSessionId(), UUIDV7_SESSION_ID_PATTERN);
});

test("UUIDV7_SESSION_ID_PATTERN rejects non-v7 and empty ids", () => {
  assert.equal(UUIDV7_SESSION_ID_PATTERN.test(""), false);
  // Valid shape, but version nibble is 4 (not 7).
  assert.equal(UUIDV7_SESSION_ID_PATTERN.test("00000000-0000-4000-8000-000000000000"), false);
  // All zeros: version nibble is 0, not 7.
  assert.equal(UUIDV7_SESSION_ID_PATTERN.test("00000000-0000-0000-0000-000000000000"), false);
});
