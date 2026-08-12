import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildHerdrNotificationArgs,
  buildHerdrReleaseAgentArgs,
  buildHerdrReportAgentArgs,
  buildHerdrReportAgentSessionArgs,
  deriveHerdrState,
  HERDR_HEARTBEAT_MS,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  isMixcodeProcess,
  MARK_DONE_EVENT,
  parseWaitingForInputPayload,
  resolveHerdrPaneId,
  shouldThrottleSpawnError,
  SPAWN_ERROR_THROTTLE_MS,
  startHerdrHeartbeat,
  stopHerdrHeartbeat,
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

test("resolveHerdrPaneId requires MIXCODE and HERDR pane env", () => {
  assert.equal(resolveHerdrPaneId({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }), undefined);
  assert.equal(
    resolveHerdrPaneId({ MIXCODE: "1", HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }),
    "w1:p1",
  );
  assert.equal(resolveHerdrPaneId({ MIXCODE: "1", HERDR_ENV: "1" }), undefined);
});

test("report source is mpi (custom:mpi is ignored by Herdr pane ownership)", () => {
  assert.equal(HERDR_REPORT_SOURCE, "mpi");
  assert.equal(HERDR_REPORT_AGENT, "mpi");
});

test("buildHerdrReleaseAgentArgs drops ownership on exit", () => {
  assert.deepEqual(buildHerdrReleaseAgentArgs("w1:p1", 9), [
    "pane",
    "release-agent",
    "w1:p1",
    "--source",
    "mpi",
    "--agent",
    "mpi",
    "--seq",
    "9",
  ]);
});

test("buildHerdrReportAgentSessionArgs claims the pane agent", () => {
  assert.deepEqual(buildHerdrReportAgentSessionArgs("w1:p1", 3), [
    "pane",
    "report-agent-session",
    "w1:p1",
    "--source",
    "mpi",
    "--agent",
    "mpi",
    "--seq",
    "3",
  ]);
});

test("deriveHerdrState: blocked wins over working", () => {
  assert.equal(deriveHerdrState(2, 1), "blocked");
  assert.equal(deriveHerdrState(0, 1), "blocked");
  assert.equal(deriveHerdrState(1, 0), "working");
  assert.equal(deriveHerdrState(0, 0), "idle");
});

test("buildHerdrReportAgentArgs includes blocked state", () => {
  const args = buildHerdrReportAgentArgs("pane-1", "blocked", 42);
  assert.deepEqual(args, [
    "pane",
    "report-agent",
    "pane-1",
    "--source",
    HERDR_REPORT_SOURCE,
    "--agent",
    HERDR_REPORT_AGENT,
    "--state",
    "blocked",
    "--seq",
    "42",
  ]);
});

test("buildHerdrNotificationArgs uses done sound", () => {
  assert.deepEqual(buildHerdrNotificationArgs("Marked done", "done"), [
    "notification",
    "show",
    "Marked done",
    "--sound",
    "done",
  ]);
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

test("heartbeat interval is a fixed low-frequency reclaim period", () => {
  assert.equal(HERDR_HEARTBEAT_MS, 45_000);
  assert.ok(HERDR_HEARTBEAT_MS >= 30_000);
  assert.ok(HERDR_HEARTBEAT_MS <= 60_000);
});

test("shouldThrottleSpawnError enforces gap after first error", () => {
  assert.equal(shouldThrottleSpawnError(0, 1000), false);
  assert.equal(shouldThrottleSpawnError(1000, 1000 + SPAWN_ERROR_THROTTLE_MS - 1), true);
  assert.equal(shouldThrottleSpawnError(1000, 1000 + SPAWN_ERROR_THROTTLE_MS), false);
});

test("startHerdrHeartbeat no-ops without MIXCODE/HERDR pane env", () => {
  const prev = {
    MIXCODE: process.env.MIXCODE,
    HERDR_ENV: process.env.HERDR_ENV,
    HERDR_PANE_ID: process.env.HERDR_PANE_ID,
  };
  try {
    delete process.env.MIXCODE;
    delete process.env.HERDR_ENV;
    delete process.env.HERDR_PANE_ID;
    stopHerdrHeartbeat();
    startHerdrHeartbeat({});
    // Second call must stay a no-op even if env appears later on process.env only
    // for the default arg path — explicit empty env stays idle.
    startHerdrHeartbeat({});
    stopHerdrHeartbeat();
  } finally {
    if (prev.MIXCODE === undefined) delete process.env.MIXCODE;
    else process.env.MIXCODE = prev.MIXCODE;
    if (prev.HERDR_ENV === undefined) delete process.env.HERDR_ENV;
    else process.env.HERDR_ENV = prev.HERDR_ENV;
    if (prev.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID;
    else process.env.HERDR_PANE_ID = prev.HERDR_PANE_ID;
    stopHerdrHeartbeat();
  }
});
