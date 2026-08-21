import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MIXCODE_KEYMAP,
  fitHeadLines,
  fitTailLines,
  renderHotkeysText,
} from "./helpers/mixcode.js";

test("fitTailLines keeps the newest lines and marks overflow", () => {
  assert.deepEqual(fitTailLines(["a", "b"], 3, 10), ["a", "b"]);
  assert.deepEqual(fitTailLines(["a", "b"], 0, 10), []);
  assert.match(fitTailLines(["a", "b", "c"], 2, 10).join("\n"), /\.\.\.[\s\S]*c/);
});

test("fitHeadLines keeps the oldest lines and marks overflow", () => {
  assert.deepEqual(fitHeadLines(["a", "b"], 3, 10), ["a", "b"]);
  assert.deepEqual(fitHeadLines(["a", "b"], 0, 10), []);
  assert.match(fitHeadLines(["a", "b", "c"], 2, 10).join("\n"), /a[\s\S]*\.\.\./);
});

test("queue dequeue keymap uses Ctrl+U chords without Alt", () => {
  const queueBindings = MIXCODE_KEYMAP.filter((item) => item.action.includes("queued-message"));
  assert.deepEqual(
    queueBindings.map((item) => item.key),
    ["ctrl+u", "ctrl+u s / ctrl+u f"],
  );
});

test("hotkeys formats Ctrl+U queue choices as key sequences", () => {
  assert.match(renderHotkeysText(), /`Ctrl\+U, S \/ Ctrl\+U, F`/);
});

test("keymap export documents global and scoped bindings", () => {
  const scopes = new Set(MIXCODE_KEYMAP.map((item) => item.scope ?? "global"));
  for (const scope of [
    "global",
    "picker",
    "command-palette",
    "tab-jump",
    "agent",
    "home",
  ] as const) {
    assert.equal(scopes.has(scope), true, `${scope} scope should exist`);
  }
});
