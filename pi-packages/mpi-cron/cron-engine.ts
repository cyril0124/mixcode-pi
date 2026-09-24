/**
 * mpi-cron: schedule parsing, evaluation, and display.
 *
 * Pure and environment-free: every entry point takes the current time as an
 * argument instead of reading a clock, so the job store, the scheduler hub, the
 * tool, and the widget all agree on when a job fires. Cron expressions and
 * interval alignment are evaluated in the host's local time; intervals snap to
 * the epoch grid (a fixed multiple of the interval) rather than to the first
 * run, so a job keeps its fire times across restarts and across tabs.
 */

import type { JobSchedule } from "./types.js";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Longest gap any accepted expression can have is a leap-day match (4 years). */
const CRON_HORIZON_MS = 8 * 365 * DAY_MS;

/** Raised when schedule text cannot be interpreted, or is out of range. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

interface CronFieldSpec {
  /** Human name used in error messages, e.g. `minute`. */
  name: string;
  min: number;
  max: number;
  /** Accepted names (month/day fields), resolved case-insensitively. */
  names?: Record<string, number>;
  /** Suffix listing `names` in range-error messages. */
  nameHint?: string;
  /** Canonical form of a value, e.g. day-of-week 7 becomes Sunday. */
  normalize?: (value: number) => number;
}

const MONTH_NAMES: Record<string, number> = {
  JAN: 1,
  FEB: 2,
  MAR: 3,
  APR: 4,
  MAY: 5,
  JUN: 6,
  JUL: 7,
  AUG: 8,
  SEP: 9,
  OCT: 10,
  NOV: 11,
  DEC: 12,
};

const DAY_NAMES: Record<string, number> = {
  SUN: 0,
  MON: 1,
  TUE: 2,
  WED: 3,
  THU: 4,
  FRI: 5,
  SAT: 6,
};

const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const FIELD_SPECS = {
  second: { name: "second", min: 0, max: 59 },
  minute: { name: "minute", min: 0, max: 59 },
  hour: { name: "hour", min: 0, max: 23 },
  dayOfMonth: { name: "day of month", min: 1, max: 31 },
  month: { name: "month", min: 1, max: 12, names: MONTH_NAMES, nameHint: "JAN-DEC" },
  dayOfWeek: {
    name: "day of week",
    min: 0,
    max: 7,
    names: DAY_NAMES,
    nameHint: "SUN-SAT",
    // Cron accepts both 0 and 7 for Sunday.
    normalize: (value: number): number => (value === 7 ? 0 : value),
  },
} satisfies Record<string, CronFieldSpec>;

interface CronField {
  /** Original text, used to detect the `*` (unrestricted) forms. */
  raw: string;
  values: Set<number>;
}

/** Every token is numeric, `*`, or built from numeric/name/range/step syntax. */
const CRON_TOKEN_PATTERN =
  /^(?:\*|[A-Za-z]+|\d+)(?:-(?:[A-Za-z]+|\d+))?(?:\/\d+)?(?:,(?:\*|[A-Za-z]+|\d+)(?:-(?:[A-Za-z]+|\d+))?(?:\/\d+)?)*$/;

interface ParsedCron {
  expr: string;
  /** Present only for 6-field expressions, which fire on second boundaries. */
  seconds: CronField | null;
  minutes: CronField;
  hours: CronField;
  dayOfMonth: CronField;
  month: CronField;
  dayOfWeek: CronField;
}

