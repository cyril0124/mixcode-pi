import type { RuntimeTab } from "../../src/agent/runtime.js";

/**
 * Deep-partial RuntimeTab shape: `agentSession` and `session` are themselves
 * large objects, so they get their own `Partial` instead of forcing a test to
 * build a whole AgentSession/SessionManager.
 */
export type RuntimeTabStub = Partial<Omit<RuntimeTab, "agentSession" | "session">> & {
  agentSession?: Partial<RuntimeTab["agentSession"]>;
  session?: Partial<RuntimeTab["session"]>;
};

/**
 * Test double for a runtime tab. Member names and signatures are checked
 * against the real `RuntimeTab`, so a stub only satisfies the type when it
 * carries the fields production reads (e.g. `agentSession.isStreaming`).
 */
export function testRuntimeTab(stub: RuntimeTabStub): RuntimeTab {
  return stub as RuntimeTab;
}
