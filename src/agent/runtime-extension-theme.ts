import {
  type KeybindingsManager as ExtensionKeybindingsManager,
  initTheme,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingDefinitions,
  type KeybindingsConfig,
  KeybindingsManager as PiTuiKeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { normalizeThemeId, THEMES } from "../core/theme-registry.js";
import type { ExtensionThemeHost } from "./runtime-types.js";

export const MIXCODE_EXTENSION_THEME = new Theme(
  {
    accent: "#d97757",
    border: "#4d4c48",
    borderAccent: "#d97757",
    borderMuted: "#3d3d3a",
    success: "#8fa87a",
    error: "#b53333",
    warning: "#d6b25e",
    muted: "#7a7a72",
    dim: "#87867f",
    text: "#faf9f5",
    thinkingText: "#87867f",
    userMessageText: "#faf9f5",
    customMessageText: "#faf9f5",
    customMessageLabel: "#d97757",
    toolTitle: "#d6b25e",
    toolOutput: "#87867f",
    mdHeading: "#d97757",
    mdLink: "#d6b25e",
    mdLinkUrl: "#87867f",
    mdCode: "#d6b25e",
    mdCodeBlock: "#faf9f5",
    mdCodeBlockBorder: "#4d4c48",
    mdQuote: "#87867f",
    mdQuoteBorder: "#4d4c48",
    mdHr: "#4d4c48",
    mdListBullet: "#d97757",
    toolDiffAdded: "#8fa87a",
    toolDiffRemoved: "#b53333",
    toolDiffContext: "#87867f",
    syntaxComment: "#87867f",
    syntaxKeyword: "#d97757",
    syntaxFunction: "#d6b25e",
    syntaxVariable: "#faf9f5",
    syntaxString: "#8fa87a",
    syntaxNumber: "#d6b25e",
    syntaxType: "#d97757",
    syntaxOperator: "#faf9f5",
    syntaxPunctuation: "#87867f",
    thinkingOff: "#87867f",
    thinkingMinimal: "#87867f",
    thinkingLow: "#8fa87a",
    thinkingMedium: "#d6b25e",
    thinkingHigh: "#d97757",
    thinkingXhigh: "#b53333",
    bashMode: "#d6b25e",
  },
  {
    selectedBg: "#5e392f",
    userMessageBg: "#221d1a",
    customMessageBg: "#232321",
    toolPendingBg: "#2f2a22",
    toolSuccessBg: "#262624",
    toolErrorBg: "#3a2020",
  },
  "truecolor",
  { name: "mixcode-extension" },
);

export const MIXCODE_EXTENSION_LIGHT_THEME = new Theme(
  {
    accent: "#c45d3d",
    border: "#b8b1a5",
    borderAccent: "#c45d3d",
    borderMuted: "#d2cabd",
    success: "#557a4e",
    error: "#9f2d2d",
    warning: "#8f6b2f",
    muted: "#8a8377",
    dim: "#6f6a60",
    text: "#1f1e1c",
    thinkingText: "#6f6a60",
    userMessageText: "#1f1e1c",
    customMessageText: "#1f1e1c",
    customMessageLabel: "#c45d3d",
    toolTitle: "#8f6b2f",
    toolOutput: "#6f6a60",
    mdHeading: "#c45d3d",
    mdLink: "#8f6b2f",
    mdLinkUrl: "#6f6a60",
    mdCode: "#8f6b2f",
    mdCodeBlock: "#1f1e1c",
    mdCodeBlockBorder: "#b8b1a5",
    mdQuote: "#6f6a60",
    mdQuoteBorder: "#b8b1a5",
    mdHr: "#b8b1a5",
    mdListBullet: "#c45d3d",
    toolDiffAdded: "#557a4e",
    toolDiffRemoved: "#9f2d2d",
    toolDiffContext: "#6f6a60",
    syntaxComment: "#6f6a60",
    syntaxKeyword: "#c45d3d",
    syntaxFunction: "#8f6b2f",
    syntaxVariable: "#1f1e1c",
    syntaxString: "#557a4e",
    syntaxNumber: "#8f6b2f",
    syntaxType: "#c45d3d",
    syntaxOperator: "#1f1e1c",
    syntaxPunctuation: "#6f6a60",
    thinkingOff: "#6f6a60",
    thinkingMinimal: "#6f6a60",
    thinkingLow: "#557a4e",
    thinkingMedium: "#8f6b2f",
    thinkingHigh: "#c45d3d",
    thinkingXhigh: "#9f2d2d",
    bashMode: "#8f6b2f",
  },
  {
    selectedBg: "#ead1c5",
    userMessageBg: "#f3e7dd",
    customMessageBg: "#e3ded2",
    toolPendingBg: "#eadfc8",
    toolSuccessBg: "#e5eadf",
    toolErrorBg: "#ecd7d2",
  },
  "truecolor",
  { name: "mixcode-light" },
);

export const MIXCODE_EXTENSION_TERMINAL_THEME = MIXCODE_EXTENSION_THEME;

export const MIXCODE_EXTENSION_KEYBINDINGS: KeybindingsConfig = {
  "app.interrupt": "escape",
  "app.clear": "ctrl+c",
  "app.exit": "ctrl+q",
  "app.suspend": "ctrl+z",
  "app.thinking.cycle": "shift+tab",
  "app.model.cycleForward": "ctrl+p",
  "app.model.cycleBackward": "ctrl+t",
  "app.model.select": "ctrl+l",
  "app.tools.expand": "ctrl+o",
  "app.thinking.toggle": "ctrl+r",
  "app.editor.external": "ctrl+e",
  "app.message.followUp": "alt+enter",
  "tui.input.submit": "enter",
  "tui.select.confirm": "enter",
  "tui.select.cancel": "escape",
  "tui.input.copy": "ctrl+c",
  "tui.editor.deleteToLineEnd": "ctrl+k",
};

const MIXCODE_EXTENSION_KEYBINDING_DEFINITIONS = {
  ...TUI_KEYBINDINGS,
  "app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
  "app.clear": { defaultKeys: "ctrl+c", description: "Clear editor input" },
  "app.exit": { defaultKeys: "ctrl+q", description: "Quit MixCode" },
  "app.suspend": {
    defaultKeys: process.platform === "win32" ? [] : "ctrl+z",
    description: "Suspend to background",
  },
  "app.thinking.cycle": { defaultKeys: "shift+tab", description: "Cycle thinking level" },
  "app.model.cycleForward": { defaultKeys: "ctrl+p", description: "Open command palette" },
  "app.model.cycleBackward": { defaultKeys: "ctrl+t", description: "Open tab jump" },
  "app.model.select": { defaultKeys: "ctrl+l", description: "Open export chooser" },
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.thinking.toggle": { defaultKeys: "ctrl+r", description: "Prepare rename command" },
  "app.editor.external": { defaultKeys: "ctrl+e", description: "Open external editor" },
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
} satisfies KeybindingDefinitions;

export const MIXCODE_EXTENSION_KEYBINDINGS_MANAGER = new PiTuiKeybindingsManager(
  MIXCODE_EXTENSION_KEYBINDING_DEFINITIONS,
  MIXCODE_EXTENSION_KEYBINDINGS,
) as unknown as ExtensionKeybindingsManager;

export function currentExtensionTheme(host: ExtensionThemeHost | undefined): Theme {
  const current = host?.getTheme();
  return current
    ? (extensionThemeByName(current) ?? MIXCODE_EXTENSION_THEME)
    : MIXCODE_EXTENSION_THEME;
}

export function availableExtensionThemes(): Array<{ name: string; path: string | undefined }> {
  return [
    ...THEMES.map((theme) => ({ name: theme.id, path: undefined })),
    { name: "dark", path: undefined },
    { name: "light", path: undefined },
    { name: MIXCODE_EXTENSION_THEME.name ?? "mixcode-extension", path: undefined },
  ].filter(
    (theme, index, themes) =>
      themes.findIndex((candidate) => candidate.name === theme.name) === index,
  );
}

export function extensionThemeByName(name: string): Theme | undefined {
  const themeId = normalizeExtensionThemeId(name);
  if (themeId === "mixcode-dark") return MIXCODE_EXTENSION_THEME;
  if (themeId === "mixcode-light") return MIXCODE_EXTENSION_LIGHT_THEME;
  if (themeId === "terminal") return MIXCODE_EXTENSION_TERMINAL_THEME;
  if (
    name === (MIXCODE_EXTENSION_THEME.name ?? "mixcode-extension") ||
    name === "mixcode-extension"
  )
    return MIXCODE_EXTENSION_THEME;
  return undefined;
}

export function applyExtensionTheme(
  theme: string | Theme,
  host: ExtensionThemeHost | undefined,
  requestRender: () => void,
): { success: boolean; error?: string } {
  if (!host)
    return {
      success: false,
      error: "Pi extension theme switching requires an active MixCode TUI host",
    };
  if (typeof theme !== "string") {
    const themeId = theme.name?.trim();
    if (!themeId)
      return { success: false, error: "Pi extension in-memory themes must have a name in MixCode" };
    return {
      success: false,
      error: `Pi extension in-memory themes are not switchable by MixCode yet: ${themeId}`,
    };
  }
  const themeId = normalizeExtensionThemeId(theme);
  if (!themeId) return { success: false, error: `Unknown theme: ${theme}` };
  try {
    host.setTheme(themeId);
    host.requestRender?.();
    requestRender();
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export function normalizeExtensionThemeId(name: string): string | undefined {
  return normalizeThemeId(name);
}

export function ensureExtensionThemeInitialized(): void {
  initTheme("dark");
}
