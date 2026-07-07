import { themeArgumentCompletions } from "../ui/themes.js";

export type LocalCommand =
  | "models"
  | "thinking"
  | "context-limit"
  | "workdir"
  | "theme"
  | "fork"
  | "tree"
  | "close-session"
  | "delete-session"
  | "close-all-sessions"
  | "delete-all-sessions"
  | "save-workspace"
  | "restore-workspace"
  | "delete-workspace"
  | "import"
  | "extension-manager"
  | "reload"
  | "system-prompt"
  | "system-tools"
  | "toggle-hidden-messages"
  | "session"
  | "compact"
  | "clear"
  | "mark-done"
  | "vim"
  | "navigate"
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

/** Enable-condition for a palette entry, resolved against the current UI state. */
export type PaletteRequirement = "session" | "session+models" | "tabs";

/**
 * Command-palette metadata attached to a local command. The palette derives
 * its entries from LOCAL_COMMANDS via this field, so registering a new
 * command here is sufficient — no hardcoded list in overlays.ts to update.
 */
export interface LocalCommandPaletteMeta {
  /** Human-friendly palette label, e.g. "Choose Model". */
  label: string;
  /** Palette-facing description; falls back to the command description. */
  description?: string;
  /** Which palette views show this entry. Default: "agent". */
  scope?: "agent" | "config" | "both";
  /** Agent-view enable requirement. Omitted = always enabled. */
  requires?: PaletteRequirement;
  /** Config-view enable requirement. Omitted = always enabled. */
  configRequires?: "tabs";
}

