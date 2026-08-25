export type LocalCommand =
  | "models"
  | "thinking"
  | "context-limit"
  | "workdir"
  | "fork"
  | "follow-up"
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
  | "hide-thinking"
  | "settings"
  | "session"
  | "export"
  | "compact"
  | "clear"
  | "reset"
  | "mark-done"
  | "vim"
  | "toggle-zen-mode"
  | "toggle-inline-widgets"
  | "navigate"
  | "new-session"
  | "resume"
  | "login"
  | "logout"
  | "help"
  | "hotkeys"
  | "palette"
  | "jump"
  | "editor"
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
  scope?: "agent" | "home" | "both";
  /** Agent-view enable requirement. Omitted = always enabled. */
  requires?: PaletteRequirement;
  /** Config-view enable requirement. Omitted = always enabled. */
  configRequires?: "tabs";
}

function sessionActionYesCompletions(
  prefix: string,
): Array<{ value: string; label: string; description?: string }> {
  const needle = prefix.trim().toLowerCase();
  if (needle && !"yes".startsWith(needle)) return [];
  return [{ value: "yes", label: "yes", description: "Skip confirmation" }];
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
    argumentHint: "[provider/model-id]",
    palette: {
      label: "Choose Model",
      description: "Choose the current tab model",
      requires: "session+models",
    },
  },
  {
    name: "thinking",
    description: "Select thinking level",
    argumentHint: "[level]",
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
    argumentHint: "[path]",
    palette: {
      label: "Change Workdir",
      description: "Change the current tab working directory",
      requires: "session",
    },
  },
  {
    name: "follow-up",
    description: "Queue a message to send after the current agent turn finishes",
    argumentHint: "<message>",
    palette: {
      label: "Queue Follow-up",
      description: "Send after the agent finishes (not in-flight steer)",
      requires: "session",
    },
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
    argumentHint: "[yes]",
    getArgumentCompletions: sessionActionYesCompletions,
    palette: {
      label: "Close Session",
      description: "Close the current tab but keep its session",
      requires: "session",
    },
  },
  {
    name: "delete-session",
    description: "Delete active session",
    argumentHint: "[yes]",
    getArgumentCompletions: sessionActionYesCompletions,
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
    argumentHint: "[name]",
    palette: {
      label: "Save Workspace",
      description: "Save the current open agent tabs as a workspace",
      scope: "home",
      configRequires: "tabs",
    },
  },
  {
    name: "restore-workspace",
    description: "Restore a saved workspace tab order",
    argumentHint: "[name]",
    palette: {
      label: "Restore Workspace",
      description: "Restore a saved workspace",
      scope: "home",
    },
  },
  {
    name: "delete-workspace",
    description: "Delete a saved workspace",
    argumentHint: "[name]",
    palette: { label: "Delete Workspace", scope: "home" },
  },
  {
    name: "import",
    description: "Import a Pi session JSONL file",
    argumentHint: "<path> [cwd]",
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
      requires: "session",
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
    name: "settings",
    // Writes Pi global settings.json for several items; theme/history/ui also hit mixcode_settings.json.
    description: "[global] View and edit settings (theme, thinking visibility, defaults, …)",
    palette: { label: "Settings", description: "Theme, thinking visibility, defaults, and more", scope: "both" },
  },
  {
    name: "hide-thinking",
    // [global] prefix: this setting persists to Pi's global settings.json
    // (survives restart, shared across workdirs and with Pi). See AGENTS.md.
    description: "[global] Toggle visibility of assistant thinking blocks",
    palette: { label: "Toggle Thinking Blocks", scope: "both" },
  },
  {
    name: "session",
    description: "Show session info and stats",
    palette: { label: "Session Info", requires: "session" },
  },
  {
    name: "export",
    description: "Export session to HTML (or JSONL when path ends with .jsonl)",
    argumentHint: "[path]",
    palette: {
      label: "Export Session",
      description: "Export the current session to HTML or JSONL",
      requires: "session",
    },
  },
  {
    name: "compact",
    description: "Compact context",
    argumentHint: "[instructions]",
    palette: { label: "Compact Context", requires: "session" },
  },
  {
    name: "clear",
    description: "Replace active session with a fresh child session (resets title)",
    palette: { label: "Clear Session", requires: "session" },
  },
  {
    name: "reset",
    description:
      "Reset current branch to session root (same file; history stays in the tree; keeps title)",
    palette: {
      label: "Reset Branch",
      description: "Same session file; leaf back to root; title and tab slot kept",
      requires: "session",
    },
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
    name: "toggle-zen-mode",
    description: "Toggle Zen mode (hide tab bar; Tab switches only via Ctrl+T)",
    palette: { label: "Toggle Zen Mode", requires: "session" },
  },
  {
    name: "toggle-inline-widgets",
    description: "Toggle showing extension widgets in chat (bottom; Steer/Follow-up stays last)",
    palette: { label: "Toggle Inline Widgets", requires: "session" },
  },
  {
    name: "navigate",
    description: "Scroll to user messages from the session tree",
    palette: { label: "Navigate Messages", requires: "session" },
  },
  {
    name: "new-session",
    description: "Create a session (optional name: /new-session Title)",
    argumentHint: "[title]",
    palette: {
      label: "New Session",
      description: "Create a new pi agent session; optional title becomes the tab name",
      scope: "both",
      requires: "session",
    },
  },
  {
    name: "resume",
    description: "Resume a different session (optional: /resume <session-id> or /resume N:<tab-name>)",
    argumentHint: "[session-id | N:<tab-name>]",
    palette: { label: "Resume Session", scope: "both", requires: "session" },
  },
  {
    name: "help",
    description: "Show all keyboard shortcuts",
    palette: { label: "Help", requires: "session" },
  },
  {
    name: "hotkeys",
    description: "Show all keyboard shortcuts",
    palette: { label: "Hotkeys", requires: "session" },
  },
  {
    name: "palette",
    description: "Open command palette",
  },
  {
    name: "jump",
    description: "Open tab jump overlay",
    palette: {
      label: "Tab Jump",
      description: "Jump to an open tab",
      scope: "both",
    },
  },
  {
    name: "editor",
    description: "Edit input in $VISUAL / $EDITOR",
    palette: {
      label: "Edit Input",
      description: "Open the input draft in the external editor",
      scope: "both",
    },
  },
  {
    name: "rename",
    description: "Rename active tab",
    argumentHint: "<title>",
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
  {
    name: "login",
    description: "Configure provider authentication",
    argumentHint: "<provider>",
    palette: {
      label: "Login Provider",
      description: "Configure provider authentication (OAuth or API key)",
      scope: "both",
    },
  },
  {
    name: "logout",
    description: "Remove provider authentication",
    palette: {
      label: "Logout Provider",
      description: "Remove stored provider credentials",
      scope: "both",
    },
  },
  { name: "quit", description: "Exit the TUI", palette: { label: "Quit" } },
  { name: "exit", description: "Exit the TUI", palette: { label: "Exit" } },
];

const COMMAND_SET = new Set<string>(LOCAL_COMMANDS.map((command) => command.name));

export function isLocalCommand(command: string | undefined): command is LocalCommand {
  return command !== undefined && COMMAND_SET.has(command);
}

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
