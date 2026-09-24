/**
 * mpi-cron: per-process scheduler hub.
 *
 * One hub owns all timers for a given working directory. Pi's loader caches one
 * module instance per cwd, so every tab in a process shares this module's
 * top-level state. Per-tab data is keyed by session id.
 */

import type { CronJob, CronInstance } from "./types.js";
import type { CronStore } from "./storage.js";
import { CronStorageError } from "./storage.js";
import { nextRun } from "./cron-engine.js";

/** Minimal clock/timer seam so tests can drive firing without real timers. */
export interface HubClock {
  now(): number;
  setTimeout(fn: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realClock: HubClock = {
  now: () => Date.now(),
  setTimeout: (fn, delayMs) => setTimeout(fn, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export interface CronHubOptions {
  store: CronStore;
  clock?: HubClock;
  /** Called after any state change so each instance can re-render its widget. */
  onChange?: (event: { kind: "jobs" | "instances"; sessionId?: string }) => void;
  /** Called after each run finishes; used to write transcript markers. */
  onRunFinished?: (event: {
    job: CronJob;
    status: "ok" | "error";
    detail: string;
    delivered: boolean;
    /** Session the run was delivered to, when one was found. */
    sessionId?: string;
  }) => void;
  /** Minimum delay before a re-planned timer; guards against tight loops. */
  minDelayMs?: number;
}

interface ScheduledJob {
  handle: unknown;
  /** Epoch ms the pending timer was planned for; protects against intra-process races. */
  plannedFor: number;
}

const DEFAULT_MIN_DELAY_MS = 250;

/**
 * Process-wide hub. A Symbol key on globalThis keeps it single even if the
 * loader re-evaluates this module (extension cache cleared by `/reload`), so a
 * reload cannot orphan live timers or duplicate deliveries.
 */
const HUB_KEY = Symbol.for("mpi-cron.hub");

export class CronHub {
  private readonly store: CronStore;
  private readonly clock: HubClock;
  private readonly onChange?: CronHubOptions["onChange"];
  private readonly onRunFinished?: CronHubOptions["onRunFinished"];
  private readonly minDelayMs: number;

  /** Live instances keyed by session id: delivery targets and widget owners. */
  private readonly instances = new Map<string, CronInstance>();
  /** One pending timer per enabled job, keyed by job id. */
  private readonly timers = new Map<string, ScheduledJob>();
  /** Jobs currently being fired, so a tick cannot double-fire within a process. */
  private readonly running = new Set<string>();
  private pristine = true;
  /** Last list returned by doRefresh; used for synchronous reads such as tab-completion. */
  private lastKnownJobs: CronJob[] = [];
  /** Tail of the read queue; keeps concurrent refreshes from interleaving. */
  private inFlight: Promise<CronJob[]> | undefined;

  constructor(options: CronHubOptions) {
    this.store = options.store;
    this.clock = options.clock ?? realClock;
    this.onChange = options.onChange;
    this.onRunFinished = options.onRunFinished;
    this.minDelayMs = options.minDelayMs ?? DEFAULT_MIN_DELAY_MS;
  }

  // ── instances ────────────────────────────────────────────────────────────

  /** Register an instance. Non-subagent instances also start the hub's timers. */
  register(instance: CronInstance): void {
    const first = !this.instances.has(instance.sessionId);
    this.instances.set(instance.sessionId, instance);
    if (first && this.pristine) {
      // First registration: load persisted jobs and start timers. The store claim
      // ensures a job fired by another process is not fired again here.
      void this.refresh();
    }
    this.emit({ kind: "instances", sessionId: instance.sessionId });
  }

  unregister(sessionId: string): void {
    if (!this.instances.delete(sessionId)) return;
    this.emit({ kind: "instances", sessionId });
  }

  listInstances(): CronInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Delivery target for a fired job. Prefers an interactive tab over a subagent
   * session; falls back to any registered instance if no interactive one exists.
   * `preferSessionId` picks a specific session when provided.
   */
  pickInstance(preferSessionId?: string): CronInstance | undefined {
    const all = this.listInstances();
    if (all.length === 0) return undefined;
    if (preferSessionId) {
      const exact = all.find((i) => i.sessionId === preferSessionId);
      if (exact) return exact;
    }
    return all.find((i) => !i.isSubagent) ?? all[0];
  }

  // ── scheduling ───────────────────────────────────────────────────────────

  /**
   * Read the store and align the timers.
   *
   * Callers must not share an in-flight read: a repaint triggered right after a
   * run needs the state that run wrote, and joining a read started before the
   * write would show the stale snapshot. Reads are therefore queued, never
   * coalesced, and every caller resolves on a read that began after its call.
   */
  async refresh(): Promise<CronJob[]> {
    const previous = this.inFlight ?? Promise.resolve();
    const run = previous.then(() => this.doRefresh());
    this.inFlight = run;
    try {
      return await run;
    } finally {
      if (this.inFlight === run) this.inFlight = undefined;
    }
  }

  /** Return the last refreshed job list without reading the store. */
  cachedJobs(): CronJob[] {
    return this.lastKnownJobs;
  }

  private async doRefresh(): Promise<CronJob[]> {
    const jobs = await this.store.list();
    const live = new Set(jobs.map((job) => job.id));
    for (const [jobId, scheduled] of this.timers) {
      if (live.has(jobId)) continue;
      this.clearTimer(jobId, scheduled);
    }

    const now = this.clock.now();
    for (const job of jobs) {
      const due = this.dueAt(job, now);
      if (due === undefined) {
        const existing = this.timers.get(job.id);
        if (existing) this.clearTimer(job.id, existing);
        continue;
      }
      const existing = this.timers.get(job.id);
      if (existing && existing.plannedFor === due) continue;
      if (existing) this.clearTimer(job.id, existing);
      this.plan(job.id, due);
    }
    this.pristine = false;
    this.lastKnownJobs = jobs;
    return jobs;
  }

  /** Planned fire time for a job, or undefined when it must not be scheduled. */
  private dueAt(job: CronJob, now: number): number | undefined {
    if (!job.enabled) return undefined;
    if (job.claim !== undefined) return undefined; // a run is in flight
    const planned = job.nextRun ?? this.computeNext(job, now);
    if (planned === undefined) return undefined;
    return planned;
  }

  /** Next fire time for a job, or undefined when the schedule is exhausted. */
  private computeNext(job: CronJob, from: number): number | undefined {
    try {
      return nextRun(job.schedule, from);
    } catch {
      // Exhausted or invalid schedule: the job stays visible but stops firing.
      return undefined;
    }
  }

  private plan(jobId: string, atMs: number): void {
    const delay = Math.max(this.minDelayMs, atMs - this.clock.now());
    const handle = this.clock.setTimeout(() => {
      this.timers.delete(jobId);
      void this.fire(jobId, atMs);
    }, delay);
    this.timers.set(jobId, { handle, plannedFor: atMs });
  }

  private clearTimer(jobId: string, scheduled: ScheduledJob): void {
    this.clock.clearTimeout(scheduled.handle);
    this.timers.delete(jobId);
  }

  /** Stop every timer without touching the store (shutdown/reload). */
  stopAll(): void {
    for (const [jobId, scheduled] of this.timers) this.clearTimer(jobId, scheduled);
  }

  // ── firing ───────────────────────────────────────────────────────────────

  /**
   * Fire one job. Claims the job in the store before delivering, so concurrent
   * tabs or processes fire it at most once per scheduled tick.
   *
   * Timer runs use the planned fire time as the token (same across processes).
   * Manual runs use a unique token so they cannot duplicate a pending timer run.
   */
  async fire(jobId: string, planToken?: number, manual = false): Promise<"done" | "skipped"> {
    if (this.running.has(jobId)) return "skipped";
    const job = await this.store.get(jobId);
    if (!job) return "skipped";
    if (!job.enabled) return "skipped";

    const token =
      planToken !== undefined && !manual
        ? String(planToken)
        : `${this.clock.now()}-${Math.floor(this.running.size * 7919 + job.runCount)}-manual`;
    const claimed = await this.store.claim(
      jobId,
      token,
      planToken !== undefined && !manual ? planToken : undefined,
    );
    if (!claimed) return "skipped";

    this.running.add(jobId);
    const startedAt = this.clock.now();
    const runCount = claimed.runCount + 1;
    let status: "ok" | "error" = "ok";
    let detail = "";
    let delivered = false;
    let deliveredTo: string | undefined;

    try {
      const outcome = this.deliverPrompt(claimed);
      delivered = outcome.delivered;
      deliveredTo = outcome.sessionId;
      if (!delivered) {
        status = "error";
        detail = "no active session to deliver the prompt to";
      }
    } catch (error) {
      status = "error";
      detail = error instanceof Error ? error.message : String(error);
    } finally {
      this.running.delete(jobId);
    }

    // Plan the next run from the run's own end time; a job whose schedule is
    // exhausted is disabled so the store does not keep a dead entry enabled.
    const finishedAt = this.clock.now();
    let nextAt: number | undefined;
    if (claimed.schedule.kind === "once" || claimed.schedule.kind === "relative") {
      nextAt = undefined;
    } else {
      nextAt = this.computeNext(claimed, Math.max(finishedAt, startedAt));
      if (nextAt !== undefined && claimed.expiresAt !== undefined && nextAt > claimed.expiresAt) {
        nextAt = undefined;
      }
    }

    await this.store.release(jobId, token, {
      status,
      runCount,
      lastRun: finishedAt,
      nextRun: nextAt ?? null,
      ...(nextAt === undefined && claimed.enabled ? { enabled: false } : {}),
    });

    this.onRunFinished?.({
      job: { ...claimed, runCount, lastRun: finishedAt, lastStatus: status },
      status,
      detail,
      delivered,
      sessionId: deliveredTo,
    });

    // A one-shot run is finished; drop it so the store does not accumulate
    // dead jobs. Disabled jobs are kept for the user to inspect and clean up.
    if (nextAt === undefined) {
      await this.store.pruneFinished(finishedAt);
    } else {
      this.plan(jobId, nextAt);
    }
    // Re-read before the next tick so a job changed in another tab, or expired
    // meanwhile, is not re-fired on a stale plan.
    await this.refresh();
    // Notify the tabs only after the store holds the post-run state, so a
    // repaint cannot render the job that pruning just dropped.
    this.emit({ kind: "jobs" });
    return "done";
  }

  /**
   * Deliver a prompt to a live session, preferring the one that created the job.
   * Drops the instance on a stale context.
   */
  private deliverPrompt(job: CronJob): { delivered: boolean; sessionId?: string } {
    const instance = this.pickInstance(job.createdBy);
    if (!instance) return { delivered: false };
    try {
      return { delivered: instance.deliver(job.prompt), sessionId: instance.sessionId };
    } catch {
      // The tab's context is stale: drop it and try the next interactive one
      // rather than losing the run.
      this.instances.delete(instance.sessionId);
      const fallback = this.pickInstance(job.createdBy);
      if (!fallback) return { delivered: false };
      try {
        return { delivered: fallback.deliver(job.prompt), sessionId: fallback.sessionId };
      } catch {
        this.instances.delete(fallback.sessionId);
        return { delivered: false };
      }
    }
  }

  // ── mutations ────────────────────────────────────────────────────────────

  /** Create a job and schedule it. */
  async add(input: Parameters<CronStore["add"]>[0]): Promise<CronJob> {
    const now = this.clock.now();
    const preview: CronJob = {
      id: "pending",
      name: input.name ?? "pending",
      prompt: input.prompt,
      schedule: input.schedule,
      enabled: true,
      runCount: 0,
      createdAt: now,
    };
    const nextAt = this.computeNext(preview, now);
    const job = await this.store.add(input, nextAt);
    await this.refresh();
    this.emit({ kind: "jobs" });
    return job;
  }

  /** Patch a job, re-planning its timer when the schedule or enabled flag moved. */
  async update(id: string, patch: Partial<CronJob>): Promise<CronJob> {
    const current = await this.store.get(id);
    if (!current) throw new CronStorageError(`No cron job with id "${id}".`);
    // Always re-plan here: the caller may have moved the schedule, re-enabled the
    // job, or cleared a stuck claim, and the prompt/name edits do not change it.
    const merged: CronJob = { ...current, ...patch };
    const nextAt = merged.enabled ? this.computeNext(merged, this.clock.now()) : undefined;
    const updated = await this.store.update(id, { ...patch, nextRun: nextAt ?? null });
    await this.refresh();
    this.emit({ kind: "jobs" });
    return updated;
  }

  async remove(id: string): Promise<boolean> {
    const scheduled = this.timers.get(id);
    if (scheduled) this.clearTimer(id, scheduled);
    const removed = await this.store.remove(id);
    await this.refresh();
    this.emit({ kind: "jobs" });
    return removed;
  }

  /** Fire a job immediately, bypassing its schedule but not its claim. */
  async fireNow(id: string): Promise<"done" | "skipped"> {
    const result = await this.fire(id, undefined, true);
    await this.refresh();
    return result;
  }

  private emit(event: { kind: "jobs" | "instances"; sessionId?: string }): void {
    this.onChange?.(event);
    for (const instance of this.instances.values()) {
      if (event.sessionId !== undefined && event.sessionId === instance.sessionId) continue;
      try {
        instance.refresh();
      } catch {
        // A dead tab's refresh throws on its stale context; drop it so the hub
        // stops trying to deliver into it.
        this.instances.delete(instance.sessionId);
      }
    }
  }

  /** True while the hub has never loaded the store (first-navigation lazy start). */
  get isPristine(): boolean {
    return this.pristine;
  }
}

/**
 * The single hub for this process, created on first use. Keyed on globalThis so
 * a module re-evaluation cannot create a second hub with its own timers.
 */
export function getCronHub(options: CronHubOptions): CronHub {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[HUB_KEY];
  if (existing instanceof CronHub) return existing;
  const hub = new CronHub(options);
  registry[HUB_KEY] = hub;
  return hub;
}

/** Test-only escape hatch: drop the process-wide hub so a test can build a fresh one. */
export function resetCronHubForTests(): void {
  const registry = globalThis as unknown as Record<symbol, unknown>;
  const existing = registry[HUB_KEY];
  if (existing instanceof CronHub) existing.stopAll();
  delete registry[HUB_KEY];
}
