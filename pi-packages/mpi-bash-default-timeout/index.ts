import type { ExtensionFactory, ToolCallEvent } from "@earendil-works/pi-coding-agent";

export const BASH_DEFAULT_TIMEOUT_SECONDS = 300;

const SYSTEM_PROMPT_NOTE = `The bash tool applies a default timeout of ${BASH_DEFAULT_TIMEOUT_SECONDS} seconds when the timeout argument is omitted.`;

const bashDefaultTimeoutExtension: ExtensionFactory = (pi) => {
  pi.on("tool_call", (event: ToolCallEvent) => {
    if (event.toolName !== "bash") return;
    event.input.timeout ??= BASH_DEFAULT_TIMEOUT_SECONDS;
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: appendBashDefaultTimeoutNote(event.systemPrompt),
  }));
};

export function appendBashDefaultTimeoutNote(systemPrompt: string): string {
  if (systemPrompt.includes(SYSTEM_PROMPT_NOTE)) return systemPrompt;
  return `${systemPrompt}\n\n${SYSTEM_PROMPT_NOTE}`;
}

export default bashDefaultTimeoutExtension;
