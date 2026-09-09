import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRelativeTime, parseArgs } from "./loop-helpers.js";

const parseCases = [
  {
    input: "2h --max-runs 3 first\nsecond",
    intervalMs: 7_200_000,
    maxFireCount: 3,
    prompt: "first\nsecond",
  },
  { input: "--max-runs 3 check", intervalMs: 600_000, maxFireCount: 3, prompt: "check" },
  {
    input: "--max-runs 3 check every 20m",
    intervalMs: 1_200_000,
    maxFireCount: 3,
    prompt: "check",
  },
  {
    input: "2h check every 20m",
    intervalMs: 7_200_000,
    maxFireCount: null,
    prompt: "check every 20m",
  },
  {
    input: "check\nsecond every 2 hours",
    intervalMs: 7_200_000,
    maxFireCount: null,
    prompt: "check\nsecond",
  },
  {
    input: "check --max-runs 3",
    intervalMs: 600_000,
    maxFireCount: null,
    prompt: "check --max-runs 3",
  },
  {
    input: "2h -- --max-runs 3",
    intervalMs: 7_200_000,
    maxFireCount: null,
    prompt: "--max-runs 3",
  },
  {
    input: "--max-runs 3 -- check every 2h",
    intervalMs: 600_000,
    maxFireCount: 3,
    prompt: "check every 2h",
  },
  {
    input: "-- 2h --max-runs 3",
    intervalMs: 600_000,
    maxFireCount: null,
    prompt: "2h --max-runs 3",
  },
];

for (const { input, intervalMs, maxFireCount, prompt } of parseCases) {
  test(`parse loop arguments: ${JSON.stringify(input)}`, () => {
    const parsed = parseArgs(input);
    assert.ok(parsed);
    assert.equal(parsed.intervalMs, intervalMs);
    assert.equal(parsed.maxFireCount, maxFireCount);
    assert.equal(parsed.prompt, prompt);
  });
}

for (const input of [
  "--max-runs",
  "--max-runs 0 check",
  "--max-runs -1 check",
  "--max-runs 1.5 check",
  "--max-runs 1e2 check",
  "--max-runs 9007199254740992 check",
  "--max-runs unlimited check",
  "--max-runs 3 --max-runs 4 check",
]) {
  test(`reject invalid creation options: ${input}`, () => {
    assert.throws(() => parseArgs(input), { message: /^Error:/ });
  });
}

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
