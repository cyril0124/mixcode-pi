/**
 * Report mpi turn lifecycle to Herdr so background panes can show `done`
 * (Herdr: idle + unseen) and `blocked` (waiting for user input).
 * BEL alone does not drive Herdr agent state.
 *
 * Only active when HERDR_ENV=1 and HERDR_PANE_ID are set (inside a Herdr pane).
 * Multi-tab: process-level refcounts so any busy/waiting session drives the pane.
 *
 * Events (host fans out on every session EventBus; string channels only):
 * - `mpi:waiting-for-input` → blocked vs not
 * - `mpi:mark-done` → force a working→idle pulse (Herdr only notifies on state
 *   *change*; already-idle is a no-op with plain report). Also try
 *   `notification show --sound done` (may be disabled in herdr toast config).
 *   Herdr UI `done` = idle + unseen; while focused you stay idle, not done.
 *
 * Pure Node — must also run under upstream pi (Node + jiti).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

/** Herdr `pane report-agent --state` values we emit. */
export type HerdrReportState = "working" | "idle" | "blocked";

// Must match Herdr's detected agent ownership. `custom:mpi` is accepted by the
// API but ignored for pane state when screen detection already owns label `mpi`.
export const HERDR_REPORT_SOURCE = "mpi";
export const HERDR_REPORT_AGENT = "mpi";

/** Shared with MixCode host channel names (string only — no import). */
export const WAITING_FOR_INPUT_EVENT = "mpi:waiting-for-input" as const;
export const MARK_DONE_EVENT = "mpi:mark-done" as const;

export interface WaitingForInputEventPayload {
  count: number;
  active: boolean;
}

/** Pure priority: blocked > working > idle. */
export function deriveHerdrState(activeRuns: number, waitingCount: number): HerdrReportState {
  if (waitingCount > 0) return "blocked";
  if (activeRuns > 0) return "working";
  return "idle";
}

export function parseWaitingForInputPayload(raw: unknown): WaitingForInputEventPayload {
  if (!raw || typeof raw !== "object") return { count: 0, active: false };
  const count = (raw as { count?: unknown }).count;
  const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return { count: n, active: n > 0 };
}

// Process-wide across all sessions in this mpi process (multi-tab).
let activeRuns = 0;
let waitingCount = 0;
let previousReported: HerdrReportState | undefined;
let seq = Date.now() * 1000;
/** True after extension factory subscribed (avoids reporting before load). */
let bridgeAttached = false;
/** Coalesce multi-bus fan-out of the same mark-done into one notification. */
let lastMarkDoneAt = 0;

export function resolveHerdrPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERDR_ENV !== "1") return undefined;
  const paneId = env.HERDR_PANE_ID?.trim();
  return paneId || undefined;
}

export function buildHerdrReportAgentArgs(
  paneId: string,
  state: HerdrReportState,
  nextSeq: number,
): string[] {
  return [
    "pane",
    "report-agent",
    paneId,
    "--source",
    HERDR_REPORT_SOURCE,
    "--agent",
    HERDR_REPORT_AGENT,
    "--state",
    state,
    "--seq",
    String(nextSeq),
  ];
}

export function buildHerdrNotificationArgs(title: string, sound: "done" | "request" | "none"): string[] {
  return ["notification", "show", title, "--sound", sound];
}

export function resolveHerdrBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const fromEnv = env.HERDR_BIN_PATH?.trim();
  if (fromEnv) return fromEnv;
  return which("herdr", env);
}

function which(bin: string, env: NodeJS.ProcessEnv): string | undefined {
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // try next
    }
  }
  return undefined;
}

function spawnHerdr(args: string[], env: NodeJS.ProcessEnv = process.env): void {
  const bin = resolveHerdrBin(env);
  if (!bin) return;
  const child = spawn(bin, args, {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function spawnHerdrReportAgent(
  paneId: string,
  state: HerdrReportState,
  nextSeq: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  spawnHerdr(buildHerdrReportAgentArgs(paneId, state, nextSeq), env);
}

function spawnHerdrDoneNotification(env: NodeJS.ProcessEnv = process.env): void {
  spawnHerdr(buildHerdrNotificationArgs("Marked done", "done"), env);
}

function report(state: HerdrReportState): void {
  if (previousReported === state) return;
  forceReport(state);
}

/** Always emit report-agent (new seq), even when state is unchanged. */
function forceReport(state: HerdrReportState): void {
  const paneId = resolveHerdrPaneId();
  if (!paneId) return;
  previousReported = state;
  seq += 1;
  spawnHerdrReportAgent(paneId, state, seq);
}

function recompute(): void {
  if (!bridgeAttached) return;
  if (!resolveHerdrPaneId()) return;
  report(deriveHerdrState(activeRuns, waitingCount));
}

function onAgentStart(): void {
  if (!resolveHerdrPaneId()) return;
  activeRuns += 1;
  recompute();
}

function onAgentSettled(): void {
  if (!resolveHerdrPaneId()) return;
  activeRuns = Math.max(0, activeRuns - 1);
  recompute();
}

function onWaitingForInput(raw: unknown): void {
  const payload = parseWaitingForInputPayload(raw);
  waitingCount = payload.count;
  recompute();
}

/**
 * Explicit mark-done:
 * - Coalesce multi-bus fan-out (host emits on every session bus).
 * - If blocked, keep blocked; still try notification.
 * - Else force working→idle so Herdr sees a real state transition (plain
 *   report("idle") is a no-op when already idle, so completion UX never runs).
 * - notification.show often returns disabled in herdr config; pulse is primary.
 */
function onMarkDone(): void {
  if (!resolveHerdrPaneId()) return;
  const now = Date.now();
  if (now - lastMarkDoneAt < 100) return;
  lastMarkDoneAt = now;

  spawnHerdrDoneNotification();

  if (waitingCount > 0) return;

  // Pulse for Herdr state-change notifications without discarding multi-tab
  // run refcount; recompute restores true busy/idle after the pulse.
  forceReport("working");
  forceReport("idle");
  recompute();
}

const herdrReportExtension: ExtensionFactory = (pi) => {
  bridgeAttached = true;
  // Keep process-level listeners for the life of this extension runtime.
  // Do not unsubscribe on session_shutdown — that runs on /clear and session
  // replace while the same EventBus is reused, which would silently kill
  // mark-done / waiting handlers until a full extension reload.
  pi.events.on(WAITING_FOR_INPUT_EVENT, onWaitingForInput);
  pi.events.on(MARK_DONE_EVENT, () => {
    onMarkDone();
  });
  pi.on("agent_start", () => {
    onAgentStart();
  });
  pi.on("agent_settled", () => {
    onAgentSettled();
  });
};

export default herdrReportExtension;
