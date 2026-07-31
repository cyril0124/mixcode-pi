import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type KeybindingsManager as ExtensionKeybindingsManager,
  initTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
  KeybindingsManager as PiTuiKeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import {
  getActiveExtensionThemeId,
  noteActiveExtensionThemeId,
} from "../core/active-extension-theme-id.js";
import { defaultPiAgentDir, resolveAgentDirEnv } from "../core/pi-models.js";
import {
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TERMINAL_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
  normalizeThemeId,
  THEMES,
} from "../ui/themes.js";
import type { ExtensionThemeHost } from "./runtime-types.js";

export {
  getActiveExtensionThemeId,
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TERMINAL_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
  noteActiveExtensionThemeId,
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
  // Session selector (Pi SessionSelectorComponent keyHint / getKeybindings)
  "app.session.toggleNamedFilter": "ctrl+n",
  "app.session.togglePath": "ctrl+p",
  "app.session.toggleSort": "ctrl+s",
  "app.session.rename": "ctrl+r",
  "app.session.delete": "ctrl+d",
  "app.session.deleteNoninvasive": "ctrl+backspace",
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
  "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy tree entry" },
  // Open-session actions (Pi InteractiveMode onAction parity). Defaults avoid
  // MixCode chords (ctrl+p palette, ctrl+t jump, ctrl+r rename, …). Double-Esc
  // still opens tree; keybindings.json overrides these.
  "app.session.new": { defaultKeys: "ctrl+shift+n", description: "Create a new session tab" },
  "app.session.tree": { defaultKeys: "ctrl+shift+t", description: "Open session tree" },
  "app.session.fork": { defaultKeys: "ctrl+shift+f", description: "Fork current session" },
  "app.session.resume": { defaultKeys: "ctrl+shift+r", description: "Resume a session" },
  "app.session.toggleNamedFilter": {
    defaultKeys: "ctrl+n",
    description: "Toggle named session filter",
  },
  "app.session.togglePath": { defaultKeys: "ctrl+p", description: "Toggle session path display" },
  "app.session.toggleSort": { defaultKeys: "ctrl+s", description: "Toggle session sort mode" },
  "app.session.rename": { defaultKeys: "ctrl+r", description: "Rename session" },
  "app.session.delete": { defaultKeys: "ctrl+d", description: "Delete session" },
  "app.session.deleteNoninvasive": {
    defaultKeys: "ctrl+backspace",
    description: "Delete session when query is empty",
  },
  "app.tree.foldOrUp": { defaultKeys: ["ctrl+left", "alt+left"] },
  "app.tree.unfoldOrDown": { defaultKeys: ["ctrl+right", "alt+right"] },
  "app.tree.editLabel": { defaultKeys: "shift+l" },
  "app.tree.toggleLabelTimestamp": { defaultKeys: "shift+t" },
  "app.tree.filter.default": { defaultKeys: "ctrl+d" },
  "app.tree.filter.noTools": { defaultKeys: "ctrl+t" },
  "app.tree.filter.userOnly": { defaultKeys: "ctrl+u" },
  "app.tree.filter.labeledOnly": { defaultKeys: "ctrl+l" },
  "app.tree.filter.all": { defaultKeys: "ctrl+a" },
  "app.tree.filter.cycleForward": { defaultKeys: "ctrl+o" },
  "app.tree.filter.cycleBackward": { defaultKeys: "shift+ctrl+o" },
} satisfies KeybindingDefinitions;

function mixcodeAgentDir(): string {
  return resolveAgentDirEnv(process.env.MIXCODE_CODING_AGENT_DIR) ?? defaultPiAgentDir();
}

/** User overrides from `~/.pi/agent/keybindings.json` (Pi-native path). */
function loadUserKeybindingsFile(agentDir = mixcodeAgentDir()): KeybindingsConfig {
  const path = join(agentDir, "keybindings.json");
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const config: KeybindingsConfig = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") {
        config[key] = value as KeyId;
        continue;
      }
      if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
        config[key] = value as KeyId[];
      }
    }
    return config;
  } catch {
    return {};
  }
}

function buildMixCodeUserBindings(): KeybindingsConfig {
  // File wins over MixCode remaps so users can rebind palette/session chords.
  return { ...MIXCODE_EXTENSION_KEYBINDINGS, ...loadUserKeybindingsFile() };
}

export const MIXCODE_EXTENSION_KEYBINDINGS_MANAGER = new PiTuiKeybindingsManager(
  MIXCODE_EXTENSION_KEYBINDING_DEFINITIONS,
  buildMixCodeUserBindings(),
) as unknown as ExtensionKeybindingsManager;

/** Re-read `keybindings.json` after /reload. */
export function reloadMixCodeUserKeybindings(): void {
  (
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER as unknown as {
      setUserBindings: (bindings: KeybindingsConfig) => void;
    }
  ).setUserBindings(buildMixCodeUserBindings());
}

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
