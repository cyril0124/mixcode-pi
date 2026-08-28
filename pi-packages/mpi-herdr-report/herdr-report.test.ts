import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "bun:test";
import {
  applyAgentSettled,
  applyAgentStart,
  applySessionShutdown,
  applySessionStart,
  applyWaitingCount,
  createHerdrLedger,
  ledgerState,
  releaseSession,
  retainSession,
  buildNotificationShowRequest,
  buildReportAgentRequest,
  buildReportAgentSessionRequest,
  desiredState,
  herdrBridgeEnabled,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  isMixcodeProcess,
  isStaleCtxError,
  MARK_DONE_EVENT,
  parseWaitingForInputPayload,
  readCtxIdle,
  resolveHerdrPaneId,
  sessionKeyFrom,
  socketEndpoint,
  WAITING_FOR_INPUT_EVENT,
} from "./index.js";

test("isMixcodeProcess requires MIXCODE truthy", () => {
  assert.equal(isMixcodeProcess({}), false);
  assert.equal(isMixcodeProcess({ MIXCODE: "" }), false);
  assert.equal(isMixcodeProcess({ MIXCODE: "0" }), false);
  assert.equal(isMixcodeProcess({ MIXCODE: "false" }), false);
  assert.equal(isMixcodeProcess({ MIXCODE: "off" }), false);
  assert.equal(isMixcodeProcess({ MIXCODE: "1" }), true);
  assert.equal(isMixcodeProcess({ MIXCODE: "true" }), true);
  assert.equal(isMixcodeProcess({ MIXCODE: "yes" }), true);
});

