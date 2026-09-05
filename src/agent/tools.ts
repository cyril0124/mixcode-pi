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
 * Initialize host-owned tools from defaultTools before binding extensions.
 * Call before session_start; later calls overwrite extension selections,
 * including empty sets. Updates active tools and rebuilds the system prompt
 * in memory using Pi's registered tool implementations and ownership rules.
 *
 * An unset defaultTools uses Pi's default built-in set. A configured list,
 * including [], restricts host-owned built-ins without disabling extension overrides.
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
