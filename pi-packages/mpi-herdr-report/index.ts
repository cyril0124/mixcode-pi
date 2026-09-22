/**
 * Report aggregate MixCode TUI activity to Herdr over socket JSON-RPC.
 * See README.md for activation, lifecycle, and delivery contracts.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as net from "node:net";
import type {
  ExtensionContext,
  ExtensionFactory,
  SessionShutdownEvent,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

type HerdrReportState = "working" | "idle" | "blocked";

export const HERDR_REPORT_SOURCE = "mpi";
export const HERDR_REPORT_AGENT = "mpi";
const MIXCODE_ENV = "MIXCODE" as const;
export const WAITING_FOR_INPUT_EVENT = "mpi:waiting-for-input" as const;
export const MARK_DONE_EVENT = "mpi:mark-done" as const;
const STATE_REFRESH_INTERVAL_MS = 2000;

interface WaitingForInputEventPayload {
  count: number;
}

export function isMixcodeProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MIXCODE_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function herdrBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isMixcodeProcess(env) &&
    env.HERDR_ENV === "1" &&
    !!env.HERDR_SOCKET_PATH?.trim() &&
    !!env.HERDR_PANE_ID?.trim()
  );
}

export function resolveHerdrPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!herdrBridgeEnabled(env)) return undefined;
  return env.HERDR_PANE_ID?.trim() || undefined;
}

export function socketEndpoint(
  socketPath: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** State priority: blocked > working > idle. */
export function desiredState(agentActive: boolean, blockedCount: number): HerdrReportState {
  if (blockedCount > 0) return "blocked";
  if (agentActive) return "working";
  return "idle";
}

export function isStaleCtxError(error: unknown): boolean {
  return /stale after session replacement/.test(String(error));
}

/** Return undefined for a replaced context; rethrow all other errors. */
export function readCtxIdle(ctx: { isIdle: () => boolean }): boolean | undefined {
  try {
    return ctx.isIdle();
  } catch (error) {
    if (isStaleCtxError(error)) return undefined;
    throw error;
  }
}

export function applySessionStart(
  busy: Set<string>,
  key: string | undefined,
  idle: boolean | undefined,
): void {
  if (!key || idle === undefined) return;
  if (idle) busy.delete(key);
  else busy.add(key);
}

export function applyAgentStart(busy: Set<string>, key: string | undefined): void {
  if (key) busy.add(key);
}

export function applyAgentSettled(
  busy: Set<string>,
  key: string | undefined,
  idle: boolean | undefined,
): void {
  if (!key || idle !== true) return;
  busy.delete(key);
}

export function applySessionShutdown(busy: Set<string>, key: string | undefined): void {
  if (key) busy.delete(key);
}

interface HerdrLedger {
  live: number;
  blocked: number;
  busy: Set<string>;
}

export function createHerdrLedger(): HerdrLedger {
  return { live: 0, blocked: 0, busy: new Set() };
}

export function retainSession(ledger: HerdrLedger): void {
  ledger.live += 1;
}

/** Returns true when this was the last live session. Last session forces idle. */
export function releaseSession(ledger: HerdrLedger, key?: string): boolean {
  applySessionShutdown(ledger.busy, key);
  ledger.live = Math.max(0, ledger.live - 1);
  if (ledger.live > 0) return false;
  ledger.busy.clear();
  ledger.blocked = 0;
  return true;
}

export function applyWaitingCount(ledger: HerdrLedger, count: number): void {
  ledger.blocked = Math.max(0, Math.floor(count));
}

export function ledgerState(ledger: HerdrLedger): HerdrReportState {
  return desiredState(ledger.busy.size > 0, ledger.blocked);
}

export function parseWaitingForInputPayload(raw: unknown): WaitingForInputEventPayload {
  if (!raw || typeof raw !== "object") return { count: 0 };
  const count = (raw as { count?: unknown }).count;
  const n =
    typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return { count: n };
}

interface HerdrRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

export function buildReportAgentRequest(
  paneId: string,
  state: HerdrReportState,
  seq: number,
  extra: Record<string, unknown> = {},
): HerdrRequest {
  return {
    id: `${HERDR_REPORT_SOURCE}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent",
    params: {
      pane_id: paneId,
      source: HERDR_REPORT_SOURCE,
      agent: HERDR_REPORT_AGENT,
      state,
      seq,
      ...extra,
    },
  };
}

export function buildReportAgentSessionRequest(
  paneId: string,
  seq: number,
  extra: Record<string, unknown> = {},
): HerdrRequest {
  return {
    id: `${HERDR_REPORT_SOURCE}:session:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "pane.report_agent_session",
    params: {
      pane_id: paneId,
      source: HERDR_REPORT_SOURCE,
      agent: HERDR_REPORT_AGENT,
      seq,
      ...extra,
    },
  };
}

