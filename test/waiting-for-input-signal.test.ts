import assert from "node:assert/strict";
import { createEventBus } from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "bun:test";
import {
  adjustWaitingForInput,
  getWaitingForInputCount,
  registerExtensionEventBus,
  unregisterExtensionEventBus,
  WAITING_FOR_INPUT_EVENT,
} from "../src/core/waiting-for-input-signal.js";

const servicesA = { id: "a" };
const servicesB = { id: "b" };
const busA = createEventBus();
const busB = createEventBus();

afterEach(() => {
  // Drain count and unregister test buses so other tests stay isolated.
  const n = getWaitingForInputCount();
  if (n) adjustWaitingForInput(-n);
  unregisterExtensionEventBus(busA);
  unregisterExtensionEventBus(busB);
});

test("adjustWaitingForInput fans out mpi:waiting-for-input on all registered buses", () => {
  registerExtensionEventBus(servicesA, busA);
  registerExtensionEventBus(servicesB, busB);

  const seenA: unknown[] = [];
  const seenB: unknown[] = [];
  busA.on(WAITING_FOR_INPUT_EVENT, (data) => seenA.push(data));
  busB.on(WAITING_FOR_INPUT_EVENT, (data) => seenB.push(data));

  adjustWaitingForInput(1);
  assert.equal(getWaitingForInputCount(), 1);
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

  unregisterExtensionEventBus(busA);
  adjustWaitingForInput(1);
  assert.equal(seen.length, 1); // no new event

  adjustWaitingForInput(-2); // reset count
});
