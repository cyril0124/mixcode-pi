import type { AgentSession, ToolInfo } from "@earendil-works/pi-coding-agent";

export const PI_BUILTIN_TOOL_NAMES = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
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
 * Ownership is pi's refresh order (extension definitions overwrite builtins by name).
 *
 * The baseline is pi's `defaultTools` setting when configured, so a narrowed list (e.g.
 * one without `write`) stays narrowed; an unset setting keeps pi's built-in default set.
 */
export function activateMixCodeTools(agentSession: AgentSession): void {
  const allTools = agentSession.getAllTools();
  const configuredToolNames = new Set(allTools.map((tool) => tool.name));
  const configuredDefaults = agentSession.settingsManager.getDefaultTools();
  const defaultActiveToolNames = (configuredDefaults ?? PI_DEFAULT_ACTIVE_TOOL_NAMES).filter(
    (name) => configuredToolNames.has(name),
  );
  const activeToolNames = new Set([
    ...agentSession.getActiveToolNames(),
    ...defaultActiveToolNames,
  ]);
  if (configuredDefaults) {
    // Pi keeps extension-owned tools active whatever `defaultTools` says, so only pi
    // builtins and MixCode's own sdk customTools follow the setting here. The `bash`
    // wrapper is one of those customTools, which is why pi cannot apply the setting to
    // it on its own.
    const hostOwned = new Set(
      allTools
        .filter(
          (tool) => tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk",
        )
        .map((tool) => tool.name),
    );
    for (const name of PI_BUILTIN_TOOL_NAMES) {
      if (hostOwned.has(name) && !configuredDefaults.includes(name)) {
        activeToolNames.delete(name);
      }
    }
  }
  agentSession.setActiveToolsByName([...activeToolNames]);
}

export function getActiveToolInfos(agentSession: AgentSession): ToolInfo[] {
  const activeNames = new Set(agentSession.getActiveToolNames());
  return agentSession.getAllTools().filter((tool) => activeNames.has(tool.name));
}
