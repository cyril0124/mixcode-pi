import { afterEach, beforeEach, expect, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CronStorageError, CronStore, STORE_DIR_NAME, storePathFor } from "./storage.js";
import type { CronJob } from "./types.js";

let cwd: string;
let file: string;

beforeEach(async () => {
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-cron-store-"));
  file = storePathFor(cwd);
});

afterEach(async () => {
  await fs.rm(cwd, { recursive: true, force: true });
});

function newStore(): CronStore {
  return new CronStore({ cwd });
}

async function writeRaw(contents: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, "utf8");
}

function job(overrides: Partial<CronJob> = {}): CronJob {
  return {
    id: "j",
    name: "job",
    prompt: "do the thing",
    schedule: { kind: "interval", intervalMs: 60_000, source: "1m" },
    enabled: true,
    runCount: 0,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

async function writeJobs(jobs: CronJob[]): Promise<void> {
  await writeRaw(`${JSON.stringify(jobs, null, 2)}\n`);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Awaits a rejection and returns the thrown error for message assertions. */
async function caughtError(run: Promise<unknown>): Promise<Error> {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("expected the call to reject");
}

test("add then list round-trips a job and fills defaults", async () => {
  const store = newStore();
  const before = Date.now();
  const added = await store.add({
    name: "nightly check",
    prompt: "review the failing tests",
    schedule: { kind: "cron", expr: "0 3 * * *", source: "0 3 * * *" },
  });

  expect(added.id).toBeString();
  expect(added.id.length).toBeGreaterThan(0);
  expect(added.name).toBe("nightly check");
  expect(added.enabled).toBe(true);
  expect(added.runCount).toBe(0);
  expect(added.createdAt).toBeGreaterThanOrEqual(before);
  expect(added.createdAt).toBeLessThanOrEqual(Date.now());

  const jobs = await store.list();
  expect(jobs).toHaveLength(1);
  expect(jobs[0]?.id).toBe(added.id);

  assert.equal(file, path.join(cwd, ".pi", STORE_DIR_NAME, "jobs.json"));
  expect(await exists(file)).toBe(true);
});

test("add derives a name from the prompt's first line when absent", async () => {
  const store = newStore();
  const added = await store.add({
    prompt: "check the deploy\nand report",
    schedule: { kind: "interval", intervalMs: 3_600_000, source: "1h" },
  });

  expect(added.name).toBe("check the deploy");
});

test("list treats missing and zero-byte files as empty, and rejects malformed JSON", async () => {
  const store = newStore();
  expect(await store.list()).toEqual([]);

  await writeRaw("");
  expect(await store.list()).toEqual([]);

  await writeRaw("{");
  await expect(store.list()).rejects.toThrow(CronStorageError);
});

test("schema violations are rejected with the file name in the message", async () => {
  const store = newStore();

  await writeRaw('[{"id":1}]');
  const badId = await caughtError(store.list());
  expect(badId).toBeInstanceOf(CronStorageError);
  expect(badId.message).toContain(file);
  expect(badId.message).toContain("jobs[0]");

  await writeJobs([job({ schedule: { kind: "weekly" } as never })]);
  const badKind = await caughtError(store.list());
  expect(badKind).toBeInstanceOf(CronStorageError);
  expect(badKind.message).toContain(file);
  expect(badKind.message).toContain("schedule.kind");

  await writeJobs([job({ runCount: -1 })]);
  await expect(store.list()).rejects.toThrow(/runCount/);
});

test("update patches fields, clears nextRun with null, and rejects unknown ids", async () => {
  const store = newStore();
  const added = await store.add(
    { prompt: "ping", schedule: { kind: "interval", intervalMs: 1_000, source: "1s" } },
    5_000,
  );
  expect(added.nextRun).toBe(5_000);

  const patched = await store.update(added.id, { name: "renamed", nextRun: null });
  expect(patched.name).toBe("renamed");
  expect(patched.nextRun).toBeUndefined();

  const stored = await store.get(added.id);
  expect(stored?.name).toBe("renamed");
  expect(stored?.nextRun).toBeUndefined();
  expect(stored?.prompt).toBe("ping");

  await expect(store.update("missing", { name: "x" })).rejects.toThrow(CronStorageError);
});

test("claim is exclusive across concurrent stores", async () => {
  const first = newStore();
  const second = newStore();
  const added = await first.add({
    prompt: "fire once",
    schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
  });

  const results = await Promise.all([first.claim(added.id, "t1"), second.claim(added.id, "t1")]);
  const winners = results.filter((result) => result !== undefined);
  expect(winners).toHaveLength(1);
  expect(winners[0]?.id).toBe(added.id);

  const laterClaim = await second.claim(added.id, "t2");
  expect(laterClaim).toBeUndefined();

  const seenByOther = await second.get(added.id);
  expect(seenByOther?.claim).toBe("t1");
});

test("claim returns undefined for disabled, unknown, and already-claimed jobs", async () => {
  const store = newStore();
  await writeJobs([
    job({ id: "off", enabled: false }),
    job({ id: "busy", claim: "other", lastRun: Date.now() }),
  ]);

  expect(await store.claim("off", "t1")).toBeUndefined();
  expect(await store.claim("absent", "t1")).toBeUndefined();
  expect(await store.claim("busy", "t1")).toBeUndefined();
});

test("claim refuses a tick the stored plan has moved past", async () => {
  const store = newStore();
  const added = await store.add({
    prompt: "tick check",
    schedule: { kind: "interval", intervalMs: 20_000, source: "20s" },
  });
  await store.update(added.id, { nextRun: 1_000_000 });

  expect(await store.claim(added.id, "tick", 1_000_000)).toBeDefined();
  await store.release(added.id, "tick", {
    status: "ok",
    runCount: 1,
    lastRun: 1_000_000,
    nextRun: 1_020_000,
  });

  expect(await store.claim(added.id, "tick", 1_000_000)).toBeUndefined();
  expect(await store.claim(added.id, "next", 1_020_000)).toBeDefined();
});

test("release clears the claim, records the outcome, and frees the job", async () => {
  const store = newStore();
  const added = await store.add({
    prompt: "run it",
    schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
  });

  expect(await store.claim(added.id, "t1")).toBeDefined();
  await store.release(added.id, "t1", {
    status: "ok",
    runCount: 1,
    lastRun: 1_700_000_500_000,
    nextRun: 1_700_000_600_000,
  });

  const released = await store.get(added.id);
  expect(released?.claim).toBeUndefined();
  expect(released?.runCount).toBe(1);
  expect(released?.lastStatus).toBe("ok");
  expect(released?.lastRun).toBe(1_700_000_500_000);
  expect(released?.nextRun).toBe(1_700_000_600_000);

  expect(await store.claim(added.id, "t2")).toBeDefined();
});

test("a claim in flight blocks other tokens, and a superseded release is ignored", async () => {
  const store = newStore();
  const now = Date.now();

  // Fresh claim: a second token must lose while the run is in flight.
  await writeJobs([job({ id: "busy", claim: "t1", lastRun: now })]);
  expect(await store.claim("busy", "t2")).toBeUndefined();

  // Reclaimed after the window: the original token finishing late must not
  // overwrite the newer claim or its counters.
  await writeJobs([job({ id: "slow", claim: "old", lastRun: now - 31 * 60 * 1000 })]);
  const reclaimed = await store.claim("slow", "t2");
  expect(reclaimed?.claim).toBe("t2");

  await store.release("slow", "old", { status: "error", runCount: 9, lastRun: 1 });

  const stored = await store.get("slow");
  expect(stored?.claim).toBe("t2");
  expect(stored?.runCount).toBe(0);
  expect(stored?.lastStatus).toBe("running");
});

test("a stale claim is recoverable after the staleness window", async () => {
  const store = newStore();
  const now = Date.now();
  await writeJobs([job({ id: "stale", claim: "dead", lastRun: now - 31 * 60 * 1000 })]);

  const reclaimed = await store.claim("stale", "t2");
  expect(reclaimed?.claim).toBe("t2");
  expect(reclaimed?.lastRun).toBeGreaterThanOrEqual(now);

  await writeJobs([job({ id: "fresh", claim: "alive", lastRun: Date.now() - 60 * 1000 })]);
  expect(await store.claim("fresh", "t2")).toBeUndefined();
});

test("a held lock fails the mutation and leaves no lock or tmp file behind", async () => {
  const store = newStore();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(`${file}.lock`, "held", "utf8");

  const error = await caughtError(
    store.add({
      prompt: "blocked",
      schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
    }),
  );
  expect(error).toBeInstanceOf(CronStorageError);
  expect(error.message).toContain(file);
  expect(error.message.toLowerCase()).toContain("busy");

  await fs.unlink(`${file}.lock`);
  await store.add({
    prompt: "now fine",
    schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
  });
  expect(await exists(`${file}.lock`)).toBe(false);
  expect(await exists(`${file}.tmp`)).toBe(false);
  expect(await store.list()).toHaveLength(1);
});

test("pruneFinished drops spent once-jobs and disabled jobs only", async () => {
  const store = newStore();
  const now = Date.now();
  await store.add({
    prompt: "disabled",
    schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
  });
  const disabled = (await store.list())[0] as CronJob;
  await store.update(disabled.id, { enabled: false });

  await store.add({
    prompt: "spent",
    schedule: { kind: "once", atMs: now - 60_000, source: "+1m" },
  });
  await store.add({
    prompt: "future",
    schedule: { kind: "once", atMs: now + 60_000, source: "+1m" },
  });
  await store.add({
    prompt: "ticker",
    schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
  });

  const removed = await store.pruneFinished(now);
  expect(removed).toHaveLength(2);

  const remaining = await store.list();
  expect(remaining.map((entry) => entry.prompt).sort()).toEqual(["future", "ticker"]);
});
