export interface KeyAction {
  key: string;
  action: string;
  description: string;
  scope?: string;
}

export const MIXCODE_KEYMAP: KeyAction[] = [
  { key: "tab", action: "next-tab", description: "Next tab", scope: "global" },
  { key: "shift+tab", action: "previous-tab", description: "Previous tab", scope: "global" },
  {
    key: "ctrl+p",
    action: "command-palette",
    description: "Open command palette",
    scope: "global",
  },
  { key: "ctrl+t", action: "jump-tab", description: "Open tab jump overlay", scope: "global" },
  {
    key: "ctrl+e",
    action: "external-editor",
    description: "Edit input in external editor",
    scope: "global",
  },
  { key: "ctrl+c", action: "clear-input", description: "Clear editor input", scope: "global" },
  {
    key: "ctrl+r",
    action: "rename-tab",
    description: "Prepare rename command for active tab",
    scope: "global",
  },
  {
    key: "@",
    action: "file-autocomplete",
    description: "Trigger editor file autocomplete for @ references",
    scope: "global",
  },
  {
    key: "alt+up",
    action: "pop-queued-message",
    description: "Pop last queued message into editor",
    scope: "global",
  },
  {
    key: "ctrl+u",
    action: "pop-queued-message",
    description: "Pop last queued message into editor",
    scope: "global",
  },
  {
    key: "up/down",
    action: "prompt-history",
    description: "Browse prompt history when input is empty",
    scope: "global",
  },
  {
    key: "right",
    action: "extension-widget-panel",
    description: "Outside Vim, toggle extension widget side panel when input is empty",
    scope: "global",
  },
  {
    key: "right",
    action: "vim-next-user-message",
    description: "In Vim mode, jump to newer user message",
    scope: "global",
  },
  {
    key: "shift+right",
    action: "vim-previous-user-message",
    description: "In Vim mode, jump to older user message",
    scope: "global",
  },
  { key: "ctrl+j", action: "newline", description: "Insert newline", scope: "global" },
  { key: "shift+enter", action: "newline", description: "Insert newline", scope: "global" },
  {
    key: "ctrl+o",
    action: "toggle-tool-expand",
    description: "Expand/collapse tool output and startup help",
    scope: "global",
  },

  { key: "escape", action: "close-overlay", description: "Close active overlay", scope: "global" },
  { key: "ctrl+q", action: "quit", description: "Quit MixCode", scope: "global" },
  {
    key: "tab/shift+tab",
    action: "picker-select",
    description: "Move picker selection",
    scope: "picker",
  },
  {
    key: "enter",
    action: "picker-accept",
    description: "Apply selected model, thinking level, theme, or workdir",
    scope: "picker",
  },
  { key: "escape", action: "picker-close", description: "Close picker", scope: "picker" },
  {
    key: "up/down",
    action: "picker-select",
    description: "Move picker selection",
    scope: "picker",
  },
  {
    key: "ctrl+u",
    action: "workdir-query-clear",
    description: "Clear workdir picker query",
    scope: "picker",
  },
  {
    key: "tab/shift+tab",
    action: "command-palette-select",
    description: "Move command palette selection",
    scope: "command-palette",
  },
  {
    key: "enter",
    action: "command-palette-run",
    description: "Run selected command or show disabled reason",
    scope: "command-palette",
  },
  {
    key: "escape",
    action: "command-palette-close",
    description: "Close command palette",
    scope: "command-palette",
  },
  {
    key: "tab/shift+tab",
    action: "tab-jump-select",
    description: "Move tab jump selection",
    scope: "tab-jump",
  },
  {
    key: "enter",
    action: "tab-jump-accept",
    description: "Activate selected tab",
    scope: "tab-jump",
  },
  { key: "escape", action: "tab-jump-close", description: "Close tab jump", scope: "tab-jump" },
  {
    key: "h/l",
    action: "preview-message",
    description: "Move between preview messages",
    scope: "preview",
  },
  { key: "j/k", action: "preview-scroll", description: "Scroll preview", scope: "preview" },
  {
    key: "g/G",
    action: "preview-boundary",
    description: "Jump to top or bottom",
    scope: "preview",
  },
  { key: "escape", action: "preview-close", description: "Close preview", scope: "preview" },
  {
    key: "left",
    action: "return-home",
    description: "Return to Agent View when input is empty",
    scope: "agent",
  },
  {
    key: "up/down",
    action: "home-select",
    description: "Select agent row in Agent View table",
    scope: "home",
  },
  {
    key: "right/enter",
    action: "home-attach",
    description: "Attach to selected agent session",
    scope: "home",
  },
];

export function describeKeymap(): string[] {
  return MIXCODE_KEYMAP.map((item) => `${item.key}: ${item.description}`);
}

export function describeScopedKeymap(): string[] {
  return MIXCODE_KEYMAP.map((item) => `${item.scope ?? "global"} ${item.key}: ${item.description}`);
}
