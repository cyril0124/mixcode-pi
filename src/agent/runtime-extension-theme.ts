import * as fs from "node:fs";
import * as path from "node:path";
import type {
  KeybindingsManager as ExtensionKeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type KeybindingDefinitions,
  type KeybindingsConfig,
  type KeyId,
  KeybindingsManager as PiTuiKeybindingsManager,
  TUI_KEYBINDINGS,
} from "@earendil-works/pi-tui";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  applyPiThemeInstance,
  initTheme,
} from "../ui/pi-theme-api.js";
import {
  getActiveExtensionThemeId,
  listThemeInfos,
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TERMINAL_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
  normalizeThemeId,
  noteActiveExtensionThemeId,
  registerAdditionalTheme,
  registerMixCodeThemes,
  resolvePiTheme,
} from "../ui/themes.js";
import type { ExtensionThemeHost } from "./runtime-types.js";

export {
  getActiveExtensionThemeId,
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TERMINAL_THEME,
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
  noteActiveExtensionThemeId,
  registerMixCodeThemes,
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
  // Pi default: ctrl+v (alt+v on Windows) pastes clipboard image path, else text.
  "app.clipboard.pasteImage": process.platform === "win32" ? "alt+v" : "ctrl+v",
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
  "app.clipboard.pasteImage": {
    defaultKeys: process.platform === "win32" ? "alt+v" : "ctrl+v",
    description: "Paste image from clipboard (text fallback)",
  },
  "app.message.copy": { defaultKeys: "ctrl+x", description: "Copy tree entry" },
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
  return getAgentDir();
}

/** User overrides from `~/.pi/agent/keybindings.json` (Pi-native path). */
function loadUserKeybindingsFile(agentDir = mixcodeAgentDir()): KeybindingsConfig {
  // Sync load at keybindings manager construction; Bun.file().text() is async-only.
  const filePath = path.join(agentDir, "keybindings.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
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
  const themes = listThemeInfos().map((theme) => ({ name: theme.id, path: undefined }));
  // Legacy name some packages/tests still query.
  if (!themes.some((theme) => theme.name === "mixcode-extension")) {
    themes.push({ name: "mixcode-extension", path: undefined });
  }
  return themes;
}

export function extensionThemeByName(name: string): Theme | undefined {
  const themeId = normalizeExtensionThemeId(name) ?? name.trim();
  return resolvePiTheme(themeId);
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
    try {
      registerAdditionalTheme(theme);
      host.setTheme(themeId);
      noteActiveExtensionThemeId(themeId);
      applyPiThemeInstance(theme);
      host.requestRender?.();
      requestRender();
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
  const themeId = normalizeExtensionThemeId(theme);
  if (!themeId) return { success: false, error: `Unknown theme: ${theme}` };
  const piTheme = resolvePiTheme(themeId);
  if (!piTheme) return { success: false, error: `Unknown theme: ${theme}` };
  try {
    host.setTheme(themeId);
    noteActiveExtensionThemeId(themeId); // sync even if host.setTheme is a no-op in tests
    applyPiThemeInstance(piTheme);
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

// Tracks whether the SDK global theme was initialized for syntax highlighting.
// initTheme costs ~40us/call; cache so the per-frame markdown path skips re-init.
let globalThemeReady = false;

export function ensureExtensionThemeInitialized(mode: "light" | "dark" = "dark"): void {
  if (globalThemeReady) return;
  const active = getActiveExtensionThemeId();
  const resolved = active ? resolvePiTheme(active) : undefined;
  if (resolved) {
    applyPiThemeInstance(resolved);
  } else {
    initTheme(mode);
  }
  globalThemeReady = true;
}
