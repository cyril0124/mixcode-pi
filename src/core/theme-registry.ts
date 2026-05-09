import type { MixCodeState } from "./types.js";

export interface ThemeInfo {
  id: string;
  label: string;
  dark: boolean;
  aliases?: string[];
}

export const THEMES: ThemeInfo[] = [
  { id: "mixcode-dark", label: "MixCode Dark", dark: true, aliases: ["dark", "mixcode"] },
  { id: "mixcode-light", label: "MixCode Light", dark: false, aliases: ["light"] },
  { id: "terminal", label: "Terminal", dark: true },
];

export function setTheme(state: MixCodeState, themeId: string): void {
  const normalized = normalizeThemeId(themeId);
  if (!normalized) {
    throw new Error(`Unknown theme: ${themeId}`);
  }
  state.theme = normalized;
}

export function themeSuggestions(prefix: string): ThemeInfo[] {
  const query = prefix.trim().toLowerCase();
  return THEMES.filter(
    (theme) =>
      !query ||
      theme.id.startsWith(query) ||
      theme.label.toLowerCase().includes(query) ||
      (theme.aliases ?? []).some((alias) => alias.startsWith(query)),
  );
}

export function normalizeThemeId(themeId: string): string | undefined {
  const normalized = themeId.trim().toLowerCase();
  return THEMES.find(
    (theme) => theme.id === normalized || (theme.aliases ?? []).includes(normalized),
  )?.id;
}

export function resolveThemeInput(themeId: string): string {
  const exact = normalizeThemeId(themeId);
  if (exact) return exact;
  const query = themeId.trim().toLowerCase();
  const matches = THEMES.filter(
    (theme) =>
      theme.id.startsWith(query) || (theme.aliases ?? []).some((alias) => alias.startsWith(query)),
  );
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) {
    throw new Error(`Ambiguous theme: ${themeId} (${matches.map((theme) => theme.id).join(", ")})`);
  }
  throw new Error(`Unknown theme: ${themeId}`);
}

export function themeArgumentCompletions(
  prefix: string,
): Array<{ value: string; label: string; description: string }> {
  const query = prefix.trim().toLowerCase();
  if (query && normalizeThemeId(query)) return [];
  const prefixMatches = new Map<string, { value: string; label: string; description: string }>();
  const labelMatches = new Map<string, { value: string; label: string; description: string }>();
  for (const theme of THEMES) {
    const description = theme.dark ? "dark theme" : "light theme";
    const names = [theme.id, ...(theme.aliases ?? [])];
    for (const name of names) {
      const item = { value: name, label: name, description };
      if (!query || name.startsWith(query)) {
        prefixMatches.set(name, item);
      } else if (theme.label.toLowerCase().includes(query)) {
        labelMatches.set(name, item);
      }
    }
  }
  return [...prefixMatches.values(), ...labelMatches.values()];
}