export const LOCAL_COMMANDS: Array<{
  name: LocalCommand;
  description: string;
  argumentHint?: string;
  getArgumentCompletions?: (
    prefix: string,
  ) => Array<{ value: string; label: string; description?: string }>;
  /** Palette metadata. Omit to keep a command out of the command palette. */
  palette?: LocalCommandPaletteMeta;
}> = [
  {
    name: "models",
    description: "Select model for the active agent",
    palette: {
      label: "Choose Model",
      description: "Choose the current tab model",
      requires: "session+models",
    },
  },
  {
    name: "thinking",
    description: "Select thinking level",
    palette: {
      label: "Choose Thinking Tier",
      description: "Choose the current tab thinking tier",
      requires: "session",
    },
  },
  {
    name: "context-limit",
    description: "Set context window limit",
    argumentHint: "<tokens|reset>",
    palette: {
      label: "Set Context Limit",
      description: "Set context window limit for the current tab",
      requires: "session",
    },
  },
  {
    name: "workdir",
    description: "Change active agent workdir",
    palette: {
      label: "Change Workdir",
      description: "Change the current tab working directory",
      requires: "session",
    },
  },
  {
    name: "theme",
    description: "Switch UI theme",
    argumentHint: "<theme>",
    getArgumentCompletions: themeArgumentCompletions,
    palette: { label: "Choose Theme", description: "Choose the app UI theme", scope: "both" },
  },
  {
    name: "fork",
    description: "Fork the active session",
    palette: { label: "Fork Session", requires: "session" },
  },
  {
    name: "tree",
    description: "Navigate session tree (switch branches)",
    palette: { label: "Session Tree", requires: "session" },
  },
  {
    name: "close-session",
    description: "Close active tab",
    palette: {
      label: "Close Session",
      description: "Close the current tab but keep its session",
      requires: "session",
    },
  },
  {
    name: "delete-session",
    description: "Delete active session",
    palette: {
      label: "Delete Session",
      description: "Delete the session bound to the current tab",
      requires: "session",
    },
  },
  {
    name: "close-all-sessions",
    description: "Close all agent tabs but keep their sessions",
    palette: {
      label: "Close All Sessions",
      scope: "both",
      requires: "tabs",
      configRequires: "tabs",
    },
  },
  {
    name: "delete-all-sessions",
    description: "Delete all open agent tabs",
    palette: {
      label: "Delete All Sessions",
      description: "Delete all sessions and close all agent tabs",
      scope: "both",
      requires: "tabs",
      configRequires: "tabs",
    },
  },
  {
    name: "save-workspace",
    description: "Save current workspace tab order",
    palette: {
      label: "Save Workspace",
      description: "Save the current open agent tabs as a workspace",
      scope: "config",
      configRequires: "tabs",
    },
  },
  {
    name: "restore-workspace",
    description: "Restore a saved workspace tab order",
    palette: {
      label: "Restore Workspace",
      description: "Restore a saved workspace",
      scope: "config",
    },
  },
  {
    name: "delete-workspace",
    description: "Delete a saved workspace",
    palette: { label: "Delete Workspace", scope: "config" },
  },
  {
    name: "import",
    description: "Import a Pi session JSONL file",
    palette: {
      label: "Import Session",
      description: "Import a Pi session JSONL file into the current tab",
      requires: "session",
    },
  },
  {
    name: "extension-manager",
    description: "Manage Pi extensions for this workdir",
    palette: {
      label: "Extension Manager",
      scope: "both",
      requires: "session",
      configRequires: "tabs",
    },
  },
  {
    name: "reload",
    description: "Reload keybindings, extensions, skills, prompts, themes, and models",
    palette: {
      label: "Reload",
      description: "Reload keybindings, extensions, skills, prompts, and themes",
      scope: "both",
    },
  },
  {
    name: "system-prompt",
    description: "Show the active agent system prompt",
    palette: { label: "Open System Prompt", requires: "session" },
  },
  {
    name: "system-tools",
    description: "Show the active agent tools",
    palette: { label: "Open System Tools", requires: "session" },
  },
  {
    name: "toggle-hidden-messages",
    description: "Toggle visibility of hidden (display:false) extension messages",
    palette: { label: "Toggle Hidden Messages", requires: "session" },
  },
  {
    name: "session",
    description: "Show session info and stats",
    palette: { label: "Session Info", requires: "session" },
  },
  {
    name: "compact",
    description: "Compact context",
    palette: { label: "Compact Context", requires: "session" },
  },
  {
    name: "clear",
    description: "Replace active session with a fresh child session",
    palette: { label: "Clear Session", requires: "session" },
  },
  {
    name: "mark-done",
    description: "Mark active tab done",
    palette: { label: "Mark Done", description: "Mark the current tab done", requires: "session" },
  },
  {
    name: "vim",
    description: "Enter Vim mode for chat scrolling",
    palette: { label: "Vim Mode", requires: "session" },
  },
  {
    name: "navigate",
    description: "Scroll to user messages from the session tree",
    palette: { label: "Navigate Messages", requires: "session" },
  },
  {
    name: "new-session",
    description: "Create a session",
    palette: {
      label: "New Session",
      description: "Create a new pi agent session",
      scope: "both",
      requires: "session",
    },
  },
  {
    name: "resume",
    description: "Resume a different session",
    palette: { label: "Resume Session", scope: "both", requires: "session" },
  },
  { name: "help", description: "Show all keyboard shortcuts", palette: { label: "Help" } },
  { name: "hotkeys", description: "Show all keyboard shortcuts", palette: { label: "Hotkeys" } },
  {
    name: "rename",
    description: "Rename active tab",
    palette: { label: "Rename", description: "Rename the current tab", requires: "session" },
  },
  {
    name: "tui-state",
    description: "Show current TUI state JSON",
    palette: {
      label: "Open TUI State",
      description: "Show the current TUI state JSON",
      scope: "both",
    },
  },
  { name: "quit", description: "Exit the TUI", palette: { label: "Quit" } },
  { name: "exit", description: "Exit the TUI", palette: { label: "Exit" } },
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
  // /skill:<name> is a prompt expansion, not a local command
  if (trimmed.startsWith("/skill:")) return { kind: "prompt", args: trimmed };
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
