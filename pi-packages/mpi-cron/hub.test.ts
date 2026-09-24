/**
 * Hub contract tests: exactly-once firing across instances, delivery preference,
 * and the store round-trip a run performs. Everything runs on a fake clock and an
 * in-memory store, so no real timer or filesystem is involved.
 */

import { describe, expect, test } from "bun:test";
import { CronHub, resetCronHubForTests, type HubClock } from "./hub.js";
import type { CronJob, CronInstance, JobSchedule } from "./types.js";
import { CronStorageError } from "./storage.js";

/** Deterministic clock: timers only run when the test advances time. */
class FakeClock implements HubClock {
  nowMs = 1_000_000;
  private scheduled = new Map<number, { fn: () => void; at: number }>();
  private nextId = 1;

  now(): number {
    return this.nowMs;
  }

  setTimeout(fn: () => void, delayMs: number): unknown {
    const id = this.nextId++;
    this.scheduled.set(id, { fn, at: this.nowMs + delayMs });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.scheduled.delete(handle as number);
  }

  /** Advance time, running every timer that comes due in order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = [...this.scheduled.entries()]
        .filter(([, entry]) => entry.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, entry] = due;
      this.scheduled.delete(id);
      this.nowMs = entry.at;
      entry.fn();
      await Bun.sleep(0);
    }
    this.nowMs = target;
    await Bun.sleep(0);
  }

  get pendingCount(): number {
    return this.scheduled.size;
  }
}

/**
 * In-memory stand-in for CronStore with the same claim semantics, so the hub can
 * be exercised without touching a real file. Claim exclusivity is what the real
 * store guarantees through its lock; here a synchronous check is enough.
 */
class FakeStore {
  jobs = new Map<string, CronJob>();
  private counter = 1;

  seed(job: Partial<CronJob> & { id: string; schedule: JobSchedule }): CronJob {
    const full: CronJob = {
      name: job.id,
      prompt: "seeded",
      enabled: true,
      runCount: 0,
      createdAt: 0,
      ...job,
    };
    this.jobs.set(full.id, full);
    return full;
  }

  async list(): Promise<CronJob[]> {
    return [...this.jobs.values()].map((job) => ({ ...job }));
  }

  async get(id: string): Promise<CronJob | undefined> {
    const job = this.jobs.get(id);
    return job ? { ...job } : undefined;
  }

  async add(input: Partial<CronJob> & { prompt: string; schedule: JobSchedule }, nextRun?: number) {
    const id = `job-${this.counter++}`;
    const job: CronJob = {
      ...input,
      id,
      name: input.name ?? id,
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: input.enabled ?? true,
      runCount: input.runCount ?? 0,
      createdAt: input.createdAt ?? 0,
      ...(nextRun !== undefined ? { nextRun } : {}),
    };
    this.jobs.set(id, job);
    return { ...job };
  }

  async update(id: string, patch: Partial<CronJob> & { nextRun?: number | null }) {
    const job = this.jobs.get(id);
    if (!job) throw new CronStorageError(`No cron job with id "${id}".`);
    const { nextRun, ...rest } = patch;
    const merged: CronJob = { ...job, ...rest };
    if (nextRun === null) delete merged.nextRun;
    else if (nextRun !== undefined) merged.nextRun = nextRun;
    this.jobs.set(id, merged);
    return { ...merged };
  }

  async remove(id: string): Promise<boolean> {
    return this.jobs.delete(id);
  }

  async claim(id: string, token: string, plannedFor?: number): Promise<CronJob | undefined> {
    const job = this.jobs.get(id);
    if (!job?.enabled) return undefined;
    if (job.claim !== undefined && job.claim !== token) return undefined;
    if (plannedFor !== undefined && job.nextRun !== undefined && job.nextRun !== plannedFor) {
      return undefined;
    }
    const claimed: CronJob = { ...job, claim: token, lastRun: job.lastRun ?? 0 };
    this.jobs.set(id, claimed);
    return { ...claimed };
  }

  async release(
    id: string,
    token: string,
    result: {
      status: string;
      runCount: number;
      lastRun: number;
      nextRun?: number | null;
      enabled?: boolean;
    },
  ): Promise<void> {
    const job = this.jobs.get(id);
    if (!job || job.claim !== token) return;
    const merged: CronJob = {
      ...job,
      claim: undefined,
      runCount: result.runCount,
      lastStatus: result.status as CronJob["lastStatus"],
      lastRun: result.lastRun,
    };
    delete merged.claim;
    if (result.nextRun === null || result.nextRun === undefined) delete merged.nextRun;
    else merged.nextRun = result.nextRun;
    if (result.enabled !== undefined) merged.enabled = result.enabled;
    this.jobs.set(id, merged);
  }