export function buildNotificationShowRequest(
  title: string,
  sound: "done" | "request" | "none",
): HerdrRequest {
  return {
    id: `${HERDR_REPORT_SOURCE}:notify:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "notification.show",
    params: { title, sound },
  };
}

type QueuedState = {
  state: HerdrReportState;
  message?: string;
  extra?: Record<string, unknown>;
  seq: number;
};

/**
 * Build release arguments for the detached exit-cleanup process.
 * The caller supplies a sequence newer than pending reports so late delivery
 * cannot reclaim the released agent. Exit listeners cannot await socket I/O.
 */
function buildExitReleaseArgv(paneId: string, seq: number): string[] {
  return [
    "pane",
    "release-agent",
    paneId,
    "--source",
    HERDR_REPORT_SOURCE,
    "--agent",
    HERDR_REPORT_AGENT,
    "--seq",
    String(seq),
  ];
}

function installExitReleaseHook(): void {
  if (reporter.exitHookInstalled) return;
  reporter.exitHookInstalled = true;
  process.on("exit", () => {
    const pane = reporter.ownedPane;
    if (!pane) return;
    const child = spawn(pane.cli, buildExitReleaseArgv(pane.id, nextReportSeq()), {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, HERDR_SOCKET_PATH: pane.socketPath },
    });
    child.on("error", () => {
      // Best-effort teardown: the process is exiting, so CLI launch errors cannot be surfaced.
    });
    child.unref();
  });
}

interface ProcessReporter {
  exitHookInstalled: boolean;
  ownedPane?: { id: string; socketPath: string; cli: string };
  ownershipCheck?: Promise<boolean>;
  seq: number;
  sendInFlight: boolean;
  queuedState?: QueuedState;
  lastMarkDoneAt: number;
  lastState?: HerdrReportState;
  lastMessage?: string;
  lastStateSeq?: number;
  refreshTimer?: ReturnType<typeof setInterval>;
  contexts: Map<string, ExtensionContext>;
  ledger: HerdrLedger;
}

// Pi can re-evaluate the module while other tabs still use an older factory.
// Queue ownership, deduplication and the exit sequence must share the ledger's lifetime.
const REPORTER_KEY = Symbol.for("mpi-herdr-report:process-state");
const registry = globalThis as unknown as Record<symbol, ProcessReporter | undefined>;
registry[REPORTER_KEY] ??= {
  exitHookInstalled: false,
  seq: Date.now() * 1000,
  sendInFlight: false,
  lastMarkDoneAt: 0,
  contexts: new Map(),
  ledger: createHerdrLedger(),
};
const reporter = registry[REPORTER_KEY];
const processLedger = reporter.ledger;

function nextReportSeq(): number {
  // A later process can set a higher sequence for the same Herdr source.
  reporter.seq = Math.max(reporter.seq + 1, Date.now() * 1000);
  return reporter.seq;
}

function sessionFieldsFrom(ctx: unknown): Record<string, unknown> {
  const sessionManager = (
    ctx as { sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown } }
  )?.sessionManager;
  try {
    const file = sessionManager?.getSessionFile?.();
    if (typeof file === "string" && file.startsWith("/")) return { agent_session_path: file };
  } catch {
    // fall through to id
  }
  try {
    const id = sessionManager?.getSessionId?.();
    if (typeof id === "string" && id.length > 0) return { agent_session_id: id };
  } catch {
    // no session ref
  }
  return {};
}

/** Disabled bridges are no-ops; otherwise only a complete, matching success envelope confirms delivery. */
export async function sendRequestAttempt(
  request: HerdrRequest,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
  options: { unrefTimeout?: boolean } = {},
): Promise<boolean> {
  if (!herdrBridgeEnabled(env)) return true;
  return (await requestResultAttempt(request, timeoutMs, env, options)) !== undefined;
}

function requestResultAttempt(
  request: HerdrRequest,
  timeoutMs: number,
  env: NodeJS.ProcessEnv,
  options: { unrefTimeout?: boolean },
): Promise<Record<string, unknown> | undefined> {
  const path = env.HERDR_SOCKET_PATH!.trim();
  const endpoint = socketEndpoint(path);

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result?: Record<string, unknown>) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(result);
    };

    const socket = net.createConnection(endpoint);
    socket.setEncoding("utf8");
    let responseBuffer = "";
    socket.on("error", () => finish());
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      responseBuffer += chunk;
      const newline = responseBuffer.indexOf("\n");
      if (newline < 0) return;
      let response: unknown;
      try {
        response = JSON.parse(responseBuffer.slice(0, newline));
      } catch {
        // Invalid JSON is a failed delivery, not an acknowledgement.
        finish();
        return;
      }
      if (
        typeof response === "object" &&
        response !== null &&
        "id" in response &&
        response.id === request.id &&
        !("error" in response) &&
        "result" in response &&
        typeof response.result === "object" &&
        response.result !== null &&
        "type" in response.result &&
        typeof response.result.type === "string"
      ) {
        finish(response.result as Record<string, unknown>);
      } else {
        finish();
      }
    });
    socket.on("end", () => finish());
    timeout = setTimeout(() => finish(), timeoutMs);
    if (options.unrefTimeout !== false) timeout.unref?.();
  });
}

async function checkPaneOwnership(options: { unrefTimeout?: boolean }): Promise<boolean> {
  if (reporter.ownershipCheck) return reporter.ownershipCheck;
  const paneId = resolveHerdrPaneId();
  if (!paneId) {
    reporter.ownedPane = undefined;
    return false;
  }
  const env = { ...process.env };

  // Child processes can inherit HERDR_PANE_ID while running on a different PTY.
  reporter.ownershipCheck = (async () => {
    const result = await requestResultAttempt(
      {
        id: `${HERDR_REPORT_SOURCE}:owner:${randomUUID()}`,
        method: "pane.process_info",
        params: { pane_id: paneId },
      },
      500,
      env,
      options,
    );
    const info = result?.type === "pane_process_info" ? result.process_info : undefined;
    const ownsPane =
      typeof info === "object" &&
      info !== null &&
      "foreground_processes" in info &&
      Array.isArray(info.foreground_processes) &&
      info.foreground_processes.some(
        (entry: unknown) =>
          typeof entry === "object" &&
          entry !== null &&
          "pid" in entry &&
          entry.pid === process.pid,
      );
    // Exit cleanup uses the verified endpoint, even if a caller later changes its env.
    reporter.ownedPane = ownsPane
      ? {
          id: paneId,
          socketPath: env.HERDR_SOCKET_PATH!.trim(),
          cli: env.HERDR_BIN_PATH?.trim() || "herdr",
        }
      : undefined;
    return ownsPane;
  })();
  try {
    return await reporter.ownershipCheck;
  } finally {
    reporter.ownershipCheck = undefined;
  }
}

async function sendRequest(
  request: HerdrRequest,
  options: { unrefTimeout?: boolean } = {},
): Promise<boolean> {
  for (const timeoutMs of [500, 1500]) {
    if (!(await checkPaneOwnership(options))) return false;
    if (await sendRequestAttempt(request, timeoutMs, process.env, options)) return true;
  }
  return false;
}

function sendState(
  state: HerdrReportState,
  message: string | undefined,
  seq: number,
  extra: Record<string, unknown> = {},
  options: { unrefTimeout?: boolean } = {},
): Promise<boolean> {
  const paneId = resolveHerdrPaneId();
  if (!paneId) return Promise.resolve(false);
  return sendRequest(
    buildReportAgentRequest(paneId, state, seq, {
      ...extra,
      ...(message ? { message } : {}),
    }),
    options,
  );
}

function forgetFailedState(seq: number): void {
  // A failed older send must not invalidate a newer queued or direct report.
  if (reporter.lastStateSeq !== seq) return;
  reporter.lastState = undefined;
  reporter.lastMessage = undefined;
  reporter.lastStateSeq = undefined;
}

async function drainStateQueue(): Promise<void> {
  if (reporter.sendInFlight) return;
  reporter.sendInFlight = true;
  try {
    while (reporter.queuedState) {
      const next = reporter.queuedState;
      reporter.queuedState = undefined;
      const delivered = await sendState(next.state, next.message, next.seq, next.extra ?? {});
      if (!delivered) forgetFailedState(next.seq);
    }
  } finally {
    reporter.sendInFlight = false;
    if (reporter.queuedState) void drainStateQueue();
  }
}

function queueState(
  state: HerdrReportState,
  message?: string,
  extra: Record<string, unknown> = {},
): void {
  const seq = nextReportSeq();
  reporter.lastStateSeq = seq;
  reporter.queuedState = { state, message, extra, seq };
  if (!reporter.sendInFlight) void drainStateQueue();
}

function publishState(force = false, extra: Record<string, unknown> = {}): void {
  const state = ledgerState(processLedger);
  const message = processLedger.blocked > 0 ? "waiting for input" : undefined;
  if (!force && state === reporter.lastState && message === reporter.lastMessage) return;
  reporter.lastState = state;
  reporter.lastMessage = message;
  queueState(state, message, extra);
}

function startStateRefresh(): void {
  if (reporter.refreshTimer) return;
  // Compaction can change isIdle without agent_start. Refresh also repairs state lost by Herdr.
  reporter.refreshTimer = setInterval(() => {
    for (const [key, ctx] of reporter.contexts) {
      applySessionStart(processLedger.busy, key, readCtxIdle(ctx));
    }
    publishState(true);
  }, STATE_REFRESH_INTERVAL_MS);
  reporter.refreshTimer.unref();
}

const herdrReportExtension: ExtensionFactory = (pi) => {
  if (!herdrBridgeEnabled()) return;

  let rootSession = false;
  let sessionKey: string | undefined;
  let sessionExtra: Record<string, unknown> = {};

  function rememberSession(ctx: ExtensionContext): void {
    sessionExtra = sessionFieldsFrom(ctx);
    if (sessionKey) reporter.contexts.set(sessionKey, ctx);
  }

  async function flushIdle(): Promise<void> {
    reporter.queuedState = undefined;
    reporter.lastState = "idle";
    reporter.lastMessage = undefined;
    const seq = nextReportSeq();
    reporter.lastStateSeq = seq;
    const delivered = await sendState("idle", undefined, seq, {}, { unrefTimeout: false });
    if (!delivered) forgetFailedState(seq);
  }

  async function reportSession(sessionStartSource?: string): Promise<void> {
    const paneId = resolveHerdrPaneId();
    const extra = { ...sessionExtra };
    if (!paneId || Object.keys(extra).length === 0) return;
    if (sessionStartSource) extra.session_start_source = sessionStartSource;
    await sendRequest(buildReportAgentSessionRequest(paneId, nextReportSeq(), extra));
  }

  pi.events.on(WAITING_FOR_INPUT_EVENT, (raw: unknown) => {
    const payload = parseWaitingForInputPayload(raw);
    applyWaitingCount(processLedger, payload.count);
    if (!rootSession) return;
    publishState(false, sessionExtra);
  });

  pi.events.on(MARK_DONE_EVENT, () => {
    if (!rootSession) return;
    const now = Date.now();
    if (now - reporter.lastMarkDoneAt < 100) return;
    reporter.lastMarkDoneAt = now;
    void sendRequest(buildNotificationShowRequest("Marked done", "done"));
    publishState(true, sessionExtra);
  });

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    // Child processes can inherit Herdr env without owning the pane's TUI agent.
    installExitReleaseHook();
    if (!rootSession) {
      retainSession(processLedger);
      // Runtime ownership is distinct from a session file shared by multiple open instances.
      sessionKey = randomUUID();
    }
    rootSession = true;
    rememberSession(ctx);
    applySessionStart(processLedger.busy, sessionKey, readCtxIdle(ctx));
    startStateRefresh();
    void reportSession(event.reason).then(() => {
      if (rootSession) publishState(true, sessionExtra);
    });
  });

  pi.on("session_shutdown", (_event: SessionShutdownEvent) => {
    // Non-TUI sessions never retain the pane ledger; repeated shutdowns are inert.
    if (!rootSession) return;
    if (sessionKey) reporter.contexts.delete(sessionKey);
    const last = releaseSession(processLedger, sessionKey);
    rootSession = false;
    sessionKey = undefined;
    sessionExtra = {};
    if (last) {
      clearInterval(reporter.refreshTimer);
      reporter.refreshTimer = undefined;
      applyWaitingCount(processLedger, 0);
      return flushIdle();
    }
    publishState(true);
    return undefined;
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    rememberSession(ctx);
    applyAgentStart(processLedger.busy, sessionKey);
    publishState(false, sessionExtra);
    void reportSession();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession) return;
    rememberSession(ctx);
    applyAgentSettled(processLedger.busy, sessionKey, readCtxIdle(ctx));
    publishState(false, sessionExtra);
  });
};

export default herdrReportExtension;