/** Parse schedule text into the stored schedule shape, or throw `CronParseError`. */
export function parseSchedule(text: string, now: number): JobSchedule {
  const source = text.trim();
  if (source === "") throw new CronParseError("Schedule must not be empty");

  const relative = matchRelative(source);
  if (relative !== null) return { kind: "relative", delayMs: relative, source };

  const interval = matchInterval(source);
  if (interval !== null) return { kind: "interval", intervalMs: interval, source };

  const timestamp = matchIsoTimestamp(source);
  if (timestamp !== null) {
    if (timestamp <= now) throw new CronParseError(`Timestamp "${source}" is not in the future`);
    return { kind: "once", atMs: timestamp, source };
  }

  const cronExpr = normalizeWhitespace(source);
  if (looksLikeCron(cronExpr)) {
    // Structurally cron-shaped: field-level errors (out-of-range values, bad
    // steps) surface as-is instead of the generic unrecognized-schedule text.
    parseCronExpression(cronExpr);
    return { kind: "cron", expr: cronExpr, source };
  }

  throw new CronParseError(
    `Unrecognized schedule "${source}" (use +30s, 5m, every 2h, an ISO timestamp, or a cron expression)`,
  );
}

/** True when `expr` is a 5- or 6-field cron expression with in-range fields. */
export function isValidCronExpression(expr: string): boolean {
  let valid: boolean;
  try {
    valid = parseCronExpression(expr) !== null;
  } catch {
    // Structural rejection is the contract here; the caller only needs the flag.
    valid = false;
  }
  return valid;
}

/** Smallest epoch ms strictly greater than `from` at which `schedule` fires. */
export function nextRun(schedule: JobSchedule, from: number): number {
  switch (schedule.kind) {
    case "cron":
      return nextCronRun(parseCronExpression(schedule.expr), from);
    case "interval": {
      if (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs <= 0) {
        throw new CronParseError("Interval must be one of Ns/Nm/Nh/Nd and greater than zero");
      }
      return Math.floor(from / schedule.intervalMs) * schedule.intervalMs + schedule.intervalMs;
    }
    case "once": {
      if (!Number.isSafeInteger(schedule.atMs)) {
        throw new CronParseError("Scheduled time must be a whole epoch-millisecond timestamp");
      }
      if (schedule.atMs <= from) throw new CronParseError("Scheduled time has already passed");
      return schedule.atMs;
    }
    case "relative": {
      if (!Number.isSafeInteger(schedule.delayMs) || schedule.delayMs <= 0) {
        throw new CronParseError("Relative delay must be greater than zero");
      }
      return from + schedule.delayMs;
    }
  }
}

/** Short human label (<= 32 chars) for a schedule, used by the widget and tool output. */
export function describeSchedule(schedule: JobSchedule): string {
  switch (schedule.kind) {
    case "relative":
      return `in ${formatDuration(schedule.delayMs)}`;
    case "interval":
      return `every ${formatDuration(schedule.intervalMs)}`;
    case "once":
      return `at ${formatLocalStamp(schedule.atMs)}`;
    case "cron":
      return describeCron(schedule.expr, schedule.source);
  }
}

/** Relative countdown label such as `in 3m12s`, or `due` once `targetMs` has passed. */
export function formatUntil(targetMs: number, now: number): string {
  const remaining = targetMs - now;
  if (remaining <= 0) return "due";
  return `in ${formatSpan(remaining)}`;
}

/**
 * Age of a past timestamp, such as `2m ago`; `just now` for the current second.
 * A timestamp in the future (clock skew between tabs) also reads as `just now`.
 */
export function formatSince(targetMs: number, now: number): string {
  const elapsed = now - targetMs;
  if (elapsed < SECOND_MS) return "just now";
  return `${formatSpan(elapsed)} ago`;
}

