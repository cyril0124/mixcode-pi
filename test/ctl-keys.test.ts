import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeSendKeys } from "../src/cli/ctl-keys.js";

test("encodeSendKeys maps tmux named keys and control chords", () => {
  assert.equal(encodeSendKeys(["Enter"]), "\r");
  assert.equal(encodeSendKeys(["Escape"]), "\x1b");
  assert.equal(encodeSendKeys(["Esc"]), "\x1b");
  assert.equal(encodeSendKeys(["Tab"]), "\t");
  assert.equal(encodeSendKeys(["BSpace"]), "\x7f");
  assert.equal(encodeSendKeys(["Up"]), "\x1b[A");
  assert.equal(encodeSendKeys(["C-p"]), "\x10");
  assert.equal(encodeSendKeys(["C-a"]), "\x01");
  assert.equal(encodeSendKeys(["C-Space"]), "\x00");
  assert.equal(encodeSendKeys(["M-x"]), "\x1bx");
  assert.equal(encodeSendKeys(["M-Enter"]), "\x1b\r");
  assert.equal(encodeSendKeys(["M-C-a"]), "\x1b\x01");
  assert.equal(encodeSendKeys(["/compact", "Enter"]), "/compact\r");
});

test("encodeSendKeys --literal joins tokens without named-key mapping", () => {
  assert.equal(encodeSendKeys(["Enter"], { literal: true }), "Enter");
  assert.equal(encodeSendKeys(["a", "b"], { literal: true }), "ab");
});

test("encodeSendKeys fails loud on unknown C- chords", () => {
  assert.throws(() => encodeSendKeys(["C-F1"]), /Unknown send-keys token: C-F1/);
});
