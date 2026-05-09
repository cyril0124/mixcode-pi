import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { TabStatus } from "./types.js";

export function statusFromAgentEvent(event: AgentEvent): TabStatus | undefined {
  switch (event.type) {
    case "agent_start":
      return "running";
    case "turn_start":
      return "thinking";
    case "agent_end":
      return "idle";
    case "tool_execution_end":
      return event.isError ? "error" : "running";
    default:
      return undefined;
  }
}