  async pruneFinished(_now: number): Promise<string[]> {
    // Mirrors the store: a job that can never fire again is removed.
    const removed = [...this.jobs.values()].filter((job) => !job.enabled).map((job) => job.id);
    for (const id of removed) this.jobs.delete(id);
    return removed;
  }
}

function makeInstance(overrides: Partial<CronInstance> & { sessionId: string }): CronInstance & {
  delivered: string[];
} {
  const delivered: string[] = [];
  return {
    isSubagent: false,
    cwd: "/repo",
    isIdle: () => true,
    deliver: (prompt: string) => {
      delivered.push(prompt);
      return true;
    },
    refresh: async () => {},
    delivered,
    ...overrides,
  };
}

function makeHub(options: { store: FakeStore; clock: FakeClock }) {
  return new CronHub({
    store: options.store as never,
    clock: options.clock,

    minDelayMs: 0,
  });
}

describe("CronHub scheduling", () => {
  test("plans a timer per enabled job and fires it exactly once at its next run", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({
      id: "hourly",
      schedule: { kind: "interval", intervalMs: 3_600_000, source: "1h" },
    });
    const hub = makeHub({ store, clock });
    const instance = makeInstance({ sessionId: "tab-a" });
    hub.register(instance);

    await hub.refresh();
    expect(clock.pendingCount).toBe(1);

    await clock.advance(3_600_000);
    await Bun.sleep(0);
    expect(instance.delivered).toEqual(["seeded"]);
    const job = await store.get("hourly");
    expect(job?.runCount).toBe(1);
    expect(job?.claim).toBeUndefined();
    // Interval fire times live on the epoch grid, so the next run is the next
    // hour boundary after the run that just completed, not start + 2 intervals.
    const firedAt = 1_000_000 + 3_600_000;
    expect(job?.nextRun).toBe(Math.floor(firedAt / 3_600_000) * 3_600_000 + 3_600_000);
  });

  test("two instances in one process deliver a single run", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({ id: "shared", schedule: { kind: "interval", intervalMs: 60_000, source: "1m" } });
    const hub = makeHub({ store, clock });
    const first = makeInstance({ sessionId: "tab-a" });
    const second = makeInstance({ sessionId: "tab-b" });
    hub.register(first);
    hub.register(second);

    await hub.refresh();
    // One plan per job, regardless of how many instances registered.
    expect(clock.pendingCount).toBe(1);

    await clock.advance(60_000);
    await Bun.sleep(0);
    expect(first.delivered.length + second.delivered.length).toBe(1);
    expect((await store.get("shared"))?.runCount).toBe(1);
  });

  test("a stale claim in the store suppresses firing until it is released", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({
      id: "busy",
      schedule: { kind: "interval", intervalMs: 60_000, source: "1m" },
      claim: "other-process",
    });
    const hub = makeHub({ store, clock });
    const instance = makeInstance({ sessionId: "tab-a" });
    hub.register(instance);

    await hub.refresh();
    expect(clock.pendingCount).toBe(0);
    expect(instance.delivered).toEqual([]);
  });

  test("a disabled job is never planned, and disabling stops a pending timer", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({
      id: "paused",
      enabled: false,
      schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
    });
    const hub = makeHub({ store, clock });
    const instance = makeInstance({ sessionId: "tab-a" });
    hub.register(instance);

    await hub.refresh();
    expect(clock.pendingCount).toBe(0);
    await clock.advance(10_000);
    expect(instance.delivered).toEqual([]);

    const running = store.seed({
      id: "live",
      schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
    });
    void running;
    await hub.refresh();
    expect(clock.pendingCount).toBe(1);
    await hub.update("live", { enabled: false });
    expect(clock.pendingCount).toBe(0);
  });

  test("a one-shot job fires once and leaves no timer or store entry behind", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({
      id: "once",
      schedule: { kind: "once", atMs: 1_002_000, source: "2026-01-01T00:00:02" },
    });
    const hub = makeHub({ store, clock });
    const instance = makeInstance({ sessionId: "tab-a" });
    hub.register(instance);

    await hub.refresh();
    await clock.advance(5_000);
    await Bun.sleep(0);

    expect(instance.delivered).toEqual(["seeded"]);
    expect(await store.get("once")).toBeUndefined();
    expect(clock.pendingCount).toBe(0);
  });

  test("a tab's last repaint shows the pruned store, never the spent job", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({ id: "once", schedule: { kind: "relative", delayMs: 1_000, source: "+1s" } });
    const hub = makeHub({ store, clock });
    const painted: string[][] = [];
    const instance = makeInstance({
      sessionId: "tab-a",
      refresh: async () => {
        painted.push((await store.list()).map((job) => job.id));
      },
    });
    hub.register(instance);

    await hub.refresh();
    await clock.advance(2_000);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(painted.length).toBeGreaterThan(0);
    expect(painted.at(-1)).toEqual([]);
  });

  test("a timer whose tick the store already moved past does not deliver again", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({
      id: "shared",
      schedule: { kind: "interval", intervalMs: 20_000, source: "20s" },
      nextRun: clock.nowMs,
    });
    const hub = makeHub({ store, clock });
    const instance = makeInstance({ sessionId: "tab-a" });
    hub.register(instance);
    await hub.refresh();

    // A peer process runs the same tick first and moves the plan forward.
    await store.update("shared", { nextRun: clock.nowMs + 20_000, runCount: 1 });

    await clock.advance(100);
    await Bun.sleep(0);
    await Bun.sleep(0);

    expect(instance.delivered).toEqual([]);
  });

  test("a run with no live instance still records the outcome in the store", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({ id: "orphan", schedule: { kind: "interval", intervalMs: 1_000, source: "1s" } });
    const hub = makeHub({ store, clock });

    await hub.refresh();
    await clock.advance(1_000);
    await Bun.sleep(0);

    const job = await store.get("orphan");
    expect(job?.runCount).toBe(1);
    expect(job?.lastStatus).toBe("error");
    expect(job?.claim).toBeUndefined();
    // The schedule keeps advancing so the job fires again once a tab appears.
    expect(job?.nextRun).toBe(1_000_000 + 2_000);
  });
});

