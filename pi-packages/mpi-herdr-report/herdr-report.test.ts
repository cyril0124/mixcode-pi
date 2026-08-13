import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildNotificationShowRequest,
  buildReportAgentRequest,
  buildReportAgentSessionRequest,
  desiredBusy,
  desiredState,
  enqueueLatest,
  herdrBridgeEnabled,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  isMixcodeProcess,
  MARK_DONE_EVENT,
  parseWaitingForInputPayload,
  resolveHerdrPaneId,
  shouldClearAgentActive,
  socketEndpoint,
  WAITING_FOR_INPUT_EVENT,
} from "./index.ts";

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
  assert.equal(herdrBridgeEnabled({ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/s", HERDR_PANE_ID: "w1:p1" }), false);
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

test("desiredBusy stays working while any session is busy", () => {
  assert.equal(desiredBusy(2, 0), "working");
  assert.equal(desiredBusy(1, 0), "working");
  assert.equal(desiredBusy(0, 0), "idle");
  assert.equal(desiredBusy(0, 1), "blocked");
});

test("shouldClearAgentActive matches official isIdle gate", () => {
  assert.equal(shouldClearAgentActive(true), true);
  assert.equal(shouldClearAgentActive(false), false);
  assert.equal(shouldClearAgentActive(undefined), false);
});

test("enqueueLatest keeps only the newest slot", () => {
  assert.deepEqual(enqueueLatest(undefined, { state: "working", seq: 1 }), { state: "working", seq: 1 });
  assert.deepEqual(
    enqueueLatest({ state: "working", seq: 1 }, { state: "idle", seq: 2 }),
    { state: "idle", seq: 2 },
  );
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
  assert.deepEqual(parseWaitingForInputPayload({ count: 2, active: true }), {
    count: 2,
    active: true,
  });
  assert.deepEqual(parseWaitingForInputPayload({ count: -3 }), { count: 0, active: false });
  assert.deepEqual(parseWaitingForInputPayload(null), { count: 0, active: false });
  assert.deepEqual(parseWaitingForInputPayload({ count: 1.9 }), { count: 1, active: true });
});
