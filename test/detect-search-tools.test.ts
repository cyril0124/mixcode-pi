import assert from "node:assert/strict";
import { test } from "node:test";
import { detectSearchTools, resolveFdBinary } from "../src/core/detect-search-tools.js";

test("resolveFdBinary is undefined, fd, or fdfind", () => {
  const binary = resolveFdBinary();
  assert.ok(
    binary === undefined || binary === "fd" || binary === "fdfind",
    `unexpected fd binary: ${String(binary)}`,
  );
});

test("hasFd tracks fd only; fdfind-only does not set hasFd", () => {
  const binary = resolveFdBinary();
  const { hasFd } = detectSearchTools();
  if (binary === "fd") {
    assert.equal(hasFd, true);
  } else if (binary === "fdfind") {
    // hasFd only probes "fd"; fdfind-only systems report hasFd=false.
    assert.equal(hasFd, false);
  }
});
