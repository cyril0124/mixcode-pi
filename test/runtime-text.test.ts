import assert from "node:assert/strict";
import { test } from "node:test";
import { contentText } from "../src/agent/runtime-text.js";

test("contentText returns string input as-is", () => {
  assert.equal(contentText("hello"), "hello");
  assert.equal(contentText(""), "");
});

test("contentText joins text blocks with newlines", () => {
  assert.equal(
    contentText([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ]),
    "a\nb",
  );
});

test("contentText uses [type] placeholders for blocks without text", () => {
  assert.equal(contentText([{ type: "image" }]), "[image]");
});

test("contentText preserves mixed block order", () => {
  assert.equal(
    contentText([
      { type: "text", text: "before" },
      { type: "image" },
      { type: "text", text: "after" },
    ]),
    "before\n[image]\nafter",
  );
});
