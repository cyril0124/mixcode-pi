import assert from "node:assert/strict";
import { test } from "node:test";
import { PasteDetector } from "../src/ui/paste-detect.js";

test("pasteDetector: single input is not paste", () => {
  const detector = createFreshDetector();
  detector.recordInput("a");
  assert.equal(detector.isLikelyPaste(), false);
});

test("pasteDetector: rapid inputs detected as paste", () => {
  const detector = createFreshDetector();
  // Simulate 3 rapid inputs at the same timestamp
  detector.recordInput("a");
  detector.recordInput("b");
  detector.recordInput("c");
  assert.equal(detector.isLikelyPaste(), true);
});

test("pasteDetector: slow inputs not detected as paste", () => {
  let now = 0;
  const detector = createFreshDetector(() => now);
  detector.recordInput("a");
  now = 10;
  detector.recordInput("b");
  now = 20;
  detector.recordInput("c");
  // Old timestamps should have been pruned
  assert.equal(detector.isLikelyPaste(), false);
});

test("pasteDetector: escape sequences are ignored", () => {
  const detector = createFreshDetector();
  // Multi-char escape sequences should not count
  detector.recordInput("\x1b[A");
  detector.recordInput("\x1b[B");
  detector.recordInput("\x1b[C");
  assert.equal(detector.isLikelyPaste(), false);
});

test("pasteDetector: carriage return counts as input", () => {
  const detector = createFreshDetector();
  detector.recordInput("a");
  detector.recordInput("b");
  detector.recordInput("\r");
  assert.equal(detector.isLikelyPaste(), true);
});

function createFreshDetector(now?: () => number): PasteDetector {
  return new PasteDetector(now);
}
