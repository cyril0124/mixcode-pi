import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  buildHerdrNotificationArgs,
  buildHerdrReleaseAgentArgs,
  buildHerdrReportAgentArgs,
  buildHerdrReportAgentSessionArgs,
  deriveHerdrState,
  HERDR_REPORT_AGENT,
  HERDR_REPORT_SOURCE,
  MARK_DONE_EVENT,
  parseWaitingForInputPayload,
  WAITING_FOR_INPUT_EVENT,
} from "./index.ts";

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
