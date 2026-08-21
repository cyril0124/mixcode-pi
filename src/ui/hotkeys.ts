import { MIXCODE_KEYMAP } from "../core/keymap.js";
import type { RuntimeShortcutInfo } from "./app-types.js";

export function renderHotkeysText(extensionShortcuts: RuntimeShortcutInfo[] = []): string {
  const lines = [
    "Keyboard Shortcuts",
    "",
    ...formatHotkeyGroup("Global", hotkeysForScope("global")),
    "",
    ...formatHotkeyGroup("Picker", hotkeysForScope("picker")),
    "",
    ...formatHotkeyGroup("Command Palette", hotkeysForScope("command-palette")),
    "",
    ...formatHotkeyGroup("Tab Jump", hotkeysForScope("tab-jump")),
    "",
    ...formatHotkeyGroup("Home", hotkeysForScope("home")),
    "",
    "Other",
    "| Key | Action |",
    "|-----|--------|",
    "| `/` | Slash commands |",
    "| `!` | Run bash command |",
    "| `!!` | Run bash command (excluded from context) |",
  ];
  const extensions = extensionShortcuts.filter((shortcut) => shortcut.key.trim());
  if (extensions.length > 0) {
    lines.push(
      "",
      ...formatHotkeyGroup(
        "Extensions",
        extensions.map((shortcut) => ({
          key: shortcut.key,
          description: shortcut.description?.trim() || shortcut.source || "Extension shortcut",
        })),
      ),
    );
  }
  return lines.join("\n");
}

function hotkeysForScope(scope: string): Array<{ key: string; description: string }> {
  return MIXCODE_KEYMAP.filter((item) => (item.scope ?? "global") === scope).map((item) => ({
    key: item.key,
    description: item.description,
  }));
}

function formatHotkeyGroup(
  title: string,
  entries: Array<{ key: string; description: string }>,
): string[] {
  return [
    title,
    "| Key | Action |",
    "|-----|--------|",
    ...entries.map((entry) => `| \`${formatHotkey(entry.key)}\` | ${entry.description} |`),
  ];
}

function formatHotkey(key: string): string {
  if (key === "/") return "/";
  const parts = key.includes("+/") ? [key] : key.split("/");
  return parts.map((part) => formatHotkeyChord(part)).join(" / ");
}

function formatHotkeyChord(chord: string): string {
  return chord
    .trim()
    .split(/\s+/)
    .map((step) => step.split("+").map(formatHotkeySegment).join("+"))
    .join(", ");
}

function formatHotkeySegment(segment: string): string {
  const normalized = segment.trim();
  const labels: Record<string, string> = {
    alt: "Alt",
    ctrl: "Ctrl",
    down: "Down",
    end: "End",
    enter: "Enter",
    escape: "Escape",
    home: "Home",
    j: "J",
    k: "K",
    l: "L",
    left: "Left",
    pageDown: "PageDown",
    pageup: "PageUp",
    pageUp: "PageUp",
    right: "Right",
    shift: "Shift",
    space: "Space",
    tab: "Tab",
    up: "Up",
  };
  if (/^[a-z]$/.test(normalized)) return normalized.toUpperCase();
  return labels[normalized] ?? normalized;
}
