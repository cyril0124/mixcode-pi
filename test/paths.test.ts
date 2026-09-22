// Tests for the shared `~` display collapse (src/core/paths.ts).
//
// The boundary rule is the regression risk: the home dir itself and its
// descendants collapse, a sibling that merely shares the prefix does not.

import assert from "node:assert/strict";
import { test } from "node:test";
import { collapseHome } from "../src/core/paths.js";

const ENV = { HOME: "/home/user" };

test("collapseHome collapses the home dir and its descendants", () => {
  assert.equal(collapseHome("/home/user", ENV), "~");
  assert.equal(collapseHome("/home/user/projects/app", ENV), "~/projects/app");
});

test("collapseHome leaves paths that only share the home prefix absolute", () => {
  assert.equal(collapseHome("/home/user-backup", ENV), "/home/user-backup");
  assert.equal(collapseHome("/home/user2", ENV), "/home/user2");
  assert.equal(collapseHome("/tmp/app", ENV), "/tmp/app");
});
