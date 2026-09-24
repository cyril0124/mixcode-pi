/**
 * mpi-cron: job store.
 *
 * Jobs live in `<cwd>/<CONFIG_DIR_NAME>/cron/jobs.json`, so they are shared by
 * every MixCode tab and every `mpi` process running in that working directory
 * and survive session/process restarts. Because that file has several
 * concurrent writers, every mutation is serialized through an exclusive
 * sidecar lock file and committed with an atomic rename.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type { CronJob, CronJobInput, RunStatus } from "./types.js";

export interface CronStoreOptions {
  /** Working directory whose `<cwd>/.pi/cron/jobs.json` holds the jobs. */
  cwd: string;
  /** Override the store path; used by tests. */
  file?: string;
}

/** Directory holding the job file, nested under `CONFIG_DIR_NAME`. */
export const STORE_DIR_NAME = "cron";

export function storePathFor(cwd: string): string {
  return path.join(cwd, CONFIG_DIR_NAME, STORE_DIR_NAME, "jobs.json");
}

/** Store failure: unreadable/invalid file, or a lock that could not be taken. */
export class CronStorageError extends Error {
  override name = "CronStorageError";
}

/**
 * Lock retry budget: 10 attempts with a random 20-60ms backoff, so the total
 * wait before giving up stays under ~2s even in the worst case. Long enough to
 * outlast a normal competing mutation, short enough not to stall a fire path.
 */
const LOCK_ATTEMPTS = 10;
const LOCK_BACKOFF_MIN_MS = 20;
const LOCK_BACKOFF_MAX_MS = 60;

/**
 * A claim is treated as abandoned after this window, measured from the run's
 * start (`lastRun`, stamped at claim time). Deliberate trade-off: a crashed run
 * may re-fire after the window instead of never firing again.
 */
const CLAIM_STALE_MS = 30 * 60 * 1000;

const RUN_STATUSES: readonly RunStatus[] = ["ok", "error", "running"];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(file: string, detail: string): never {
  throw new CronStorageError(`${file}: ${detail}`);
}

