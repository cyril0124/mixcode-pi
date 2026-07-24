import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createLsTool,
  createLsToolDefinition,
  createReadTool,
  createReadToolDefinition,
  createSyntheticSourceInfo,
  createWriteTool,
  createWriteToolDefinition,
  type SourceInfo,
  type ToolDefinition,
  type ToolInfo,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionToolOwnerPolicy } from "../core/extension-tool-owners.js";

export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "ls";

export const PI_BUILTIN_TOOL_NAMES: PiBuiltinToolName[] = ["read", "bash", "edit", "write", "ls"];
// Match pi-coding-agent default active tools (sdk.js / AgentSession._buildRuntime).
// grep/find/ls remain registered via createAllToolDefinitions but are inactive unless
// the user/extension enables them.
const PI_DEFAULT_ACTIVE_TOOL_NAMES = ["read", "bash", "edit", "write"];

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function activateMixCodeTools(
  agentSession: AgentSession,
  extensionToolOwnerPolicy?: ExtensionToolOwnerPolicy,
): void {
  // Restore builtin definitions (including ls for owner-shadow policy) without
  // force-activating tools that pi leaves inactive by default.
  restorePiBuiltinTools(agentSession, extensionToolOwnerPolicy);
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

type AgentSessionToolInternals = {
  _cwd: string;
  _toolDefinitions: Map<string, { definition: AnyToolDefinition; sourceInfo: SourceInfo }>;
  _toolRegistry: Map<string, AgentTool>;
  _toolPromptGuidelines: Map<string, string[]>;
  _toolPromptSnippets: Map<string, string>;
};

function restorePiBuiltinTools(
  agentSession: AgentSession,
  extensionToolOwnerPolicy?: ExtensionToolOwnerPolicy,
): PiBuiltinToolName[] {
  const writableSession = agentSession as unknown as AgentSessionToolInternals;
  const definitions = createPiBuiltinToolDefinitions(agentSession);
  const sourceInfoByName = new Map(
    agentSession.getAllTools().map((tool) => [tool.name, tool.sourceInfo] as const),
  );
  const restoredBuiltinNames: PiBuiltinToolName[] = [];
  for (const [name, tool] of Object.entries(createPiBuiltinTools(agentSession))) {
    const builtinName = name as PiBuiltinToolName;
    if (extensionToolOwnerPolicy?.(sourceInfoByName.get(name), builtinName)) continue;

    const definition = definitions[builtinName];
    writableSession._toolDefinitions.set(name, {
      definition,
      sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
    });
    writableSession._toolRegistry.set(name, tool);
    updateToolPromptMetadata(writableSession, definition);
    restoredBuiltinNames.push(builtinName);
  }
  return restoredBuiltinNames;
}

function createPiBuiltinTools(agentSession: AgentSession): Record<PiBuiltinToolName, AgentTool> {
  const writableSession = agentSession as unknown as AgentSessionToolInternals;
  const cwd = writableSession._cwd;
  const settings = agentSession.settingsManager;
  return {
    read: createReadTool(cwd, { autoResizeImages: settings.getImageAutoResize() }),
    bash: createBashTool(cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    }),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    ls: createLsTool(cwd),
  };
}

function createPiBuiltinToolDefinitions(
  agentSession: AgentSession,
): Record<PiBuiltinToolName, AnyToolDefinition> {
  const writableSession = agentSession as unknown as AgentSessionToolInternals;
  const cwd = writableSession._cwd;
  const settings = agentSession.settingsManager;
  return {
    read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
    bash: createBashToolDefinition(cwd, {
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    }),
    edit: createEditToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    ls: createLsToolDefinition(cwd),
  };
}

function updateToolPromptMetadata(
  agentSession: AgentSessionToolInternals,
  definition: AnyToolDefinition,
): void {
  if (definition.promptSnippet)
    agentSession._toolPromptSnippets.set(definition.name, definition.promptSnippet);
  else agentSession._toolPromptSnippets.delete(definition.name);
  if (definition.promptGuidelines?.length)
    agentSession._toolPromptGuidelines.set(definition.name, definition.promptGuidelines);
  else agentSession._toolPromptGuidelines.delete(definition.name);
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
