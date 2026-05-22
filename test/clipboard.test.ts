import assert from "node:assert/strict";
import { test } from "node:test";
import { copyWithOsc52 } from "../src/index.js";

test("copyWithOsc52 writes a base64 clipboard sequence", () => {
  let written = "";
  copyWithOsc52("hello", (data) => {
    written += data;
  });
  assert.equal(written, "\x1b]52;c;aGVsbG8=\x07");
});
