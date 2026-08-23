import type { MixCodeRuntime } from "../../src/agent/runtime.js";

/**
 * Test double for the MixCodeRuntime surface consumed by key/mouse/command
 * handlers. Only the members a test exercises need to be supplied; the
 * `Partial` parameter type-checks their names and signatures against the real
 * class, so a rename or signature change in production fails at compile time
 * rather than silently no-oping at runtime.
 *
 * Unstubbed members read as `undefined`, so production optional-call sites
 * (`runtime.foo?.()`) behave normally.
 */
export function testRuntime(stub: Partial<MixCodeRuntime>): MixCodeRuntime {
  return stub as MixCodeRuntime;
}