/** Duration without direction, largest unit first and no more than two units. */
function formatSpan(ms: number): string {
  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)}s`;
  if (ms < HOUR_MS) {
    const minutes = Math.floor(ms / MINUTE_MS);
    const seconds = Math.floor(ms / SECOND_MS) % 60;
    return `${minutes}m${pad2(seconds)}s`;
  }
  if (ms < DAY_MS) {
    const hours = Math.floor(ms / HOUR_MS);
    const minutes = Math.floor(ms / MINUTE_MS) % 60;
    return `${hours}h${pad2(minutes)}m`;
  }
  const days = Math.floor(ms / DAY_MS);
  const hours = Math.floor(ms / HOUR_MS) % 24;
  return `${days}d${hours}h`;
}

/**
 * Run count as a counted noun, such as `0 runs` or `1 run`. A bare `12x` reads
 * as a multiplier rather than a tally.
 */
export function formatRunCount(count: number): string {
  return `${count} run${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------- text forms

function matchRelative(source: string): number | null {
  const match = /^\+(\d+)([smhd])$/i.exec(source);
  if (!match) return null;
  const delayMs = Number(match[1]) * unitToMs(match[2]!);
  if (!Number.isSafeInteger(delayMs) || delayMs <= 0) {
    throw new CronParseError("Relative delay must be greater than zero, e.g. +30s");
  }
  return delayMs;
}

function matchInterval(source: string): number | null {
  const match = /^(?:every\s+)?(\d+)([smhd])$/i.exec(source);
  if (!match) return null;
  const intervalMs = Number(match[1]) * unitToMs(match[2]!);
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    throw new CronParseError("Interval must be one of Ns/Nm/Nh/Nd and greater than zero");
  }
  return intervalMs;
}

const ISO_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?)?([Zz]|[+-]\d{2}:?\d{2})?$/;

/**
 * Resolve an ISO 8601 timestamp to epoch ms, or null when `source` is not one.
 * Zone-less input is read as local time; explicit offsets defer to `Date.parse`.
 */
function matchIsoTimestamp(source: string): number | null {
  if (!/\d/.test(source) || !/[-T:]/.test(source)) return null;

  const match = ISO_PATTERN.exec(source);
  if (match) {
    if (match[8] !== undefined) {
      const offsetMs = Date.parse(source);
      return Number.isFinite(offsetMs) ? offsetMs : null;
    }
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const hour = Number(match[4] ?? 0);
    const minute = Number(match[5] ?? 0);
    const second = Number(match[6] ?? 0);
    const ms = match[7] === undefined ? 0 : Number(match[7].padEnd(3, "0"));
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    if (hour > 23 || minute > 59 || second > 59) return null;
    const local = new Date(year, month - 1, day, hour, minute, second, ms);
    // Reject rollover such as 2026-02-30, which Date would silently accept.
    if (local.getMonth() !== month - 1 || local.getDate() !== day) return null;
    return local.getTime();
  }

  // Other `Date.parse` forms (e.g. "Sep 23 2026 09:00") stay supported.
  const parsed = Date.parse(source);
  return Number.isFinite(parsed) ? parsed : null;
}

// -------------------------------------------------------------- cron parsing

function looksLikeCron(expr: string): boolean {
  const tokens = expr.split(" ");
  if (tokens.length !== 5 && tokens.length !== 6) return false;
  return tokens.every((token) => CRON_TOKEN_PATTERN.test(token));
}

function parseCronExpression(expr: string): ParsedCron {
  const tokens = normalizeWhitespace(expr).split(" ");
  if (tokens.length !== 5 && tokens.length !== 6) {
    throw new CronParseError(
      `Cron expression must have 5 or 6 fields (minute hour day month weekday), got ${tokens.length}`,
    );
  }
  const offset = tokens.length === 6 ? 1 : 0;
  return {
    expr: normalizeWhitespace(expr),
    seconds: offset === 1 ? parseCronField(tokens[0]!, FIELD_SPECS.second) : null,
    minutes: parseCronField(tokens[offset]!, FIELD_SPECS.minute),
    hours: parseCronField(tokens[offset + 1]!, FIELD_SPECS.hour),
    dayOfMonth: parseCronField(tokens[offset + 2]!, FIELD_SPECS.dayOfMonth),
    month: parseCronField(tokens[offset + 3]!, FIELD_SPECS.month),
    dayOfWeek: parseCronField(tokens[offset + 4]!, FIELD_SPECS.dayOfWeek),
  };
}

