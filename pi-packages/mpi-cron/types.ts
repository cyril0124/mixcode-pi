/**
 * mpi-cron: shared types for the job store, scheduler hub, tool, and UI.
 *
 * Jobs live in `<cwd>/<CONFIG_DIR_NAME>/cron/jobs.json` and are claimed at fire time,
 * so an extra tab or a restart never orphans them.
 */

/** How a job's next run time is computed. */
export type JobSchedule =
  | { kind: "cron"; expr: string; source: string }
  | { kind: "interval"; intervalMs: number; source: string }
  | { kind: "once"; atMs: number; source: string }
  | { kind: "relative"; delayMs: number; source: string };

/** Terminal state of the most recent run. */
export type RunStatus = "ok" | "error" | "running";

export interface CronJob {
  id: string;
  name: string;
  description?: string;
  prompt: string;
  schedule: JobSchedule;
  enabled: boolean;
  runCount: number;
  /** Epoch ms of the last completed or started run. */
  lastRun?: number;
  lastStatus?: RunStatus;
  /** Absolute epoch ms of the next planned run; absent for disabled jobs. */
  nextRun?: number;
  /** Token of the run currently in flight; absent when the job is not claimed. */
  claim?: string;
  createdAt: number;
  /**
   * Session that created the job. A fired prompt prefers this session, so a job
   * reports back to the tab it was set up in; a session that has since exited
   * falls back to the first interactive tab.
   */
  createdBy?: string;
  /** Absolute epoch ms after which the job stops without being explicitly disabled. */
  expiresAt?: number;
}

/** Fields a caller may set when creating a job; the store fills the rest. */
export interface CronJobInput {
  name?: string;
  description?: string;
  prompt: string;
  schedule: JobSchedule;
  createdBy?: string;
  expiresAt?: number;
}

/** One tab/session that can receive a fired prompt and render the widget. */
export interface CronInstance {
  /** Stable id for this tab's session, used as the registry key. */
  sessionId: string;
  sessionFile?: string;
  /** Session that spawned this one, when the runtime reports one. */
  parentSession?: string;
  /** True when this instance runs inside a pi-subagents child session. */
  isSubagent: boolean;
  cwd: string;
  /** Inject a prompt, preferring the follow-up queue while the agent is busy. */
  deliver: (prompt: string) => boolean;
  /** True when the session is idle and a fired prompt can start a turn. */
  isIdle: () => boolean;
  /** Ask the tab to re-render its cron widget. */
  refresh: () => void;
  /** Name reported by the session runtime, when any. */
  sessionName?: string;
}
