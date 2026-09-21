import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
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
 * Restore recorded active tools through the current registry. A system checkpoint
 * with no tools is an explicit empty selection; histories without system messages
 * have no tool state to restore. Unknown or excluded tools stay unavailable.
 *
 * When syncing an existing session, pass its previous messages. Unchanged recorded
 * tool names leave local, not-yet-sent choices intact. Returns whether the current
 * history has a checkpoint, even when no update was needed. Does not write history.
 */
export function restoreTranscriptTools(
  agentSession: AgentSession,
  previousMessages?: readonly AgentMessage[],
): boolean {
  const current = getCurrentSystemMessage(agentSession.messages);
  if (!current) return false;

  const toolNames = (current.toolsAdded ?? []).map((tool) => tool.name);
  if (previousMessages) {
    const previous = getCurrentSystemMessage(previousMessages);
    const previousNames = new Set(previous?.toolsAdded?.map((tool) => tool.name));
    if (
      previous &&
      previousNames.size === toolNames.length &&
      toolNames.every((name) => previousNames.has(name))
    ) {
      return true;
    }
  }

  // The public setter resolves names against registered, allowed implementations
  // and rebuilds prompt contributions; declarations never supply executable code.
  agentSession.setActiveToolsByName(toolNames);
  return true;
}

/**
 * Initialize tools before session_start: restore a recorded selection, or seed
 * host-owned tools from defaultTools when the history has no system checkpoint.
 * Extensions may then apply current policy, including an empty selection.
 *
 * An unset defaultTools uses Pi's default built-in set. A configured list,
 * including [], seeds host-owned built-ins without disabling extension overrides.
 * Defaults do not replace explicit selections recorded by an existing session.
 */
export function activateMixCodeTools(agentSession: AgentSession): void {
  if (restoreTranscriptTools(agentSession)) return;
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
