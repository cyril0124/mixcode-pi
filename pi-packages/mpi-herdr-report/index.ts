/**
 * Report mpi turn lifecycle to Herdr the same way the official Pi hook does:
 * socket JSON-RPC, latest-state queue, settled/isIdle.
 *
 * Active when MIXCODE is on and HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID
 * are set. MIXCODE off stays silent (do not fight official herdr:pi).
 * Multi-tab: process-level busy set so any running session keeps the pane working.
 *
 * MixCode extras: `mpi:waiting-for-input` → blocked, `mpi:mark-done` notify.
 * Pure Node — must also run under upstream pi (Node + jiti).
 */

import * as net from "node:net";
import type {
  ExtensionContext,
  ExtensionFactory,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export type HerdrReportState = "working" | "idle" | "blocked";

export const HERDR_REPORT_SOURCE = "mpi";
export const HERDR_REPORT_AGENT = "mpi";
export const MIXCODE_ENV = "MIXCODE" as const;
export const WAITING_FOR_INPUT_EVENT = "mpi:waiting-for-input" as const;
export const MARK_DONE_EVENT = "mpi:mark-done" as const;

export interface WaitingForInputEventPayload {
  count: number;
  active: boolean;
}

export function isMixcodeProcess(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[MIXCODE_ENV]?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function herdrBridgeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isMixcodeProcess(env) && env.HERDR_ENV === "1" && !!env.HERDR_SOCKET_PATH?.trim() && !!env.HERDR_PANE_ID?.trim();
}

export function resolveHerdrPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (!herdrBridgeEnabled(env)) return undefined;
  return env.HERDR_PANE_ID?.trim() || undefined;
}

export function socketEndpoint(socketPath: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? `\\\\.\\pipe\\${socketPath}` : socketPath;
}

/** Official-style desired state: blocked > working > idle. */
export function desiredState(agentActive: boolean, blockedCount: number): HerdrReportState {
  if (blockedCount > 0) return "blocked";
  if (agentActive) return "working";
  return "idle";
}

export function desiredBusy(busyCount: number, blockedCount: number): HerdrReportState {
  return desiredState(busyCount > 0, blockedCount);
}

/** Official: only clear busy when settled reports isIdle === true. */
export function shouldClearAgentActive(isIdle: unknown): boolean {
  return isIdle === true;
}

export function parseWaitingForInputPayload(raw: unknown): WaitingForInputEventPayload {
  if (!raw || typeof raw !== "object") return { count: 0, active: false };
  const count = (raw as { count?: unknown }).count;
  const n = typeof count === "number" && Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
  return { count: n, active: n > 0 };
}

