/**
 * Report mpi turn lifecycle to Herdr so background panes can show `done`
 * (Herdr: idle + unseen). BEL alone does not drive Herdr agent state.
 *
 * Only active when HERDR_ENV=1 and HERDR_PANE_ID are set (inside a Herdr pane).
 * Multi-tab: process-level refcount so any busy session keeps the pane working.
 *
 * Pure Node — must also run under upstream pi (Node + jiti).
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type HerdrReportState = "working" | "idle";

export const HERDR_REPORT_SOURCE = "custom:mpi";
export const HERDR_REPORT_AGENT = "mpi";

// Process-wide across all sessions in this mpi process (multi-tab).
let activeRuns = 0;
let previousReported: HerdrReportState | undefined;
let seq = Date.now() * 1000;

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

function spawnHerdrReportAgent(
  paneId: string,
  state: HerdrReportState,
  nextSeq: number,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const bin = resolveHerdrBin(env);
  if (!bin) return;
  const child = spawn(bin, buildHerdrReportAgentArgs(paneId, state, nextSeq), {
    stdio: "ignore",
    detached: true,
  });
  child.unref();
}

function report(state: HerdrReportState): void {
  if (previousReported === state) return;
  const paneId = resolveHerdrPaneId();
  if (!paneId) return;
  previousReported = state;
  seq += 1;
  spawnHerdrReportAgent(paneId, state, seq);
}

function onAgentStart(): void {
  if (!resolveHerdrPaneId()) return;
  activeRuns += 1;
  if (activeRuns === 1) report("working");
}

function onAgentSettled(): void {
  if (!resolveHerdrPaneId()) return;
  activeRuns = Math.max(0, activeRuns - 1);
  if (activeRuns === 0) report("idle");
}

const herdrReportExtension: ExtensionFactory = (pi) => {
  pi.on("agent_start", () => {
    onAgentStart();
  });
  pi.on("agent_settled", () => {
    onAgentSettled();
  });
};

export default herdrReportExtension;
