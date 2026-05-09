import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createFindTool,
  createFindToolDefinition,
  createGrepTool,
  createGrepToolDefinition,
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

export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "grep" | "find" | "ls";

export const PI_BUILTIN_TOOL_NAMES: PiBuiltinToolName[] = [
  "read",
  "bash",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
];

type AnyToolDefinition = ToolDefinition<any, any, any>;

export function activateMixCodeTools(agentSession: AgentSession): void {
  restorePiBuiltinTools(agentSession);
  agentSession.setActiveToolsByName([
    ...new Set([...agentSession.getActiveToolNames(), ...PI_BUILTIN_TOOL_NAMES]),
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

function restorePiBuiltinTools(agentSession: AgentSession): void {
  const writableSession = agentSession as unknown as AgentSessionToolInternals;
  const definitions = createPiBuiltinToolDefinitions(agentSession);
  for (const [name, tool] of Object.entries(createPiBuiltinTools(agentSession))) {
    const definition = definitions[name as PiBuiltinToolName];
    writableSession._toolDefinitions.set(name, {
      definition,
      sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
    });
    writableSession._toolRegistry.set(name, tool);
    updateToolPromptMetadata(writableSession, definition);
  }
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
    grep: createGrepTool(cwd),
    find: createFindTool(cwd),
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
    grep: createGrepToolDefinition(cwd),
    find: createFindToolDefinition(cwd),
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
