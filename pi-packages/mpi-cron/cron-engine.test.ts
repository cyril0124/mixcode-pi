import { describe, expect, test } from "bun:test";
import {
  CronParseError,
  describeSchedule,
  formatUntil,
  isValidCronExpression,
  nextRun,
  parseSchedule,
} from "./cron-engine.js";
import type { JobSchedule } from "./types.js";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Local-time constructor: expectations must hold in any timezone. */
function local(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

const NOW = local(2026, 9, 23, 12, 0, 0);

describe("parseSchedule", () => {
  test("tags relative delays", () => {
    expect(parseSchedule("+30s", NOW)).toEqual({
      kind: "relative",
      delayMs: 30_000,
      source: "+30s",
    });
    expect(parseSchedule("+5m", NOW)).toEqual({
      kind: "relative",
      delayMs: 5 * MINUTE_MS,
      source: "+5m",
    });
    expect(parseSchedule("  +2h  ", NOW)).toEqual({
      kind: "relative",
      delayMs: 2 * HOUR_MS,
      source: "+2h",
    });
    expect(parseSchedule("+1d", NOW)).toEqual({ kind: "relative", delayMs: DAY_MS, source: "+1d" });
  });

  test("tags intervals, with and without the `every` prefix", () => {
    expect(parseSchedule("5m", NOW)).toEqual({
      kind: "interval",
      intervalMs: 5 * MINUTE_MS,
      source: "5m",
    });
    expect(parseSchedule("30s", NOW)).toEqual({
      kind: "interval",
      intervalMs: 30_000,
      source: "30s",
    });
    expect(parseSchedule("every 2h", NOW)).toEqual({
      kind: "interval",
      intervalMs: 2 * HOUR_MS,
      source: "every 2h",
    });
    expect(parseSchedule("EVERY   30s", NOW)).toEqual({
      kind: "interval",
      intervalMs: 30_000,
      source: "EVERY   30s",
    });
    expect(parseSchedule("every 1d", NOW)).toEqual({
      kind: "interval",
      intervalMs: DAY_MS,
      source: "every 1d",
    });
    // An interval must not be mistaken for a cron expression.
    expect(parseSchedule("5m", NOW).kind).toBe("interval");
  });

  test("tags 5-field and 6-field cron expressions", () => {
    expect(parseSchedule("*/5 * * * *", NOW)).toEqual({
      kind: "cron",
      expr: "*/5 * * * *",
      source: "*/5 * * * *",
    });
    expect(parseSchedule("0 */5 * * * *", NOW)).toEqual({
      kind: "cron",
      expr: "0 */5 * * * *",
      source: "0 */5 * * * *",
    });
    expect(parseSchedule("  0   9  *  *  *  ", NOW)).toEqual({
      kind: "cron",
      expr: "0 9 * * *",
      source: "0   9  *  *  *",
    });
  });

  test("tags ISO timestamps in the future", () => {
    const localStamp = parseSchedule("2026-09-24 09:00", NOW);
    expect(localStamp).toEqual({
      kind: "once",
      atMs: local(2026, 9, 24, 9, 0),
      source: "2026-09-24 09:00",
    });

    const utcStamp = parseSchedule("2026-09-24T09:00:00Z", NOW);
    expect(utcStamp.kind).toBe("once");
    expect((utcStamp as { atMs: number }).atMs).toBe(Date.parse("2026-09-24T09:00:00Z"));

    // Zone-less input is local time, so the offset-free and Z forms stay distinct
    // in every timezone except UTC itself.
    expect(parseSchedule("2026-09-25T09:00", NOW)).toMatchObject({
      atMs: local(2026, 9, 25, 9, 0),
    });
  });

  test("rejects unparseable and invalid input", () => {
    const bad = [
      "",
      "   ",
      "every",
      "0s",
      "5x",
      "+5",
      "+0s",
      "* * * *",
      "70 * * * *",
      "0 0 32 * *",
      "0 0 * 13 *",
      "0 25 * * *",
      "*/0 * * * *",
      "5-1 * * * *",
      "2020-01-01T00:00:00Z",
      "2026-13-01T00:00:00Z",
      "not a schedule",
    ];
    for (const text of bad) {
      expect(() => parseSchedule(text, NOW)).toThrow(CronParseError);
    }
    expect(() => parseSchedule("70 * * * *", NOW)).toThrow(
      /Invalid cron field "70" in minute position/,
    );
  });

  test("error messages carry no `Error:` prefix and an empty source is named", () => {
    for (const text of ["70 * * * *", "", "5x"]) {
      try {
        parseSchedule(text, NOW);
        throw new Error(`expected rejection for ${JSON.stringify(text)}`);
      } catch (error) {
        expect(error).toBeInstanceOf(CronParseError);
        expect((error as Error).message.startsWith("Error:")).toBe(false);
      }
    }
  });
});

describe("isValidCronExpression", () => {
  test("accepts valid and rejects invalid expressions", () => {
    for (const expr of [
      "* * * * *",
      "*/5 * * * *",
      "0 */5 * * * *",
      "0 9-17 * * MON-FRI",
      "1,15,30 0 1 JAN *",
    ]) {
      expect(isValidCronExpression(expr)).toBe(true);
    }
    for (const expr of ["", "* * * *", "* * * * * * *", "70 * * * *", "mon * * * *", "a b c d e"]) {
      expect(isValidCronExpression(expr)).toBe(false);
    }
  });
});

describe("nextRun / interval", () => {
  const hourly: JobSchedule = { kind: "interval", intervalMs: HOUR_MS, source: "1h" };

  test("lands on the next epoch-grid boundary from mid-hour", () => {
    // 12:34:56 local is still inside the 12:00 epoch grid slot in UTC-anchored
    // terms only if offsets align, so derive the expectation from the grid rule.
    const from = local(2026, 9, 23, 12, 34, 56);
    const expected = Math.floor(from / HOUR_MS) * HOUR_MS + HOUR_MS;
    expect(nextRun(hourly, from)).toBe(expected);
    expect(nextRun(hourly, from) % HOUR_MS).toBe(0);
  });

  test("is stable across restarts and advances only past the boundary", () => {
    const from = local(2026, 9, 23, 12, 34, 56);
    const fire = nextRun(hourly, from);
    // Repeated evaluations before the boundary do not drift (restart safety).
    expect(nextRun(hourly, from)).toBe(fire);
    expect(nextRun(hourly, from - 1)).toBe(fire);
    // Exactly on the boundary the schedule is still strictly-greater.
    expect(nextRun(hourly, fire)).toBe(fire + HOUR_MS);
    expect(nextRun(hourly, fire + 1)).toBe(fire + HOUR_MS);
  });

  test("rejects a non-positive or non-integer interval", () => {
    const bad: JobSchedule[] = [
      { kind: "interval", intervalMs: 0, source: "0s" },
      { kind: "interval", intervalMs: -1_000, source: "-1s" },
      { kind: "interval", intervalMs: 1.5, source: "1.5s" },
      { kind: "interval", intervalMs: Number.NaN, source: "NaN" },
      { kind: "interval", intervalMs: Number.POSITIVE_INFINITY, source: "inf" },
    ];
    for (const schedule of bad) expect(() => nextRun(schedule, NOW)).toThrow(CronParseError);
  });
});

describe("nextRun / once and relative", () => {
  test("returns the absolute timestamp, and refuses finished jobs", () => {
    const schedule: JobSchedule = { kind: "once", atMs: NOW + 60_000, source: "2026-09-23 12:01" };
    expect(nextRun(schedule, NOW)).toBe(NOW + 60_000);
    expect(() => nextRun(schedule, NOW + 60_000)).toThrow(CronParseError);
    expect(() => nextRun(schedule, NOW + 120_000)).toThrow(CronParseError);
  });

  test("adds the delay to `from` and refuses a non-positive delay", () => {
    expect(nextRun({ kind: "relative", delayMs: 30_000, source: "+30s" }, NOW)).toBe(NOW + 30_000);
    expect(nextRun({ kind: "relative", delayMs: 30_000, source: "+30s" }, NOW + 5_000)).toBe(
      NOW + 35_000,
    );
    expect(() => nextRun({ kind: "relative", delayMs: 0, source: "+0s" }, NOW)).toThrow(
      CronParseError,
    );
  });
});

describe("nextRun / cron", () => {
  const cron = (expr: string): JobSchedule => ({ kind: "cron", expr, source: expr });

  test("daily 09:00 uses the same local day when the hour is still ahead", () => {
    expect(nextRun(cron("0 9 * * *"), local(2026, 9, 23, 8, 59, 0))).toBe(local(2026, 9, 23, 9, 0));
    expect(nextRun(cron("0 9 * * *"), local(2026, 9, 23, 9, 0, 0))).toBe(local(2026, 9, 24, 9, 0));
    expect(nextRun(cron("0 9 * * *"), local(2026, 9, 23, 9, 0, 1))).toBe(local(2026, 9, 24, 9, 0));
    expect(nextRun(cron("0 9 * * *"), local(2026, 9, 23, 23, 30, 0))).toBe(
      local(2026, 9, 24, 9, 0),
    );
  });

  test("steps by 15 minutes and by 10 seconds", () => {
    expect(nextRun(cron("*/15 * * * *"), local(2026, 9, 23, 12, 1, 0))).toBe(
      local(2026, 9, 23, 12, 15),
    );
    expect(nextRun(cron("*/15 * * * *"), local(2026, 9, 23, 12, 15, 0))).toBe(
      local(2026, 9, 23, 12, 30),
    );
    expect(nextRun(cron("*/15 * * * *"), local(2026, 9, 23, 12, 59, 59))).toBe(
      local(2026, 9, 23, 13, 0),
    );

    // A 5-field expression fires on second 0 only.
    expect(nextRun(cron("* * * * *"), local(2026, 9, 23, 12, 0, 30))).toBe(
      local(2026, 9, 23, 12, 1, 0),
    );

    const every10s = local(2026, 9, 23, 12, 0, 3);
    expect(nextRun(cron("*/10 * * * * *"), every10s)).toBe(local(2026, 9, 23, 12, 0, 10));
    expect(nextRun(cron("*/10 * * * * *"), local(2026, 9, 23, 12, 0, 10))).toBe(
      local(2026, 9, 23, 12, 0, 20),
    );
    expect(nextRun(cron("*/10 * * * * *"), local(2026, 9, 23, 12, 0, 59))).toBe(
      local(2026, 9, 23, 12, 1, 0),
    );
  });

  test("crosses month and year boundaries", () => {
    expect(nextRun(cron("0 0 1 * *"), local(2026, 9, 30, 23, 59, 0))).toBe(
      local(2026, 10, 1, 0, 0),
    );
    expect(nextRun(cron("0 0 1 * *"), local(2026, 12, 31, 23, 59, 0))).toBe(
      local(2027, 1, 1, 0, 0),
    );
    expect(nextRun(cron("0 0 1 1 *"), local(2026, 9, 23, 12, 0, 0))).toBe(local(2027, 1, 1, 0, 0));
    expect(nextRun(cron("0 0 1 1 *"), local(2026, 1, 1, 0, 0, 0))).toBe(local(2027, 1, 1, 0, 0));
  });

  test("finds leap days with correct year math", () => {
    // 2027 and 2029 are not leap years, so the next Feb 29 is 2028.
    expect(nextRun(cron("0 0 29 2 *"), local(2027, 3, 1, 0, 0, 0))).toBe(local(2028, 2, 29, 0, 0));
    expect(nextRun(cron("0 0 29 2 *"), local(2028, 2, 29, 0, 0, 0))).toBe(local(2032, 2, 29, 0, 0));
    // A century non-leap year is skipped: 2100 is not a leap year.
    expect(nextRun(cron("0 0 29 2 *"), local(2096, 3, 1, 0, 0, 0))).toBe(local(2104, 2, 29, 0, 0));
  });

  test("ORs restricted day-of-month and day-of-week", () => {
    const schedule = cron("0 0 13 * 5");
    // Sept 2026: the 13th is a Sunday, and the first Friday after Sept 1 is the 4th.
    const from = local(2026, 9, 1, 0, 0, 0);
    expect(nextRun(schedule, from)).toBe(local(2026, 9, 4, 0, 0));
    expect(nextRun(schedule, local(2026, 9, 4, 0, 0, 0))).toBe(local(2026, 9, 11, 0, 0));
    expect(nextRun(schedule, local(2026, 9, 11, 0, 0, 0))).toBe(local(2026, 9, 13, 0, 0));
    // Both fields restricted and both matched on the same day.
    expect(nextRun(schedule, local(2026, 9, 13, 0, 0, 0))).toBe(local(2026, 9, 18, 0, 0));
    // With only one restricted, the day must match that field exactly.
    expect(nextRun(cron("0 0 * * 5"), local(2026, 9, 1, 0, 0, 0))).toBe(local(2026, 9, 4, 0, 0));
    expect(nextRun(cron("0 0 13 * *"), local(2026, 9, 1, 0, 0, 0))).toBe(local(2026, 9, 13, 0, 0));
  });

  test("honours comma lists, ranges, steps, and names", () => {
    const atNineOrSeventeen = cron("0 9,17 * * *");
    expect(nextRun(atNineOrSeventeen, local(2026, 9, 23, 10, 0, 0))).toBe(
      local(2026, 9, 23, 17, 0),
    );
    expect(nextRun(atNineOrSeventeen, local(2026, 9, 23, 17, 0, 0))).toBe(local(2026, 9, 24, 9, 0));

    const businessHours = cron("0 9-17 * * MON-FRI");
    expect(nextRun(businessHours, local(2026, 9, 23, 12, 0, 0))).toBe(local(2026, 9, 23, 13, 0));
    // Sept 25 2026 is a Friday; the next weekday slot is Monday the 28th at 09:00.
    expect(nextRun(businessHours, local(2026, 9, 25, 17, 0, 0))).toBe(local(2026, 9, 28, 9, 0));
    // Saturday rolls straight to Monday.
    expect(nextRun(businessHours, local(2026, 9, 26, 9, 0, 0))).toBe(local(2026, 9, 28, 9, 0));

    const stepped = cron("*/20 9-10 * * *");
    expect(nextRun(stepped, local(2026, 9, 23, 9, 0, 0))).toBe(local(2026, 9, 23, 9, 20));
    expect(nextRun(stepped, local(2026, 9, 23, 9, 59, 0))).toBe(local(2026, 9, 23, 10, 0));
    expect(nextRun(stepped, local(2026, 9, 23, 10, 40, 0))).toBe(local(2026, 9, 24, 9, 0));

    expect(nextRun(cron("0 0 1 JAN,DEC *"), local(2026, 9, 23, 0, 0))).toBe(
      local(2026, 12, 1, 0, 0),
    );
    expect(nextRun(cron("30 8 * * sun"), local(2026, 9, 23, 0, 0))).toBe(local(2026, 9, 27, 8, 30));
    // 7 means Sunday, and names accept longer spellings.
    expect(nextRun(cron("30 8 * * 7"), local(2026, 9, 23, 0, 0))).toBe(local(2026, 9, 27, 8, 30));
    expect(nextRun(cron("30 8 * * SUNDAY"), local(2026, 9, 23, 0, 0))).toBe(
      local(2026, 9, 27, 8, 30),
    );
  });

  test("rejects impossible expressions at evaluation time too", () => {
    expect(() => nextRun(cron("0 0 31 2 *"), NOW)).toThrow(CronParseError);
  });
});

describe("describeSchedule", () => {
  test("short sources pass through and stay within the cap", () => {
    const cases: Array<[JobSchedule, string]> = [
      [{ kind: "relative", delayMs: 30_000, source: "+30s" }, "in 30s"],
      [{ kind: "interval", intervalMs: 5 * MINUTE_MS, source: "every 5m" }, "every 5m"],
      [{ kind: "interval", intervalMs: 2 * HOUR_MS, source: "2h" }, "every 2h"],
      [{ kind: "interval", intervalMs: 90 * MINUTE_MS, source: "90m" }, "every 1h30m"],
      [{ kind: "interval", intervalMs: DAY_MS, source: "+1d" }, "every 1d"],
      [{ kind: "relative", delayMs: 5 * MINUTE_MS, source: "+5m" }, "in 5m"],
    ];
    for (const [schedule, expected] of cases) {
      expect(describeSchedule(schedule)).toBe(expected);
    }
  });

  test("derives compact labels for cron expressions", () => {
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *", source: "0 9 * * *" })).toBe(
      "1d@09:00",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * *", source: "daily standup" })).toBe(
      "1d@09:00",
    );
    expect(describeSchedule({ kind: "cron", expr: "*/5 * * * *", source: "*/5 * * * *" })).toBe(
      "every 5m",
    );
    expect(
      describeSchedule({ kind: "cron", expr: "*/10 * * * * *", source: "*/10 * * * * *" }),
    ).toBe("every 10s");
    // Hour steps are not one of the compact shapes, so the source is echoed.
    expect(describeSchedule({ kind: "cron", expr: "0 0 */5 * * *", source: "0 0 */5 * * *" })).toBe(
      "0 0 */5 * * *",
    );
    expect(describeSchedule({ kind: "cron", expr: "0 9 * * MON", source: "0 9 * * MON" })).toBe(
      "weekly Mon 09:00",
    );
    expect(describeSchedule({ kind: "cron", expr: "30 17 * * 5", source: "30 17 * * 5" })).toBe(
      "weekly Fri 17:30",
    );
  });

  test("falls back to truncated text and never exceeds 32 characters", () => {
    const schedule: JobSchedule = {
      kind: "cron",
      expr: "0 9-17 * * MON-FRI",
      source: "0 9-17 * * MON-FRI",
    };
    const label = describeSchedule(schedule);
    expect(label.length).toBeLessThanOrEqual(32);
    const stamp = describeSchedule({ kind: "once", atMs: local(2026, 9, 23, 9, 0), source: "x" });
    expect(stamp).toBe("at 2026-09-23 09:00");
    const longOnce = describeSchedule({
      kind: "once",
      atMs: local(2026, 9, 23, 9, 0, 30),
      source: "x",
    });
    expect(longOnce).toBe("at 2026-09-23 09:00:30");
    expect(longOnce.length).toBeLessThanOrEqual(32);
    const longSource = describeSchedule({
      kind: "cron",
      expr: "0 0 1 1 *",
      source: "every new year on the first of january",
    });
    expect(longSource.length).toBeLessThanOrEqual(32);
    expect(longSource.endsWith("...")).toBe(true);
  });
});

describe("formatUntil", () => {
  test("formats each magnitude, including the sub-minute and due cases", () => {
    const cases: Array<[number, string]> = [
      [0, "due"],
      [-1, "due"],
      [-90_000, "due"],
      [42_000, "in 42s"],
      [3 * MINUTE_MS + 12 * SECOND_MS, "in 3m12s"],
      [MINUTE_MS, "in 1m00s"],
      [14 * HOUR_MS + 3 * MINUTE_MS, "in 14h03m"],
      [HOUR_MS, "in 1h00m"],
      [2 * DAY_MS + 4 * HOUR_MS, "in 2d4h"],
      [DAY_MS, "in 1d0h"],
    ];
    for (const [remaining, expected] of cases) {
      expect(formatUntil(NOW + remaining, NOW)).toBe(expected);
    }
  });
});
