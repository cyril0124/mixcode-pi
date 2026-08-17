import assert from "node:assert/strict";
import { test } from "node:test";
import { createSessionId } from "../src/core/defaults.js";
import { UUIDV7_SESSION_ID_PATTERN } from "./helpers/session-id.js";

test("createSessionId() returns a UUID v7 session id", () => {
  assert.match(createSessionId(), UUIDV7_SESSION_ID_PATTERN);
});
