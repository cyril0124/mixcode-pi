import type { AgentSession, ToolInfo } from "@earendil-works/pi-coding-agent";
import type { ExtensionToolOwnerPolicy } from "../core/extension-tool-owners.js";

export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "ls";

export const PI_BUILTIN_TOOL_NAMES: PiBuiltinToolName[] = ["read", "bash", "edit", "write", "ls"];
// Match pi-coding-agent default active tools (sdk.js / AgentSession._buildRuntime).
// grep/find/ls remain registered via createAllToolDefinitions but are inactive unless
// the user/extension enables them.
const PI_DEFAULT_ACTIVE_TOOL_NAMES = ["read", "bash", "edit", "write"];

/**
 * Ensure MixCode's default active tool set without re-creating bare builtins.
 *
 * AgentSession already registers builtins via _buildRuntime → wrapRegisteredTools
 * (ExtensionContext for PI_SESSION_ID / model / …). Extension registerTool() also
 * calls refreshTools(). Re-creating createXxxTool() here used to drop that wrap.
 *
 * extensionToolOwnerPolicy is kept in the signature for call-site stability; owner
 * diagnostics still consume it elsewhere. Ownership itself is pi's refresh order
 * (extension definitions overwrite builtins by name).
 */
export function activateMixCodeTools(
  agentSession: AgentSession,
  _extensionToolOwnerPolicy?: ExtensionToolOwnerPolicy,
): void {
  const configuredToolNames = new Set(agentSession.getAllTools().map((tool) => tool.name));
  const defaultActiveToolNames = PI_DEFAULT_ACTIVE_TOOL_NAMES.filter((name) =>
    configuredToolNames.has(name),
  );
  agentSession.setActiveToolsByName([
    ...new Set([...agentSession.getActiveToolNames(), ...defaultActiveToolNames]),
  ]);
}

export function getActiveToolInfos(agentSession: AgentSession): ToolInfo[] {
  const activeNames = new Set(agentSession.getActiveToolNames());
  return agentSession.getAllTools().filter((tool) => activeNames.has(tool.name));
}

export interface ToolExecutionRecord {
  tool: string;
  args: unknown;
  isError: boolean;
  output: string;
}

export class ToolLog {
  readonly records: ToolExecutionRecord[] = [];

  append(record: ToolExecutionRecord): void {
    this.records.push(record);
  }
}
