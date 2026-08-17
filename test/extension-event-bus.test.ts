import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "bun:test";
import { syncWaitingForInput } from "../src/agent/runtime-extension-custom.js";
import { createTab } from "../src/core/defaults.js";
import {
  setWaitingForInputCount,
  emitMarkDone,
  MARK_DONE_EVENT,
  registerExtensionEventBus,
  unregisterExtensionEventBus,
  WAITING_FOR_INPUT_EVENT,
} from "../src/core/extension-event-bus.js";

const servicesA = { id: "a" };
const servicesB = { id: "b" };
const busA = createEventBus();
const busB = createEventBus();

afterEach(() => {
  unregisterExtensionEventBus(servicesA);
  unregisterExtensionEventBus(servicesB);
  setWaitingForInputCount(0);
});

test("setWaitingForInputCount fans out mpi:waiting-for-input on all registered buses", () => {
  registerExtensionEventBus(servicesA, busA);
  registerExtensionEventBus(servicesB, busB);

  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  busA.on(WAITING_FOR_INPUT_EVENT, (data) => seenA.push(data));
  busB.on(WAITING_FOR_INPUT_EVENT, (data) => seenB.push(data));

  setWaitingForInputCount(1);
  assert.deepEqual(seenA, [{ count: 1, active: true }]);
  assert.deepEqual(seenB, [{ count: 1, active: true }]);

  setWaitingForInputCount(2);
  setWaitingForInputCount(1);
  assert.deepEqual(seenA.at(-1), { count: 1, active: true });

  setWaitingForInputCount(0);
  assert.deepEqual(seenA.at(-1), { count: 0, active: false });
  assert.deepEqual(seenB.at(-1), { count: 0, active: false });
});

test("unregistered bus no longer receives waiting events", () => {
  registerExtensionEventBus(servicesA, busA);
  const seen: unknown[] = [];
  busA.on(WAITING_FOR_INPUT_EVENT, (data) => seen.push(data));

  setWaitingForInputCount(1);
  assert.equal(seen.length, 1);

  unregisterExtensionEventBus(servicesA);
  setWaitingForInputCount(2);
  assert.equal(seen.length, 1);
});

test("syncWaitingForInput publishes the sum across tabs", () => {
  registerExtensionEventBus(servicesA, busA);
  const seen: unknown[] = [];
  busA.on(WAITING_FOR_INPUT_EVENT, (data) => seen.push(data));
  const a = createTab(1, "s1", "/repo");
  const b = createTab(2, "s2", "/repo");
  a.extensionUi.waitingForInputs.push({ id: "1", kind: "custom" });
  b.extensionUi.waitingForInputs.push({ id: "2", kind: "custom" });
  syncWaitingForInput(a);
  syncWaitingForInput(b);
  assert.deepEqual(seen.at(-1), { count: 2, active: true });
  a.extensionUi.waitingForInputs = [];
  syncWaitingForInput(a);
  assert.deepEqual(seen.at(-1), { count: 1, active: true });
  b.extensionUi.waitingForInputs = [];
  syncWaitingForInput(b);
  assert.deepEqual(seen.at(-1), { count: 0, active: false });
});

test("emitMarkDone fans out mpi:mark-done on all registered buses", () => {
  registerExtensionEventBus(servicesA, busA);
  registerExtensionEventBus(servicesB, busB);

  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  busA.on(MARK_DONE_EVENT, (data) => seenA.push(data));
  busB.on(MARK_DONE_EVENT, (data) => seenB.push(data));

  emitMarkDone({ reason: "command" });
  assert.deepEqual(seenA, [{ reason: "command" }]);
  assert.deepEqual(seenB, [{ reason: "command" }]);
});