export function buildReportAgentRequest(
  paneId: string,
  state: HerdrReportState,
  seq: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
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
): Record<string, unknown> {
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
): Record<string, unknown> {
  return {
    id: `${HERDR_REPORT_SOURCE}:notify:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    method: "notification.show",
    params: { title, sound },
  };
}

/** Latest-wins queue slot used by the official hook. */
export function enqueueLatest<T>(queued: T | undefined, next: T): T {
  return next;
}

type QueuedState = {
  state: HerdrReportState;
  message?: string;
  extra?: Record<string, unknown>;
  seq: number;
};

let reportSeq = Date.now() * 1000;
let sendInFlight = false;
let queuedState: QueuedState | undefined;
let lastMarkDoneAt = 0;
const busySessions = new Set<string>();

function nextReportSeq(): number {
  reportSeq += 1;
  return reportSeq;
}

function sessionFieldsFrom(ctx: unknown): Record<string, unknown> {
  const sessionManager = (ctx as { sessionManager?: { getSessionFile?: () => unknown; getSessionId?: () => unknown } })
    ?.sessionManager;
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

export function sendRequestAttempt(
  request: unknown,
  timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  if (!herdrBridgeEnabled(env)) return Promise.resolve(true);
  const path = env.HERDR_SOCKET_PATH!.trim();
  const endpoint = socketEndpoint(path);

  return new Promise((resolve) => {
    let done = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (delivered: boolean) => {
      if (done) return;
      done = true;
      if (timeout) clearTimeout(timeout);
      socket.destroy();
      resolve(delivered);
    };

    const socket = net.createConnection(endpoint);
    socket.on("error", () => finish(false));
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", () => finish(true));
    socket.on("end", () => finish(false));
    timeout = setTimeout(() => finish(false), timeoutMs);
    timeout.unref?.();
  });
}

async function sendRequest(request: unknown): Promise<void> {
  if (await sendRequestAttempt(request, 500)) return;
  await sendRequestAttempt(request, 1500);
}

function sendState(
  state: HerdrReportState,
  message: string | undefined,
  seq: number,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const paneId = resolveHerdrPaneId();
  if (!paneId) return Promise.resolve();
  return sendRequest(
    buildReportAgentRequest(paneId, state, seq, {
      ...extra,
      ...(message ? { message } : {}),
    }),
  );
}

async function drainStateQueue(): Promise<void> {
  if (sendInFlight) return;
  sendInFlight = true;
  try {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await sendState(next.state, next.message, next.seq, next.extra ?? {});
    }
  } finally {
    sendInFlight = false;
    if (queuedState) void drainStateQueue();
  }
}

function queueState(state: HerdrReportState, message?: string, extra: Record<string, unknown> = {}): void {
  queuedState = enqueueLatest(queuedState, { state, message, extra, seq: nextReportSeq() });
  if (!sendInFlight) void drainStateQueue();
}

const herdrReportExtension: ExtensionFactory = (pi) => {
  if (!herdrBridgeEnabled()) return;

  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: HerdrReportState | undefined;
  let lastMessage: string | undefined;
  let rootSession = false;
  let sessionKey: string | undefined;
  let sessionExtra: Record<string, unknown> = {};

  function rememberSession(ctx: unknown): void {
    sessionExtra = sessionFieldsFrom(ctx);
    sessionKey =
      (sessionExtra.agent_session_path as string | undefined) ??
      (sessionExtra.agent_session_id as string | undefined);
  }

  function publishState(force = false): void {
    const next = {
      state: desiredBusy(busySessions.size, blockedCount),
      message: blockedCount > 0 ? blockedMessage : undefined,
    };
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queueState(next.state, next.message, sessionExtra);
  }

  async function reportSession(sessionStartSource?: string): Promise<void> {
    const paneId = resolveHerdrPaneId();
    const extra = { ...sessionExtra };
    if (!paneId || Object.keys(extra).length === 0) return;
    if (sessionStartSource) extra.session_start_source = sessionStartSource;
    await sendRequest(buildReportAgentSessionRequest(paneId, nextReportSeq(), extra));
  }

  pi.events.on(WAITING_FOR_INPUT_EVENT, (raw: unknown) => {
    if (!rootSession) return;
    const payload = parseWaitingForInputPayload(raw);
    blockedCount = payload.count;
    if (blockedCount === 0) blockedMessage = undefined;
    else blockedMessage = "waiting for input";
    publishState();
  });

  pi.events.on(MARK_DONE_EVENT, () => {
    if (!rootSession) return;
    const now = Date.now();
    if (now - lastMarkDoneAt < 100) return;
    lastMarkDoneAt = now;
    void sendRequest(buildNotificationShowRequest("Marked done", "done"));
    publishState(true);
  });

  pi.on("session_start", (event: SessionStartEvent, ctx: ExtensionContext) => {
    if (ctx.mode !== "tui") return;
    rootSession = true;
    rememberSession(ctx);
    void reportSession(event.reason).then(() => {
      if (sessionKey && ctx.isIdle() === false) busySessions.add(sessionKey);
      else if (sessionKey) busySessions.delete(sessionKey);
      publishState(true);
    });
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!rootSession) return;
    rememberSession(ctx);
    void reportSession();
    if (sessionKey) busySessions.add(sessionKey);
    publishState();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (!rootSession || !shouldClearAgentActive(ctx.isIdle())) return;
    if (sessionKey) busySessions.delete(sessionKey);
    publishState();
  });
};

export default herdrReportExtension;