function requireNonEmptyString(file: string, where: string, field: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(file, `${where}.${field} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(file: string, where: string, field: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(file, `${where}.${field} must be a finite number`);
  }
  return value;
}

function requireOptionalFiniteNumber(
  file: string,
  where: string,
  field: string,
  value: unknown,
): void {
  if (value !== undefined) requireFiniteNumber(file, where, field, value);
}

function requireOptionalNonEmptyString(
  file: string,
  where: string,
  field: string,
  value: unknown,
): void {
  if (value === undefined) return;
  if (typeof value !== "string") fail(file, `${where}.${field} must be a string`);
}

function validateSchedule(file: string, where: string, value: unknown): void {
  if (!isRecord(value)) fail(file, `${where}.schedule must be an object`);
  const kind = value.kind;
  let expected: string[];
  switch (kind) {
    case "cron":
      expected = ["expr", "source"];
      break;
    case "interval":
      expected = ["intervalMs", "source"];
      break;
    case "once":
      expected = ["atMs", "source"];
      break;
    case "relative":
      expected = ["delayMs", "source"];
      break;
    default:
      fail(
        file,
        `${where}.schedule.kind must be one of cron|interval|once|relative, got ${JSON.stringify(kind)}`,
      );
  }
  for (const field of expected) {
    if (field === "intervalMs" || field === "atMs" || field === "delayMs") {
      requireFiniteNumber(file, `${where}.schedule`, field, value[field]);
    } else {
      requireNonEmptyString(file, `${where}.schedule`, field, value[field]);
    }
  }
}

/**
 * Validates one persisted entry. Invalid entries are rejected, never repaired:
 * a hand-edited or truncated file must surface as a load-time error instead of
 * silently running a job with invented defaults.
 */
function validateJob(file: string, index: number, value: unknown): CronJob {
  const where = `jobs[${index}]`;
  if (!isRecord(value)) fail(file, `${where} must be an object`);

  requireNonEmptyString(file, where, "id", value.id);
  requireNonEmptyString(file, where, "name", value.name);
  requireNonEmptyString(file, where, "prompt", value.prompt);

  validateSchedule(file, where, value.schedule);

  if (typeof value.enabled !== "boolean") {
    fail(file, `${where}.enabled must be a boolean`);
  }

  const runCount = value.runCount;
  if (!Number.isInteger(runCount) || (runCount as number) < 0) {
    fail(file, `${where}.runCount must be a non-negative integer`);
  }

  requireFiniteNumber(file, where, "createdAt", value.createdAt);

  const lastStatus = value.lastStatus;
  if (lastStatus !== undefined && !RUN_STATUSES.includes(lastStatus as RunStatus)) {
    fail(file, `${where}.lastStatus must be one of ${RUN_STATUSES.join("|")}`);
  }

  requireOptionalFiniteNumber(file, where, "lastRun", value.lastRun);
  requireOptionalFiniteNumber(file, where, "nextRun", value.nextRun);
  requireOptionalFiniteNumber(file, where, "expiresAt", value.expiresAt);
  requireOptionalNonEmptyString(file, where, "description", value.description);
  requireOptionalNonEmptyString(file, where, "claim", value.claim);
  requireOptionalNonEmptyString(file, where, "createdBy", value.createdBy);

  return value as unknown as CronJob;
}

/** Parses raw file contents; empty content means "no jobs yet". */
function parseJobsFile(file: string, raw: string): CronJob[] {
  // A zero-byte file is the residue of a crash between file creation and the
  // first write, so it is read as an empty store rather than an error.
  if (raw.trim() === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(file, `malformed JSON (${detail})`);
  }

  if (!Array.isArray(parsed)) fail(file, "root value must be an array of jobs");
  return parsed.map((entry, index) => validateJob(file, index, entry));
}

export class CronStore {
  private readonly file: string;
  private readonly lockFile: string;
  private readonly tmpFile: string;

  constructor(options: CronStoreOptions) {
    this.file = options.file ?? storePathFor(options.cwd);
    this.lockFile = `${this.file}.lock`;
    this.tmpFile = `${this.file}.tmp`;
  }

  /**
   * Reads every job. A missing file is an empty store; anything else that
   * cannot be parsed or validated raises CronStorageError naming the file.
   */
  async list(): Promise<CronJob[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.file, "utf8");
    } catch (error) {
      // Missing store file is the normal first-run state, not a failure.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return parseJobsFile(this.file, raw);
  }

  async get(id: string): Promise<CronJob | undefined> {
    const jobs = await this.list();
    return jobs.find((job) => job.id === id);
  }

  /**
   * Appends a job and returns the stored copy. `name` defaults to the prompt's
   * first line so the widget always has a label; `nextRun` is supplied by the
   * hub (schedule math is not owned here).
   */
  async add(input: CronJobInput, nextRun?: number): Promise<CronJob> {
    const job: CronJob = {
      id: randomUUID(),
      name: input.name?.trim() || firstLine(input.prompt),
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: true,
      runCount: 0,
      createdAt: Date.now(),
    };
    if (input.description !== undefined) job.description = input.description;
    if (input.createdBy !== undefined) job.createdBy = input.createdBy;
    if (input.expiresAt !== undefined) job.expiresAt = input.expiresAt;
    if (nextRun !== undefined) job.nextRun = nextRun;

    await this.mutate((jobs) => {
      jobs.push(job);
      return [...jobs];
    });
    return job;
  }

  /**
   * Patches a job. `nextRun: null` clears the field, while omitting it keeps
   * the stored value; unknown ids are an error so callers cannot silently patch
   * a job that a concurrent prune already removed.
   */
  async update(
    id: string,
    patch: Partial<Omit<CronJob, "nextRun">> & { nextRun?: number | null },
  ): Promise<CronJob> {
    let updated: CronJob | undefined;
    await this.mutate((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) throw new CronStorageError(`${this.file}: unknown job id ${id}`);

      const current = jobs[index] as CronJob;
      const merged: CronJob = { ...current, ...patch } as CronJob;
      if (patch.nextRun === null) delete merged.nextRun;

      updated = merged;
      const next = [...jobs];
      next[index] = merged;
      return next;
    });
    return updated as CronJob;
  }

  async remove(id: string): Promise<boolean> {
    let removed = false;
    await this.mutate((jobs) => {
      removed = jobs.some((job) => job.id === id);
      return jobs.filter((job) => job.id !== id);
    });
    return removed;
  }

  /**
   * Claims a run and returns the claimed job; `undefined` means another tab or
   * process already owns this run, the job is gone or disabled, or the tick is
   * no longer the planned one. A lost claim is the normal outcome of racing
   * peers, so nothing here throws.
   *
   * `plannedFor` is the tick the caller woke up for. A timer run passes it so a
   * plan that went stale while a peer ran the same tick is rejected: the stored
   * `nextRun` has already moved on, and running the old tick again would deliver
   * the prompt a second time. A job with no stored `nextRun` has no plan to
   * compare against and is allowed through.
   *
   * Staleness rule: a claim is considered abandoned once the run's start
   * (`lastRun`, stamped here) is absent or older than 30 minutes, which makes a
   * crashed run recoverable instead of blocking the job forever. Claiming
   * always writes `lastRun = now`, so the window is measured from the start of
   * the current attempt rather than from the previous one.
   */
  async claim(id: string, token: string, plannedFor?: number): Promise<CronJob | undefined> {
    let claimed: CronJob | undefined;
    await this.mutate((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) return jobs;

      const current = jobs[index] as CronJob;
      if (!current.enabled) return jobs;
      if (current.claim !== undefined && !isStaleClaim(current)) return jobs;
      if (
        plannedFor !== undefined &&
        current.nextRun !== undefined &&
        current.nextRun !== plannedFor
      )
        return jobs;

      const next = [...jobs];
      next[index] = { ...current, claim: token, lastRun: Date.now(), lastStatus: "running" };
      claimed = next[index];
      return next;
    });
    return claimed;
  }

  /**
   * Clears the claim and records the outcome. Idempotent for a stale caller: a
   * mismatched token means the run was already reclaimed by someone else, so
   * the late writer must not clobber the newer claim or its counters.
   */
  async release(
    id: string,
    token: string,
    result: {
      status: RunStatus;
      runCount: number;
      lastRun: number;
      nextRun?: number | null;
      enabled?: boolean;
    },
  ): Promise<void> {
    await this.mutate((jobs) => {
      const index = jobs.findIndex((job) => job.id === id);
      if (index < 0) return jobs;

      const current = jobs[index] as CronJob;
      if (current.claim !== token) return jobs;

      const merged: CronJob = {
        ...current,
        runCount: result.runCount,
        lastRun: result.lastRun,
        lastStatus: result.status,
      };
      delete merged.claim;
      if (result.enabled !== undefined) merged.enabled = result.enabled;
      if (result.nextRun === null) delete merged.nextRun;
      else if (result.nextRun !== undefined) merged.nextRun = result.nextRun;

      const next = [...jobs];
      next[index] = merged;
      return next;
    });
  }

  /**
   * Drops jobs that can never fire again: disabled jobs, and `once` jobs whose
   * time has passed. Returns the removed ids so callers can report them.
   */
  async pruneFinished(now: number): Promise<string[]> {
    const removed: string[] = [];
    await this.mutate((jobs) => {
      const keep = jobs.filter((job) => {
        const finished = !job.enabled || isSpentOnceJob(job, now);
        if (finished) removed.push(job.id);
        return !finished;
      });
      return keep;
    });
    return removed;
  }

  /**
   * Runs `change` under the sidecar lock, then writes the returned array
   * atomically. Read-modify-write stays inside one lock hold, so concurrent
   * processes cannot interleave and drop each other's edits. The lock is always
   * released, including when `change` throws.
   */
  private async mutate(change: (jobs: CronJob[]) => CronJob[]): Promise<void> {
    await this.acquireLock();
    try {
      const current = await this.list();
      await this.write(change(current));
    } finally {
      await this.releaseLock();
    }
  }

  private async write(jobs: CronJob[]): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    await fs.writeFile(this.tmpFile, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    // rename is atomic on one filesystem: readers see either the old or the new
    // file, never a half-written one.
    await fs.rename(this.tmpFile, this.file);
  }

  /**
   * Takes the exclusive lock by creating the sidecar with O_EXCL, retrying with
   * jittered backoff for up to ~2s. Failing to acquire raises: proceeding
   * unlocked would let two processes rewrite the same jobs array and drop a
   * mutation.
   */
  private async acquireLock(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt += 1) {
      try {
        const handle = await fs.open(this.lockFile, "wx");
        await handle.close();
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (attempt === LOCK_ATTEMPTS - 1) break;
        const backoff =
          LOCK_BACKOFF_MIN_MS + Math.random() * (LOCK_BACKOFF_MAX_MS - LOCK_BACKOFF_MIN_MS);
        await delay(backoff);
      }
    }
    throw new CronStorageError(
      `${this.file}: store is busy, could not acquire lock ${this.lockFile} after ${LOCK_ATTEMPTS} attempts`,
    );
  }

  private async releaseLock(): Promise<void> {
    try {
      await fs.unlink(this.lockFile);
    } catch (error) {
      // ENOENT: the lock was already removed (e.g. by the holder's own crash
      // recovery). Cleanup must never mask the mutation's real outcome.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function isStaleClaim(job: CronJob): boolean {
  if (job.lastRun === undefined) return true;
  return Date.now() - job.lastRun > CLAIM_STALE_MS;
}

function isSpentOnceJob(job: CronJob, now: number): boolean {
  return job.schedule.kind === "once" && job.schedule.atMs <= now;
}

function firstLine(prompt: string): string {
  const line = prompt.split("\n")[0]?.trim() ?? "";
  return (line === "" ? prompt.trim() : line).slice(0, 60);
}
