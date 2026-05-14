import { themeArgumentCompletions } from "./theme-registry.js";

export type LocalCommand =
  | "models"
  | "thinking"
  | "workdir"
  | "theme"
  | "fork"
  | "tree"
  | "close-session"
  | "delete-session"
  | "delete-all-sessions"
  | "save-workspace"
  | "restore-workspace"
  | "delete-workspace"
  | "export"
  | "import"
  | "extension-manager"
  | "reload"
  | "system-prompt"
  | "system-tools"
  | "session"
  | "compact"
  | "undo"
  | "redo"
  | "clear"
  | "mark-done"
  | "vim"
  | "new-session"
  | "resume"
  | "help"
  | "hotkeys"
  | "rename"
  | "tui-state"
  | "quit"
  | "exit";

export interface ParsedInput {
  kind: "prompt" | "local-command" | "shell";
  command?: LocalCommand | string;
  args: string;
  excludeFromContext?: boolean;
}

export const LOCAL_COMMANDS: Array<{
  name: LocalCommand;
  description: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string; description?: string }>;
}> = [
  { name: "models", description: "Select model for the active agent" },
  { name: "thinking", description: "Select thinking level" },
  { name: "workdir", description: "Change active agent workdir" },
  {
    name: "theme",
    description: "Switch UI theme",
    argumentHint: "<theme>",
    getArgumentCompletions: themeArgumentCompletions,
  },
  { name: "fork", description: "Fork the active session" },
  { name: "tree", description: "Navigate session tree (switch branches)" },
  { name: "close-session", description: "Close active tab" },
  { name: "delete-session", description: "Delete active session" },
  { name: "delete-all-sessions", description: "Delete all open agent tabs" },
  { name: "save-workspace", description: "Save current workspace tab order" },
  { name: "restore-workspace", description: "Restore a saved workspace tab order" },
  { name: "delete-workspace", description: "Delete a saved workspace" },
  { name: "export", description: "View thinking, chatlog, latest-agent, or latest-user text" },
  { name: "import", description: "Import a Pi session JSONL file" },
  { name: "extension-manager", description: "Manage Pi extensions for this workdir" },
  { name: "reload", description: "Reload keybindings, extensions, skills, prompts, and themes" },
  { name: "system-prompt", description: "Show the active agent system prompt" },
  { name: "system-tools", description: "Show the active agent tools" },
  { name: "session", description: "Show session info and stats" },
  { name: "compact", description: "Compact context" },
  { name: "undo", description: "Move session leaf back" },
  { name: "redo", description: "Restore the most recently undone session" },
  { name: "clear", description: "Replace active session with a fresh child session" },
  { name: "mark-done", description: "Mark active tab done" },
  { name: "vim", description: "Enter Vim mode for chat scrolling" },
  { name: "new-session", description: "Create a session" },
  { name: "resume", description: "Resume a different session" },
  { name: "help", description: "Show all keyboard shortcuts" },
  { name: "hotkeys", description: "Show all keyboard shortcuts" },
  { name: "rename", description: "Rename active tab" },
  { name: "tui-state", description: "Show current TUI state JSON" },
  { name: "quit", description: "Exit the TUI" },
  { name: "exit", description: "Exit the TUI" },
];

const COMMAND_SET = new Set<string>(LOCAL_COMMANDS.map((command) => command.name));

export function parseInput(text: string): ParsedInput {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("!!"))
    return {
      kind: "shell",
      command: "shell",
      args: trimmed.slice(2).trimStart(),
      excludeFromContext: true,
    };
  if (trimmed.startsWith("!"))
    return {
      kind: "shell",
      command: "shell",
      args: trimmed.slice(1).trimStart(),
      excludeFromContext: false,
    };
  if (!trimmed.startsWith("/")) return { kind: "prompt", args: text };
  const [rawCommand = "", ...rest] = trimmed.slice(1).split(/\s+/);
  const args = rest.join(" ");
  return {
    kind: "local-command",
    command: COMMAND_SET.has(rawCommand) ? (rawCommand as LocalCommand) : rawCommand,
    args,
  };
}

export function commandSuggestions(prefix: string): string[] {
  const normalized = prefix.replace(/^\//, "");
  return LOCAL_COMMANDS.map((command) => command.name).filter((name) =>
    name.startsWith(normalized),
  );
}
