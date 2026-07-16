import {
  type KeybindingsManager as ExtensionKeybindingsManager,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingDefinitions,
  type KeybindingsConfig,
  KeybindingsManager as PiTuiKeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  getActiveExtensionThemeId,
  noteActiveExtensionThemeId,
} from "../core/active-extension-theme-id.js";
import {
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TERMINAL_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
  normalizeThemeId,
  THEMES,
} from "../ui/themes.js";
import type { ExtensionThemeHost } from "./runtime-types.js";

export { getActiveExtensionThemeId, noteActiveExtensionThemeId };

export {
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TERMINAL_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
};

export const MIXCODE_EXTENSION_KEYBINDINGS: KeybindingsConfig = {
  "app.interrupt": "escape",
  "app.clear": "ctrl+c",
  "app.exit": "ctrl+q",
  "app.suspend": "ctrl+z",
  "app.thinking.cycle": "shift+tab",
  "app.model.cycleForward": "ctrl+p",
  "app.model.cycleBackward": "ctrl+t",
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
  "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" },
  "app.thinking.toggle": { defaultKeys: "ctrl+r", description: "Prepare rename command" },
  "app.editor.external": { defaultKeys: "ctrl+e", description: "Open external editor" },
  "app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up message" },
} satisfies KeybindingDefinitions;

export const MIXCODE_EXTENSION_KEYBINDINGS_MANAGER = new PiTuiKeybindingsManager(
  MIXCODE_EXTENSION_KEYBINDING_DEFINITIONS,
  MIXCODE_EXTENSION_KEYBINDINGS,
) as unknown as ExtensionKeybindingsManager;

export function currentExtensionTheme(host?: ExtensionThemeHost | undefined): Theme {
  const raw = host?.getTheme() ?? getActiveExtensionThemeId();
  const current = normalizeExtensionThemeId(raw) ?? raw;
  return extensionThemeByName(current) ?? MIXCODE_EXTENSION_THEME;
}

export function availableExtensionThemes(): Array<{ name: string; path: string | undefined }> {
  return [
    ...THEMES.map((theme) => ({ name: theme.id, path: undefined })),
    { name: "dark", path: undefined },
    { name: MIXCODE_EXTENSION_THEME.name ?? "mixcode-extension", path: undefined },
  ].filter(
    (theme, index, themes) =>
      themes.findIndex((candidate) => candidate.name === theme.name) === index,
  );
}

export function extensionThemeByName(name: string): Theme | undefined {
  const themeId = normalizeExtensionThemeId(name);
  if (themeId === "mixcode-dark") return MIXCODE_EXTENSION_THEME;
  if (themeId === "claude-warm") return MIXCODE_EXTENSION_CLAUDE_WARM_THEME;
  if (themeId === "tokyo-night") return MIXCODE_EXTENSION_TOKYO_NIGHT_THEME;
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
    noteActiveExtensionThemeId(themeId); // sync even if host.setTheme is a no-op in tests
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

// Tracks which SDK builtin the global syntax highlighter was initialized to.
// initTheme costs ~40us/call, far too much for the per-frame markdown highlight
// path, so we cache the last mode and skip re-init when it is unchanged.
// MixCode currently only ships dark builtins, so this stays "dark" in practice.
let initializedThemeMode: "light" | "dark" | undefined;

export function ensureExtensionThemeInitialized(mode: "light" | "dark" = "dark"): void {
  if (initializedThemeMode === mode) return;
  initTheme(mode);
  initializedThemeMode = mode;
}
