import assert from "node:assert/strict";
import { test } from "node:test";
import { detectSearchTools } from "../src/core/detect-search-tools.js";

test("detectSearchTools reports boolean availability", () => {
  const availability = detectSearchTools();
  assert.equal(typeof availability.hasRg, "boolean");
  assert.equal(typeof availability.hasFd, "boolean");
});