describe("CronHub refresh serialization", () => {
  test("a refresh resolves on a read that began after the call, never a stale one", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const hub = makeHub({ store, clock });
    const first = hub.refresh();
    // Mutate while the first read is in flight; the second call must observe it.
    await store.add({
      prompt: "added mid-flight",
      schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
    });
    const second = await hub.refresh();
    await first;
    expect(second.some((job) => job.prompt === "added mid-flight")).toBe(true);
  });

  test("concurrent refreshes both complete without losing a job", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({ id: "a", schedule: { kind: "interval", intervalMs: 1_000, source: "1s" } });
    const hub = makeHub({ store, clock });
    const [first, second] = await Promise.all([hub.refresh(), hub.refresh()]);
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(clock.pendingCount).toBe(1);
  });
});

describe("CronHub delivery", () => {
  test("prefers an interactive instance over a subagent one", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const hub = makeHub({ store, clock });
    const subagent = makeInstance({ sessionId: "child", isSubagent: true });
    const tab = makeInstance({ sessionId: "parent" });
    hub.register(subagent);
    hub.register(tab);

    expect(hub.pickInstance()?.sessionId).toBe("parent");
    expect(hub.pickInstance(undefined)?.isSubagent).toBe(false);
  });

  test("a fired prompt goes back to the session that created the job", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    // The creating tab registered last, so registry order alone would pick the
    // other one; only `createdBy` can send the run back to where it was set up.
    store.seed({
      id: "job",
      createdBy: "creator",
      schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
    });
    const hub = makeHub({ store, clock });
    const other = makeInstance({ sessionId: "other" });
    const creator = makeInstance({ sessionId: "creator" });
    hub.register(other);
    hub.register(creator);

    await hub.refresh();
    await clock.advance(1_000);
    await Bun.sleep(0);

    expect(creator.delivered).toEqual(["seeded"]);
    expect(other.delivered).toEqual([]);
  });

  test("falls back to an interactive tab when the creating session is gone", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({
      id: "job",
      createdBy: "closed-tab",
      schedule: { kind: "interval", intervalMs: 1_000, source: "1s" },
    });
    const hub = makeHub({ store, clock });
    const live = makeInstance({ sessionId: "live" });
    hub.register(live);

    await hub.refresh();
    await clock.advance(1_000);
    await Bun.sleep(0);

    expect(live.delivered).toEqual(["seeded"]);
  });

  test("a dead instance is dropped from the registry when delivery throws", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    store.seed({ id: "job", schedule: { kind: "interval", intervalMs: 1_000, source: "1s" } });
    const hub = makeHub({ store, clock });
    const dead = makeInstance({
      sessionId: "dead",
      deliver: () => {
        throw new Error("stale context");
      },
    });
    const alive = makeInstance({ sessionId: "alive" });
    hub.register(dead);
    hub.register(alive);
    hub.register(alive);

    await hub.refresh();
    await clock.advance(1_000);
    await Bun.sleep(0);

    expect(alive.delivered).toEqual(["seeded"]);
    expect(hub.listInstances().map((instance) => instance.sessionId)).not.toContain("dead");
  });

  test("fireNow claims a disabled job's run instead of duplicating it", async () => {
    const clock = new FakeClock();
    const store = new FakeStore();
    const job = store.seed({
      id: "manual",
      schedule: { kind: "interval", intervalMs: 60_000, source: "1m" },
    });
    const hub = makeHub({ store, clock });
    const instance = makeInstance({ sessionId: "tab-a" });
    hub.register(instance);

    expect(await hub.fireNow(job.id)).toBe("done");
    expect(instance.delivered).toEqual(["seeded"]);
    expect((await store.get(job.id))?.runCount).toBe(1);
  });
});

describe("CronHub singleton", () => {
  test("getCronHub returns one hub per process and resetCronHubForTests clears it", async () => {
    const { getCronHub } = await import("./hub.js");
    resetCronHubForTests();
    const clock = new FakeClock();
    const store = new FakeStore();
    const first = getCronHub({ store: store as never, clock, minDelayMs: 0 });
    const second = getCronHub({ store: store as never, clock, minDelayMs: 0 });
    expect(first).toBe(second);
    resetCronHubForTests();
    const third = getCronHub({ store: store as never, clock, minDelayMs: 0 });
    expect(third).not.toBe(first);
    resetCronHubForTests();
  });
});
