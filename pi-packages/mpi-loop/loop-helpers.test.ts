import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRelativeTime } from "./loop-helpers.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const cases = [
  { remainingMs: 2 * HOUR_MS, expected: "in 2h" },
  { remainingMs: 2 * HOUR_MS - 1, expected: "in 1h59m" },
  { remainingMs: 1.5 * HOUR_MS, expected: "in 1h30m" },
  { remainingMs: HOUR_MS, expected: "in 1h" },
  { remainingMs: HOUR_MS - 1, expected: "in 59m" },
  { remainingMs: 2 * DAY_MS - 1, expected: "in 1d23h" },
  { remainingMs: DAY_MS, expected: "in 1d" },
  { remainingMs: DAY_MS - 1, expected: "in 23h59m" },
  { remainingMs: 30_000, expected: "in 30s" },
  { remainingMs: -1.5 * HOUR_MS, expected: "1h30m ago" },
];

for (const { remainingMs, expected } of cases) {
  test(`relative time for ${remainingMs}ms is ${expected}`, () => {
    const realNow = Date.now;
    const now = 1_700_000_000_000;
    Date.now = () => now;
    try {
      assert.equal(formatRelativeTime(now + remainingMs), expected);
      assert.equal(formatRelativeTime(new Date(now + remainingMs)), expected);
    } finally {
      Date.now = realNow;
    }
  });
}
