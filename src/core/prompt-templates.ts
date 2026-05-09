export function expandLocalPromptCommand(command: string, args: string): string | undefined {
  const trimmed = args.trim();
  switch (command) {
    case "compact":
      return "Compact the current session context using pi-agent-core session history. If exact compaction cannot be performed from available tools, explain the blocker explicitly and do not pretend compaction succeeded.";
    case "undo":
      return "Undo the latest user turn in the current session if pi-agent-core session history supports it. If exact undo cannot be performed from available tools, explain the blocker explicitly and do not pretend undo succeeded.";
    default:
      return undefined;
  }
}
