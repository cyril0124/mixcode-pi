/**
 * Process-wide fan-out over Pi extension EventBus instances.
 *
 * Each AgentSession services object gets its own EventBus (passed into the
 * resource loader). Host signals are broadcast on every registered bus so
 * multi-tab extension listeners all see the same process-level events.
 */

import type { EventBus } from "@earendil-works/pi-coding-agent";

/** Public pi.events channel for WaitingForInput state. */
export const WAITING_FOR_INPUT_EVENT = "mpi:waiting-for-input" as const;

/** Public pi.events channel for explicit user/agent "mark done" intent. */
export const MARK_DONE_EVENT = "mpi:mark-done" as const;

export interface WaitingForInputEventPayload {
  count: number;
  active: boolean;
}

export interface MarkDoneEventPayload {
  reason: "command";
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
  broadcast(WAITING_FOR_INPUT_EVENT, {
    count: waitingCount,
    active: waitingCount > 0,
  } satisfies WaitingForInputEventPayload);
}

/**
 * Broadcast explicit mark-done (e.g. /mark-done).
 * Callers that want "user can leave the pane first" should delay this (see
 * MARK_DONE_SIGNAL_DELAY_MS in app-submit-ui) — some hosts map done to idle+unseen.
 */
export function emitMarkDone(payload: MarkDoneEventPayload = { reason: "command" }): void {
  broadcast(MARK_DONE_EVENT, payload);
}

function broadcast(channel: string, payload: unknown): void {
  for (const bus of buses) {
    bus.emit(channel, payload);
  }
}
