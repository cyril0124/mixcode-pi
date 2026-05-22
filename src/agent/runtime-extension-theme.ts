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
    accent: "#8abeb7",
    border: "#5f87ff",
    borderAccent: "#00d7ff",
    borderMuted: "#505050",
    success: "#b5bd68",
    error: "#cc6666",
    warning: "#ffff00",
    muted: "#808080",
    dim: "#666666",
    text: "#d4d4d4",
    thinkingText: "#808080",
    userMessageText: "#d4d4d4",
    customMessageText: "#d4d4d4",
    customMessageLabel: "#9575cd",
    toolTitle: "#d4d4d4",
    toolOutput: "#808080",
    mdHeading: "#f0c674",
    mdLink: "#81a2be",
    mdLinkUrl: "#666666",
    mdCode: "#8abeb7",
    mdCodeBlock: "#b5bd68",
    mdCodeBlockBorder: "#808080",
    mdQuote: "#808080",
    mdQuoteBorder: "#808080",
    mdHr: "#808080",
    mdListBullet: "#8abeb7",
    toolDiffAdded: "#b5bd68",
    toolDiffRemoved: "#cc6666",
    toolDiffContext: "#808080",
    syntaxComment: "#6A9955",
    syntaxKeyword: "#569CD6",
    syntaxFunction: "#DCDCAA",
    syntaxVariable: "#9CDCFE",
    syntaxString: "#CE9178",
    syntaxNumber: "#B5CEA8",
    syntaxType: "#4EC9B0",
    syntaxOperator: "#D4D4D4",
    syntaxPunctuation: "#D4D4D4",
    thinkingOff: "#505050",
    thinkingMinimal: "#6e6e6e",
    thinkingLow: "#5f87af",
    thinkingMedium: "#81a2be",
    thinkingHigh: "#b294bb",
    thinkingXhigh: "#d183e8",
    bashMode: "#b5bd68",
  },
  {
    selectedBg: "#3a3a4a",
    userMessageBg: "#343541",
    customMessageBg: "#2d2838",
    toolPendingBg: "#282832",
    toolSuccessBg: "#283228",
    toolErrorBg: "#3c2828",
  },
  "truecolor",
  { name: "mixcode-extension" },
);

export const MIXCODE_EXTENSION_LIGHT_THEME = new Theme(
  {
    accent: "#5a8080",
    border: "#547da7",
    borderAccent: "#5a8080",
    borderMuted: "#b0b0b0",
    success: "#588458",
    error: "#aa5555",
    warning: "#9a7326",
    muted: "#6c6c6c",
    dim: "#767676",
    text: "#1f2328",
    thinkingText: "#6c6c6c",
    userMessageText: "#1f2328",
    customMessageText: "#1f2328",
    customMessageLabel: "#7e57c2",
    toolTitle: "#1f2328",
    toolOutput: "#6c6c6c",
    mdHeading: "#9a7326",
    mdLink: "#547da7",
    mdLinkUrl: "#767676",
    mdCode: "#5a8080",
    mdCodeBlock: "#588458",
    mdCodeBlockBorder: "#6c6c6c",
    mdQuote: "#6c6c6c",
    mdQuoteBorder: "#6c6c6c",
    mdHr: "#6c6c6c",
    mdListBullet: "#588458",
    toolDiffAdded: "#588458",
    toolDiffRemoved: "#aa5555",
    toolDiffContext: "#6c6c6c",
    syntaxComment: "#008000",
    syntaxKeyword: "#0000FF",
    syntaxFunction: "#795E26",
    syntaxVariable: "#001080",
    syntaxString: "#A31515",
    syntaxNumber: "#098658",
    syntaxType: "#267F99",
    syntaxOperator: "#000000",
    syntaxPunctuation: "#000000",
    thinkingOff: "#b0b0b0",
    thinkingMinimal: "#767676",
    thinkingLow: "#547da7",
    thinkingMedium: "#5a8080",
    thinkingHigh: "#875f87",
    thinkingXhigh: "#8b008b",
    bashMode: "#588458",
  },
  {
    selectedBg: "#d0d0e0",
    userMessageBg: "#e8e8e8",
    customMessageBg: "#ede7f6",
    toolPendingBg: "#e8e8f0",
    toolSuccessBg: "#e8f0e8",
    toolErrorBg: "#f0e8e8",
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