function parseCronField(raw: string, spec: CronFieldSpec): CronField {
  const values = new Set<number>();
  for (const item of raw.split(",")) {
    const slashParts = item.split("/");
    if (slashParts.length > 2) throw invalidCronField(item, spec);
    const stepText = slashParts[1];
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw invalidCronField(item, spec);
      step = Number(stepText);
    }

    const rangeText = slashParts[0]!;
    let start: number;
    let end: number;
    if (rangeText === "*") {
      start = spec.min;
      end = spec.max;
    } else if (rangeText.includes("-")) {
      const bounds = rangeText.split("-");
      if (bounds.length !== 2) throw invalidCronField(item, spec);
      start = parseCronValue(bounds[0]!, spec);
      end = parseCronValue(bounds[1]!, spec);
    } else {
      start = parseCronValue(rangeText, spec);
      // `N/S` means "from N to the end of the range, every S".
      end = stepText === undefined ? start : spec.max;
    }
    if (start > end) throw invalidCronField(item, spec);
    for (let value = start; value <= end; value += step) {
      values.add(spec.normalize ? spec.normalize(value) : value);
    }
  }
  return { raw, values };
}

function parseCronValue(token: string, spec: CronFieldSpec): number {
  if (spec.names && /^[A-Za-z]+$/.test(token)) {
    const named = spec.names[token.toUpperCase().slice(0, 3)];
    if (named !== undefined) return named;
    throw invalidCronField(token, spec);
  }
  if (!/^\d+$/.test(token)) throw invalidCronField(token, spec);
  const value = Number(token);
  if (value < spec.min || value > spec.max) throw invalidCronField(token, spec);
  return value;
}

function invalidCronField(token: string, spec: CronFieldSpec): CronParseError {
  const names = spec.nameHint === undefined ? "" : ` or ${spec.nameHint}`;
  return new CronParseError(
    `Invalid cron field "${token}" in ${spec.name} position (${spec.min}-${spec.max}${names})`,
  );
}

// --------------------------------------------------------------- cron stepping

function nextCronRun(cron: ParsedCron, from: number): number {
  const stepMs = cron.seconds === null ? MINUTE_MS : SECOND_MS;
  const horizon = from + CRON_HORIZON_MS;
  let candidate = Math.floor(from / stepMs) * stepMs + stepMs;

  while (candidate <= horizon) {
    const date = new Date(candidate);
    let advanced: number;
    if (!cron.month.values.has(date.getMonth() + 1)) {
      advanced = startOfNextMonth(candidate);
    } else if (!dayMatches(cron, date)) {
      advanced = startOfNextDay(candidate);
    } else if (!cron.hours.values.has(date.getHours())) {
      advanced = startOfNextHour(candidate);
    } else if (!cron.minutes.values.has(date.getMinutes())) {
      advanced = startOfNextMinute(candidate);
    } else if (cron.seconds !== null && !cron.seconds.values.has(date.getSeconds())) {
      advanced = candidate + SECOND_MS;
    } else {
      return candidate;
    }
    // A DST gap can push a roll-over onto a nonexistent wall-clock time that the
    // platform resolves backwards; force forward progress so the loop terminates.
    candidate = advanced > candidate ? advanced : candidate + stepMs;
  }
  throw new CronParseError(
    `Cron expression "${cron.expr}" has no matching time in the next 8 years`,
  );
}

/**
 * Day match with the cron convention: when both day fields are restricted, a day
 * matches if either does. A field counts as restricted unless it starts with
 * `*`, which matches Vixie cron's handling of step-only fields.
 */
function dayMatches(cron: ParsedCron, date: Date): boolean {
  const dayOfMonthMatch = cron.dayOfMonth.values.has(date.getDate());
  const dayOfWeekMatch = cron.dayOfWeek.values.has(date.getDay());
  const bothRestricted =
    !cron.dayOfMonth.raw.startsWith("*") && !cron.dayOfWeek.raw.startsWith("*");
  if (bothRestricted) return dayOfMonthMatch || dayOfWeekMatch;
  return dayOfMonthMatch && dayOfWeekMatch;
}

