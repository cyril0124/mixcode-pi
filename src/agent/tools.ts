import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  type AgentSession,
  type BashOperations,
  createBashTool,
  createBashToolDefinition,
  createEditTool,
  createEditToolDefinition,
  createLocalBashOperations,
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

/** Default timeout (seconds) applied when the AI does not specify one. */
export const BASH_DEFAULT_TIMEOUT_SECONDS = 300;

export type PiBuiltinToolName = "read" | "bash" | "edit" | "write" | "ls";

export const PI_BUILTIN_TOOL_NAMES: PiBuiltinToolName[] = ["read", "bash", "edit", "write", "ls"];

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

/**
 * Wrap BashOperations to enforce a default timeout when the caller omits one.
 */
function withDefaultTimeout(ops: BashOperations): BashOperations {
  return {
    exec: (command, cwd, options) => {
      const timeout = options.timeout ?? BASH_DEFAULT_TIMEOUT_SECONDS;
      return ops.exec(command, cwd, { ...options, timeout });
    },
  };
}

function createPiBuiltinTools(agentSession: AgentSession): Record<PiBuiltinToolName, AgentTool> {
  const writableSession = agentSession as unknown as AgentSessionToolInternals;
  const cwd = writableSession._cwd;
  const settings = agentSession.settingsManager;
  const bashOps = withDefaultTimeout(
    createLocalBashOperations({ shellPath: settings.getShellPath() }),
  );
  return {
    read: createReadTool(cwd, { autoResizeImages: settings.getImageAutoResize() }),
    bash: createBashTool(cwd, {
      operations: bashOps,
      commandPrefix: settings.getShellCommandPrefix(),
      shellPath: settings.getShellPath(),
    }),
    edit: createEditTool(cwd),
    write: createWriteTool(cwd),
    ls: createLsTool(cwd),
  };
}

function patchBashDefinition(definition: AnyToolDefinition): AnyToolDefinition {
  // Patch the schema property description so the AI sees the actual default.
  const timeoutProp = definition.parameters?.properties?.timeout;
  if (timeoutProp) {
    timeoutProp.description = `Timeout in seconds (default: ${BASH_DEFAULT_TIMEOUT_SECONDS}s if omitted)`;
  }
  // Patch renderCall so the UI always shows the effective timeout.
  const originalRenderCall = definition.renderCall;
  if (originalRenderCall) {
    definition.renderCall = (args, theme, context) => {
      const argsObj = (args ?? {}) as Record<string, unknown>;
      const patched = {
        ...argsObj,
        timeout: argsObj.timeout ?? BASH_DEFAULT_TIMEOUT_SECONDS,
      } as Parameters<typeof originalRenderCall>[0];
      return originalRenderCall(patched, theme, context);
    };
  }
  return definition;
}

function createPiBuiltinToolDefinitions(
  agentSession: AgentSession,
): Record<PiBuiltinToolName, AnyToolDefinition> {
  const writableSession = agentSession as unknown as AgentSessionToolInternals;
  const cwd = writableSession._cwd;
  const settings = agentSession.settingsManager;
  const bashOps = withDefaultTimeout(
    createLocalBashOperations({ shellPath: settings.getShellPath() }),
  );
  return {
    read: createReadToolDefinition(cwd, { autoResizeImages: settings.getImageAutoResize() }),
    bash: patchBashDefinition(
      createBashToolDefinition(cwd, {
        operations: bashOps,
        commandPrefix: settings.getShellCommandPrefix(),
        shellPath: settings.getShellPath(),
      }),
    ),
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
