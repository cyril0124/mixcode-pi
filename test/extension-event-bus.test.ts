import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "bun:test";
import {
  adjustWaitingForInput,
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
  adjustWaitingForInput(-100);
});

test("adjustWaitingForInput fans out mpi:waiting-for-input on all registered buses", () => {
  registerExtensionEventBus(servicesA, busA);
  registerExtensionEventBus(servicesB, busB);

  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  busA.on(WAITING_FOR_INPUT_EVENT, (data) => seenA.push(data));
  busB.on(WAITING_FOR_INPUT_EVENT, (data) => seenB.push(data));

  adjustWaitingForInput(1);
  assert.deepEqual(seenA, [{ count: 1, active: true }]);
  assert.deepEqual(seenB, [{ count: 1, active: true }]);

  adjustWaitingForInput(1);
  adjustWaitingForInput(-1);
  assert.deepEqual(seenA.at(-1), { count: 1, active: true });

  adjustWaitingForInput(-1);
  assert.deepEqual(seenA.at(-1), { count: 0, active: false });
  assert.deepEqual(seenB.at(-1), { count: 0, active: false });
});

test("unregistered bus no longer receives waiting events", () => {
  registerExtensionEventBus(servicesA, busA);
  const seen: unknown[] = [];
  busA.on(WAITING_FOR_INPUT_EVENT, (data) => seen.push(data));

  adjustWaitingForInput(1);
  assert.equal(seen.length, 1);

  unregisterExtensionEventBus(servicesA);
  adjustWaitingForInput(1);
  assert.equal(seen.length, 1);
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