/** Local-time advances keep DST handling to the platform's `Date` setters. */
function startOfNextDay(from: number): number {
  const date = new Date(from);
  date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function startOfNextHour(from: number): number {
  const date = new Date(from);
  date.setMinutes(0, 0, 0);
  date.setHours(date.getHours() + 1);
  return date.getTime();
}

function startOfNextMinute(from: number): number {
  const date = new Date(from);
  date.setSeconds(0, 0);
  date.setMinutes(date.getMinutes() + 1);
  return date.getTime();
}

function startOfNextMonth(from: number): number {
  const date = new Date(from);
  // Move the day first so the month rollover cannot overflow from a long month.
  date.setDate(1);
  date.setHours(0, 0, 0, 0);
  date.setMonth(date.getMonth() + 1);
  return date.getTime();
}

// ----------------------------------------------------------------- formatting

/**
 * Known cron shapes get a compact label; anything else falls back to the
 * source text so an unusual expression stays recognizable.
 */
function describeCron(expr: string, source: string): string {
  const tokens = normalizeWhitespace(expr).split(" ");
  if (tokens.length === 6 && tokens[0] !== "0") {
    const secondsStep = matchStep(tokens[0]);
    if (secondsStep !== null && tokens.slice(1).every((token) => token === "*"))
      return `every ${secondsStep}s`;
  }
  // A seconds field of 0 fires at the same instants as the 5-field form.
  const fields = tokens.length === 6 && tokens[0] === "0" ? tokens.slice(1) : tokens;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
  const minuteStep = matchStep(minute);
  const allStars = hour === "*" && dayOfMonth === "*" && month === "*" && dayOfWeek === "*";
  if (minuteStep !== null && allStars) return `every ${minuteStep}m`;

  const fixedMinute = matchNumber(minute);
  const fixedHour = matchNumber(hour);
  if (fixedMinute !== null && fixedHour !== null) {
    const clock = `${pad2(fixedHour)}:${pad2(fixedMinute)}`;
    if (dayOfMonth === "*" && month === "*" && dayOfWeek === "*") return `1d@${clock}`;
    const day = matchSingleDayName(dayOfWeek);
    if (day !== null && dayOfMonth === "*" && month === "*") return `weekly ${day} ${clock}`;
  }

  return truncate(normalizeWhitespace(source), 32);
}

function matchNumber(token: string | undefined): number | null {
  if (token === undefined || !/^\d+$/.test(token)) return null;
  return Number(token);
}

/** Step value of a `*&#47;N` token, or null when the token is any other shape. */
function matchStep(token: string | undefined): string | null {
  if (token === undefined) return null;
  return /^\*\/(\d+)$/.exec(token)?.[1] ?? null;
}

function matchSingleDayName(token: string | undefined): string | null {
  if (token === undefined || /[*,\-/]/.test(token)) return null;
  const value = /^\d+$/.test(token) ? Number(token) : DAY_NAMES[token.toUpperCase().slice(0, 3)];
  if (value === undefined) return null;
  const normalized = value === 7 ? 0 : value;
  return DAY_LABELS[normalized] ?? null;
}

/** `5m`, `1h30m`, `1d`: the largest unit first, smaller units only when needed. */
function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / SECOND_MS));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0)
    return hours === 0 && minutes === 0 && seconds === 0 ? `${days}d` : `${days}d${hours}h`;
  if (hours > 0) return minutes === 0 && seconds === 0 ? `${hours}h` : `${hours}h${minutes}m`;
  if (minutes > 0) return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
  return `${seconds}s`;
}

function formatLocalStamp(ms: number): string {
  const date = new Date(ms);
  const seconds = date.getSeconds() === 0 ? "" : `:${pad2(date.getSeconds())}`;
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}:${pad2(date.getMinutes())}${seconds}`
  );
}

function unitToMs(unit: string): number {
  switch (unit.toLowerCase()) {
    case "s":
      return SECOND_MS;
    case "m":
      return MINUTE_MS;
    case "h":
      return HOUR_MS;
    case "d":
      return DAY_MS;
    default:
      throw new CronParseError(`Unknown time unit "${unit}" (use s, m, h, or d)`);
  }
}

function normalizeWhitespace(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