test("herdrBridgeEnabled requires MIXCODE plus herdr pane env", () => {
  assert.equal(
    herdrBridgeEnabled({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" }),
    false,
  );
  assert.equal(
    herdrBridgeEnabled({
      MIXCODE: "1",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/s",
      HERDR_PANE_ID: "w1:p1",
    }),
    true,
  );
  assert.equal(herdrBridgeEnabled({ MIXCODE: "1", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), false);
});

test("resolveHerdrPaneId requires full bridge env", () => {
  assert.equal(resolveHerdrPaneId({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), undefined);
  assert.equal(
    resolveHerdrPaneId({
      MIXCODE: "1",
      HERDR_ENV: "1",
      HERDR_SOCKET_PATH: "/s",
      HERDR_PANE_ID: "w1:p1",
    }),
    "w1:p1",
  );
});

test("MIXCODE on reports mpi identity", () => {
  assert.equal(HERDR_REPORT_SOURCE, "mpi");
  assert.equal(HERDR_REPORT_AGENT, "mpi");
});

test("desiredState: blocked wins over working", () => {
  assert.equal(desiredState(true, 1), "blocked");
  assert.equal(desiredState(false, 1), "blocked");
  assert.equal(desiredState(true, 0), "working");
  assert.equal(desiredState(false, 0), "idle");
});

test("readCtxIdle swallows only session-replacement stale errors", () => {
  assert.equal(
    readCtxIdle({
      isIdle: () => {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      },
    }),
    undefined,
  );
  assert.equal(
    isStaleCtxError(new Error("This extension ctx is stale after session replacement")),
    true,
  );
  assert.throws(
    () =>
      readCtxIdle({
        isIdle: () => {
          throw new Error("disk is read-only");
        },
      }),
    /disk is read-only/,
  );
});

test("busy ledger survives resume without undoing a later agent_start", () => {
  const busy = new Set<string>();
  assert.equal(sessionKeyFrom({ agent_session_id: "old" }), "old");
  applySessionStart(busy, "old", false);
  applySessionShutdown(busy, "old");
  assert.equal(busy.size, 0);

  applySessionStart(busy, "new", true);
  assert.equal(busy.size, 0);
  applyAgentStart(busy, "new");
  assert.deepEqual([...busy], ["new"]);

  applyAgentSettled(busy, "new", false);
  assert.deepEqual([...busy], ["new"]);
  applyAgentSettled(busy, "new", undefined);
  assert.deepEqual([...busy], ["new"]);
  applyAgentSettled(busy, "new", true);
  assert.equal(busy.size, 0);
});

test("last session release clears blocked so exit cannot stick", () => {
  const ledger = createHerdrLedger();
  retainSession(ledger);
  retainSession(ledger);
  applyWaitingCount(ledger, 2);
  applyAgentStart(ledger.busy, "a");
  assert.equal(ledgerState(ledger), "blocked");
  assert.equal(releaseSession(ledger, "a"), false);
  assert.equal(ledgerState(ledger), "blocked");
  assert.equal(releaseSession(ledger, "b"), true);
  assert.equal(ledger.blocked, 0);
  assert.equal(ledger.busy.size, 0);
  assert.equal(ledgerState(ledger), "idle");
});

test("buildReportAgentRequest is official socket shape with mpi labels", () => {
  const req = buildReportAgentRequest("w1:p1", "blocked", 42);
  assert.equal(req.method, "pane.report_agent");
  assert.deepEqual(req.params, {
    pane_id: "w1:p1",
    source: "mpi",
    agent: "mpi",
    state: "blocked",
    seq: 42,
  });
});

test("buildReportAgentSessionRequest claims the pane agent", () => {
  const req = buildReportAgentSessionRequest("w1:p1", 3, { agent_session_id: "s1" });
  assert.equal(req.method, "pane.report_agent_session");
  assert.equal((req.params as { agent: string }).agent, "mpi");
  assert.equal((req.params as { source: string }).source, "mpi");
  assert.equal((req.params as { agent_session_id: string }).agent_session_id, "s1");
});

test("buildNotificationShowRequest uses done sound", () => {
  const req = buildNotificationShowRequest("Marked done", "done");
  assert.equal(req.method, "notification.show");
  assert.deepEqual(req.params, { title: "Marked done", sound: "done" });
});

test("socketEndpoint uses named pipe only on win32", () => {
  assert.equal(socketEndpoint("/tmp/herdr.sock", "linux"), "/tmp/herdr.sock");
  assert.equal(socketEndpoint("herdr.sock", "win32"), "\\\\.\\pipe\\herdr.sock");
});

test("event channel names are stable", () => {
  assert.equal(WAITING_FOR_INPUT_EVENT, "mpi:waiting-for-input");
  assert.equal(MARK_DONE_EVENT, "mpi:mark-done");
});

test("parseWaitingForInputPayload normalizes count", () => {
  assert.deepEqual(parseWaitingForInputPayload({ count: 2, active: true }), { count: 2 });
  assert.deepEqual(parseWaitingForInputPayload({ count: -3 }), { count: 0 });
  assert.deepEqual(parseWaitingForInputPayload(null), { count: 0 });
  assert.deepEqual(parseWaitingForInputPayload({ count: 1.9 }), { count: 1 });
});

test("session_start does not read isIdle after the session ctx is replaced", async () => {
  const { default: herdrReportExtension } = await import("./index.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-herdr-report-stale-"));
  const socketPath = path.join(dir, "herdr.sock");
  const prev = {
    MIXCODE: process.env.MIXCODE,
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  process.env.MIXCODE = "1";
  process.env.HERDR_ENV = "1";
  process.env.HERDR_SOCKET_PATH = socketPath;
  process.env.HERDR_PANE_ID = "w1:p1";

  const reports: Array<{ method?: string; params?: { state?: string } }> = [];
  const server = net.createServer((socket) => {
    socket.on("data", (buf) => {
      for (const line of String(buf).split("\n").filter(Boolean)) {
        reports.push(JSON.parse(line) as (typeof reports)[number]);
      }
      socket.write("{}" + "\n");
      socket.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));

  const rejections: unknown[] = [];
  const onReject = (reason: unknown) => {
    rejections.push(reason);
  };
  process.on("unhandledRejection", onReject);

  let stale = false;
  let sessionStart: ((event: { reason: string }, ctx: unknown) => void) | undefined;
  let sessionShutdown:
    | ((event: { type: string; reason: string }) => void | Promise<void>)
    | undefined;
  let agentStart: ((event: unknown, ctx: unknown) => void) | undefined;
  let waitingForInput: ((raw: unknown) => void) | undefined;
  herdrReportExtension({
    on(event: string, handler: (event: unknown, ctx: unknown) => void) {
      if (event === "session_start") sessionStart = handler as typeof sessionStart;
      if (event === "session_shutdown") sessionShutdown = handler as typeof sessionShutdown;
      if (event === "agent_start") agentStart = handler;
    },
    events: {
      on(event: string, handler: (raw: unknown) => void) {
        if (event === WAITING_FOR_INPUT_EVENT) waitingForInput = handler;
      },
    },
  } as never);

  const ctx = {
    mode: "tui",
    sessionManager: { getSessionId: () => "s1" },
    isIdle() {
      if (stale) {
        throw new Error("This extension ctx is stale after session replacement or reload.");
      }
      return true;
    },
  };

  try {
    assert.ok(sessionStart, "session_start handler must register when herdr is enabled");
    sessionStart!({ reason: "resume" }, ctx);
    stale = true;
    agentStart?.({}, ctx);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(rejections.length, 0, String(rejections[0]));
    const states = reports
      .filter((r) => r.method === "pane.report_agent")
      .map((r) => r.params?.state);
    assert.ok(
      states.includes("working"),
      `expected a working report, got ${JSON.stringify(states)}`,
    );
    assert.notEqual(states.at(-1), "idle");
    waitingForInput?.({ count: 1, active: true });
    await new Promise((resolve) => setTimeout(resolve, 80));
    const blocked = reports
      .filter((r) => r.method === "pane.report_agent")
      .map((r) => r.params?.state);
    assert.equal(blocked.at(-1), "blocked");
    await sessionShutdown?.({ type: "session_shutdown", reason: "quit" });
    assert.equal(rejections.length, 0, String(rejections[0]));
    const afterShutdown = reports
      .filter((r) => r.method === "pane.report_agent")
      .map((r) => r.params?.state);
    assert.equal(afterShutdown.at(-1), "idle");
  } finally {
    process.off("unhandledRejection", onReject);
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
    await fs.rm(dir, { recursive: true, force: true });
    restoreEnv("MIXCODE", prev.MIXCODE);
    restoreEnv("HERDR_ENV", prev.HERDR_ENV);
    restoreEnv("HERDR_SOCKET_PATH", prev.HERDR_SOCKET_PATH);
    restoreEnv("HERDR_PANE_ID", prev.HERDR_PANE_ID);
  }
});

test("process exit spawns a detached herdr CLI agent release", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-herdr-exit-hook-"));
  const log = path.join(dir, "cli.log");
  const fakeCli = path.join(dir, "herdr");
  await fs.writeFile(fakeCli, `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\n`, { mode: 0o755 });
  const childScript = path.join(dir, "child.ts");
  const indexPath = path.join(import.meta.dirname!, "index.ts");
  await fs.writeFile(
    childScript,
    [
      `const { default: factory } = await import(${JSON.stringify(indexPath)});`,
      "factory({ on() {}, events: { on() {} } });",
      "process.exit(0);",
    ].join("\n"),
  );

  try {
    const child = spawn(process.execPath, [childScript], {
      stdio: "ignore",
      env: {
        ...process.env,
        MIXCODE: "1",
        HERDR_ENV: "1",
        HERDR_SOCKET_PATH: path.join(dir, "unused.sock"),
        HERDR_PANE_ID: "w1:p1",
        HERDR_BIN_PATH: fakeCli,
      },
    });
    const exitCode = await new Promise<number | null>((resolve) =>
      child.on("close", (code) => resolve(code)),
    );
    assert.equal(exitCode, 0);

    // The detached CLI child outlives the exiting process; poll for its write.
    let logged = "";
    for (let i = 0; i < 40 && !logged; i++) {
      logged = await fs.readFile(log, "utf8").catch(() => "");
      if (!logged) await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.match(logged, /^pane release-agent w1:p1 --source mpi --agent mpi --seq \d+\n$/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
