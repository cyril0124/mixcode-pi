/**
 * Process-wide WaitingForInput fan-out over Pi extension EventBus instances.
 *
 * Each AgentSession services object gets its own EventBus (passed into the
 * resource loader). Waiting changes are broadcast on every registered bus as
 * `mpi:waiting-for-input` so multi-tab extension listeners all recompute.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Public pi.events channel for WaitingForInput state. */
export const WAITING_FOR_INPUT_EVENT = "mpi:waiting-for-input" as const;

export interface WaitingForInputEventPayload {
  count: number;
  active: boolean;
}

const buses = new Set<EventBus>();
const busByServices = new WeakMap<object, EventBus>();
let waitingCount = 0;

/** Register a bus already installed on the resource loader for this services object. */
export function registerExtensionEventBus(services: object, bus: EventBus): void {
  const previous = busByServices.get(services);
  if (previous && previous !== bus) {
    buses.delete(previous);
  }
  buses.add(bus);
  busByServices.set(services, bus);
}

export function extensionEventBusForServices(services: object): EventBus | undefined {
  return busByServices.get(services);
}

export function unregisterExtensionEventBus(bus: EventBus | undefined): void {
  if (!bus) return;
  buses.delete(bus);
}

export function getWaitingForInputCount(): number {
  return waitingCount;
}

/** +1 when a WaitingForInput entry is added, -N when removed. */
export function adjustWaitingForInput(delta: number): void {
  if (delta === 0) return;
  waitingCount = Math.max(0, waitingCount + delta);
  broadcastWaitingForInput();
}

function broadcastWaitingForInput(): void {
  const payload: WaitingForInputEventPayload = {
    count: waitingCount,
    active: waitingCount > 0,
  };
  for (const bus of buses) {
    bus.emit(WAITING_FOR_INPUT_EVENT, payload);
  }
}
