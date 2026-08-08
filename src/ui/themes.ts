import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { noteActiveExtensionThemeId } from "../core/active-extension-theme-id.js";
import { allKnownThinkingLevels } from "../core/thinking-levels.js";
import type { MixCodeState } from "../core/types.js";
import {
  applyPiThemeInstance,
  getAvailableThemes,
  getThemeByName,
  setRegisteredThemes,
  Theme,
} from "./pi-theme-api.js";
import { mixCodeThemeFromPi, type MixCodeTheme } from "./theme-from-pi.js";

export type { MixCodeTheme } from "./theme-from-pi.js";

export interface ThemeInfo {
  id: string;
  label: string;
  dark: boolean;
  aliases?: string[];
}

const rgb = (hex: string) => {
  const value = hex.replace(/^#/, "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return (text: string) => `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
};
const bgRgb = (hex: string) => {
  const value = hex.replace(/^#/, "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return (text: string) => `\x1b[48;2;${r};${g};${b}m${text}\x1b[49m`;
};
const bgPair = (hex: string) => {
  const value = hex.replace(/^#/, "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  return { start: `\x1b[48;2;${r};${g};${b}m`, end: "\x1b[49m" };
};
const persistentBgRgb = (hex: string) => {
  const value = hex.replace(/^#/, "");
  const r = Number.parseInt(value.slice(0, 2), 16);
  const g = Number.parseInt(value.slice(2, 4), 16);
  const b = Number.parseInt(value.slice(4, 6), 16);
  const start = `\x1b[48;2;${r};${g};${b}m`;
  return (text: string) =>
    `${start}${text
      .replace(/\x1b\[0m/g, `\x1b[0m${start}`)
      .replace(/\x1b\[49m/g, `\x1b[49m${start}`)}\x1b[49m`;
};
const identity = (text: string) => text;

// Basic ANSI color helpers for terminal-safe themes (SGR 30-37)
const ansiRed = (text: string) => `\x1b[31m${text}\x1b[39m`;
const ansiGreen = (text: string) => `\x1b[32m${text}\x1b[39m`;
const ansiYellow = (text: string) => `\x1b[33m${text}\x1b[39m`;
const ansiBlue = (text: string) => `\x1b[34m${text}\x1b[39m`;
const ansiCyan = (text: string) => `\x1b[36m${text}\x1b[39m`;
const dim = (text: string) => `\x1b[2m${text}\x1b[22m`;

const THINKING_LEVELS = allKnownThinkingLevels();
const TERMINAL_THINKING_ANSI = [90, 37, 34, 36, 35, 95, 31, 91, 33, 93, 32, 92, 94, 96, 97];

type ThinkingThemeColors = {
  [Level in ThinkingLevel as `thinking${Capitalize<Level>}`]: string;
};

function thinkingBorderFor(anchors: string[]): (thinkingLevel?: string) => (text: string) => string {
  const colors = new Map(thinkingColorScale(anchors).map(({ level, hex }) => [level, rgb(hex)]));
  return (thinkingLevel = THINKING_LEVELS[0] ?? "off") =>
    colors.get(thinkingLevel as ThinkingLevel) ?? rgb(anchors[0] ?? "#505050");
}

function thinkingThemeColors(anchors: string[]): ThinkingThemeColors {
  return Object.fromEntries(
    thinkingColorScale(anchors).map(({ level, hex }) => [
      `thinking${level[0]!.toUpperCase()}${level.slice(1)}`,
      hex,
    ]),
  ) as ThinkingThemeColors;
}

function thinkingColorScale(anchors: string[]): Array<{ level: ThinkingLevel; hex: string }> {
  return THINKING_LEVELS.map((level, index) => ({
    level,
    hex: anchors[index] ?? extendThinkingColor(anchors, index),
  }));
}

function extendThinkingColor(anchors: string[], index: number): string {
  const last = parseRgb(anchors.at(-1) ?? "#505050");
  const previous = parseRgb(anchors.at(-2) ?? anchors.at(-1) ?? "#404040");
  const [lastH, lastS, lastL] = rgbToHsl(last);
  const [previousH] = rgbToHsl(previous);
  const hueStep = normalizeHueDelta(lastH - previousH) || 18;
  const extra = index - anchors.length + 1;
  return formatRgb(hslToRgb([wrapHue(lastH + hueStep * extra), lastS, clamp(lastL + 0.04 * extra, 0.25, 0.82)]));
}

function terminalThinkingBorderFor(): (thinkingLevel?: string) => (text: string) => string {
  return (thinkingLevel = THINKING_LEVELS[0] ?? "off") => {
    const index = Math.max(0, THINKING_LEVELS.indexOf(thinkingLevel as ThinkingLevel));
    const color = TERMINAL_THINKING_ANSI[index % TERMINAL_THINKING_ANSI.length]!;
    const cycle = Math.floor(index / TERMINAL_THINKING_ANSI.length);
    const style = cycle % 3 === 1 ? "1;" : cycle % 3 === 2 ? "4;" : "";
    const styleReset = cycle % 3 === 1 ? "\x1b[22m" : cycle % 3 === 2 ? "\x1b[24m" : "";
    return (text: string) => `\x1b[${style}${color}m${text}\x1b[39m${styleReset}`;
  };
}

function parseRgb(hex: string): [number, number, number] {
  const value = hex.replace(/^#/, "");
  return [0, 2, 4].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)) as [
    number,
    number,
    number,
  ];
}

function formatRgb(channels: [number, number, number]): string {
  return `#${channels.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

function rgbToHsl([red, green, blue]: [number, number, number]): [number, number, number] {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === r
      ? 60 * (((g - b) / delta) % 6)
      : max === g
        ? 60 * ((b - r) / delta + 2)
        : 60 * ((r - g) / delta + 4);
  return [wrapHue(hue), saturation, lightness];
}

function hslToRgb([hue, saturation, lightness]: [number, number, number]): [number, number, number] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const match = lightness - chroma / 2;
  const [r1, g1, b1] =
    hue < 60
      ? [chroma, x, 0]
      : hue < 120
        ? [x, chroma, 0]
        : hue < 180
          ? [0, chroma, x]
          : hue < 240
            ? [0, x, chroma]
            : hue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return [r1, g1, b1].map((channel) => Math.round((channel + match) * 255)) as [
    number,
    number,
    number,
  ];
}

function normalizeHueDelta(delta: number): number {
  const normalized = ((delta + 540) % 360) - 180;
  return Math.abs(normalized) < 8 ? 0 : normalized;
}

function wrapHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export const MIXCODE_DARK_THEME: MixCodeTheme = {
  name: "pi-dark",
  border: rgb("#5f87ff"),
  borderMuted: rgb("#505050"),
  text: rgb("#d4d4d4"),
  dim: rgb("#888888"),
  muted: rgb("#808080"),
  accent: rgb("#8abeb7"),
  error: rgb("#d46a6a"),
  warning: rgb("#f0c674"),
  success: rgb("#b5bd68"),
  done: rgb("#b5bd68"),
  background: persistentBgRgb("#18181e"),
  surface: persistentBgRgb("#212128"),
  panel: persistentBgRgb("#282832"),
  setupPanel: persistentBgRgb("#282832"),
  selectedBg: persistentBgRgb("#3a3a4a"),
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  bashMode: rgb("#b5bd68"),
  vimBorder: rgb("#8abeb7"),
  thinkingBorder: thinkingBorderFor(["#505050", "#6e6e6e", "#5f87af", "#81a2be", "#b294bb", "#d183e8"]),
  toolPendingBg: bgPair("#282832"),
  toolSuccessBg: bgPair("#283228"),
  toolErrorBg: bgPair("#3c2828"),
  systemBackground: bgPair("#232321"),
  customMessageBg: bgPair("#2d2838"),
  tab: (text: string) => `${bgRgb("#282832")(rgb("#808080")(text))}`,
  activeTab: (text: string) => `${bgRgb("#3a3a4a")(rgb("#d4d4d4")(text))}`,
  homeTab: (text: string) => `${bgRgb("#5f87ff")(rgb("#18181e")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#3a3a4a")(rgb("#8abeb7")(text))}`,
  userMessageBg: persistentBgRgb("#343541"),
  thinkingText: rgb("#808080"),
  toolTitle: rgb("#d4a656"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const CLAUDE_WARM_THEME: MixCodeTheme = {
  name: "claude-warm",
  border: rgb("#4d4c48"),
  borderMuted: rgb("#3d3d3a"),
  text: rgb("#faf9f5"),
  dim: rgb("#87867f"),
  muted: rgb("#7a7a72"),
  accent: rgb("#d97757"),
  error: rgb("#d94444"),
  warning: rgb("#e6b422"),
  success: rgb("#8fa87a"),
  done: rgb("#a8c896"),
  background: persistentBgRgb("#141413"),
  surface: persistentBgRgb("#1c1c1a"),
  panel: persistentBgRgb("#232321"),
  setupPanel: persistentBgRgb("#2a2a27"),
  selectedBg: persistentBgRgb("#7a4a3a"),
  promptSurface: persistentBgRgb("#1c1c1a"),
  shellPromptSurface: persistentBgRgb("#1d2a33"),
  vimPromptSurface: persistentBgRgb("#332a45"),
  bashMode: rgb("#dcecf4"),
  vimBorder: rgb("#c9a4ff"),
  thinkingBorder: thinkingBorderFor(["#3d3d3a", "#87867f", "#8f6b2f", "#d97757", "#c45d3d", "#a63d20"]),
  toolPendingBg: bgPair("#232321"),
  toolSuccessBg: bgPair("#253020"),
  toolErrorBg: bgPair("#34211e"),
  systemBackground: bgPair("#232321"),
  customMessageBg: bgPair("#2d2538"),
  tab: (text: string) => `${bgRgb("#232321")(rgb("#87867f")(text))}`,
  activeTab: (text: string) => `${bgRgb("#3d3d3a")(rgb("#faf9f5")(text))}`,
  homeTab: (text: string) => `${bgRgb("#d97757")(rgb("#141413")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#a63d20")(rgb("#ffe8dc")(text))}`,
  userMessageBg: persistentBgRgb("#221d1a"),
  thinkingText: rgb("#87867f"),
  toolTitle: rgb("#d6b25e"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const TOKYO_NIGHT_THEME: MixCodeTheme = {
  name: "tokyo-night",
  border: rgb("#7aa2f7"),
  borderMuted: rgb("#3b4261"),
  text: rgb("#c0caf5"),
  dim: rgb("#66709c"),
  muted: rgb("#737aa2"),
  accent: rgb("#7dcfff"),
  error: rgb("#f7768e"),
  warning: rgb("#e0af68"),
  success: rgb("#9ece6a"),
  done: rgb("#9ece6a"),
  background: persistentBgRgb("#1a1b26"),
  surface: persistentBgRgb("#1f2335"),
  panel: persistentBgRgb("#24283b"),
  setupPanel: persistentBgRgb("#292e42"),
  selectedBg: persistentBgRgb("#33467c"),
  promptSurface: persistentBgRgb("#1f2335"),
  shellPromptSurface: persistentBgRgb("#1b2a3a"),
  vimPromptSurface: persistentBgRgb("#2a2440"),
  bashMode: rgb("#9ece6a"),
  vimBorder: rgb("#bb9af7"),
  thinkingBorder: thinkingBorderFor(["#3b4261", "#565f89", "#7aa2f7", "#bb9af7", "#ff9e64", "#f7768e"]),
  toolPendingBg: bgPair("#24283b"),
  toolSuccessBg: bgPair("#203326"),
  toolErrorBg: bgPair("#3a202c"),
  systemBackground: bgPair("#202436"),
  customMessageBg: bgPair("#29243d"),
  tab: (text: string) => `${bgRgb("#24283b")(rgb("#737aa2")(text))}`,
  activeTab: (text: string) => `${bgRgb("#33467c")(rgb("#c0caf5")(text))}`,
  homeTab: (text: string) => `${bgRgb("#7aa2f7")(rgb("#1a1b26")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#2f4175")(rgb("#7dcfff")(text))}`,
  userMessageBg: persistentBgRgb("#25293c"),
  thinkingText: rgb("#66709c"),
  toolTitle: rgb("#ff9e64"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const TERMINAL_THEME: MixCodeTheme = {
  name: "terminal",
  border: ansiBlue,
  borderMuted: dim,
  text: identity,
  dim: dim,
  muted: dim,
  accent: (text: string) => `\x1b[1m${text}\x1b[22m`,
  error: ansiRed,
  warning: ansiYellow,
  success: ansiGreen,
  done: ansiGreen,
  background: identity,
  surface: identity,
  panel: identity,
  setupPanel: identity,
  selectedBg: (text: string) => `\x1b[7m${text}\x1b[27m`,
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  bashMode: ansiGreen,
  vimBorder: ansiCyan,
  thinkingBorder: terminalThinkingBorderFor(),
  toolPendingBg: { start: "", end: "" },
  toolSuccessBg: { start: "", end: "" },
  toolErrorBg: { start: "", end: "" },
  systemBackground: { start: "", end: "" },
  customMessageBg: { start: "", end: "" },
  tab: dim,
  activeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTabActive: (text: string) => `\x1b[1m\x1b[7m${text}\x1b[27m\x1b[22m`,
  userMessageBg: identity,
  thinkingText: dim,
  toolTitle: ansiYellow,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const MIXCODE_EXTENSION_THEME = new Theme(
  {
    accent: "#8abeb7",
    border: "#5f87ff",
    borderAccent: "#00d7ff",
    borderMuted: "#505050",
    success: "#b5bd68",
    error: "#d46a6a",
    warning: "#f0c674",
    muted: "#808080",
    dim: "#888888",
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
    toolDiffRemoved: "#d46a6a",
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
    ...thinkingThemeColors(["#505050", "#6e6e6e", "#5f87af", "#81a2be", "#b294bb", "#d183e8"]),
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
  { name: "mixcode-dark" },
);

export const MIXCODE_EXTENSION_TOKYO_NIGHT_THEME = new Theme(
  {
    accent: "#8abeb7",
    border: "#7aa2f7",
    borderAccent: "#bb9af7",
    borderMuted: "#3b4261",
    success: "#9ece6a",
    error: "#f7768e",
    warning: "#e0af68",
    muted: "#737aa2",
    dim: "#66709c",
    text: "#c0caf5",
    thinkingText: "#66709c",
    userMessageText: "#c0caf5",
    customMessageText: "#c0caf5",
    customMessageLabel: "#bb9af7",
    toolTitle: "#c0caf5",
    toolOutput: "#737aa2",
    mdHeading: "#e0af68",
    mdLink: "#7aa2f7",
    mdLinkUrl: "#66709c",
    mdCode: "#7dcfff",
    mdCodeBlock: "#9ece6a",
    mdCodeBlockBorder: "#66709c",
    mdQuote: "#737aa2",
    mdQuoteBorder: "#3b4261",
    mdHr: "#3b4261",
    mdListBullet: "#7dcfff",
    toolDiffAdded: "#9ece6a",
    toolDiffRemoved: "#f7768e",
    toolDiffContext: "#737aa2",
    syntaxComment: "#66709c",
    syntaxKeyword: "#bb9af7",
    syntaxFunction: "#7aa2f7",
    syntaxVariable: "#c0caf5",
    syntaxString: "#9ece6a",
    syntaxNumber: "#ff9e64",
    syntaxType: "#2ac3de",
    syntaxOperator: "#89ddff",
    syntaxPunctuation: "#c0caf5",
    ...thinkingThemeColors(["#3b4261", "#565f89", "#7aa2f7", "#bb9af7", "#ff9e64", "#f7768e"]),
    bashMode: "#9ece6a",
  },
  {
    selectedBg: "#33467c",
    userMessageBg: "#25293c",
    customMessageBg: "#29243d",
    toolPendingBg: "#24283b",
    toolSuccessBg: "#203326",
    toolErrorBg: "#3a202c",
  },
  "truecolor",
  { name: "tokyo-night" },
);

export const MIXCODE_EXTENSION_CLAUDE_WARM_THEME = new Theme(
  {
    accent: "#8abeb7",
    border: "#4d4c48",
    borderAccent: "#d97757",
    borderMuted: "#3d3d3a",
    success: "#8fa87a",
    error: "#d94444",
    warning: "#e6b422",
    muted: "#7a7a72",
    dim: "#87867f",
    text: "#faf9f5",
    thinkingText: "#87867f",
    userMessageText: "#faf9f5",
    customMessageText: "#faf9f5",
    customMessageLabel: "#d97757",
    toolTitle: "#faf9f5",
    toolOutput: "#87867f",
    mdHeading: "#d6b25e",
    mdLink: "#d97757",
    mdLinkUrl: "#87867f",
    mdCode: "#8fa87a",
    mdCodeBlock: "#a8c896",
    mdCodeBlockBorder: "#87867f",
    mdQuote: "#87867f",
    mdQuoteBorder: "#3d3d3a",
    mdHr: "#3d3d3a",
    mdListBullet: "#d97757",
    toolDiffAdded: "#8fa87a",
    toolDiffRemoved: "#d94444",
    toolDiffContext: "#87867f",
    syntaxComment: "#87867f",
    syntaxKeyword: "#d97757",
    syntaxFunction: "#d6b25e",
    syntaxVariable: "#faf9f5",
    syntaxString: "#8fa87a",
    syntaxNumber: "#d97757",
    syntaxType: "#8fa87a",
    syntaxOperator: "#faf9f5",
    syntaxPunctuation: "#7a7a72",
    ...thinkingThemeColors(["#3d3d3a", "#87867f", "#8f6b2f", "#d97757", "#c45d3d", "#a63d20"]),
    bashMode: "#dcecf4",
  },
  {
    selectedBg: "#7a4a3a",
    userMessageBg: "#221d1a",
    customMessageBg: "#2d2538",
    toolPendingBg: "#232321",
    toolSuccessBg: "#253020",
    toolErrorBg: "#34211e",
  },
  "truecolor",
  { name: "claude-warm" },
);

/** Terminal uses the same Pi Theme tokens as mixcode-dark; TUI chrome stays ANSI via TERMINAL_THEME. */
export const MIXCODE_EXTENSION_TERMINAL_THEME = MIXCODE_EXTENSION_THEME;

/** Built-in MixCode themes with stable ids / aliases (chrome may be hand-tuned). */
export const THEMES: ThemeInfo[] = [
  { id: "mixcode-dark", label: "MixCode Dark", dark: true, aliases: ["dark", "mixcode"] },
  { id: "claude-warm", label: "Claude Warm", dark: true, aliases: ["claude", "warm"] },
  { id: "tokyo-night", label: "Tokyo Night", dark: true, aliases: ["tokyo", "toyko"] },
  { id: "terminal", label: "Terminal", dark: true },
];

const THEME_ALIASES: Record<string, string> = Object.fromEntries(
  THEMES.flatMap((theme) => [
    [theme.id, theme.id],
    ...(theme.aliases ?? []).map((alias) => [alias, theme.id] as const),
  ]),
);
// Legacy extension theme name used by older tests / packages.
THEME_ALIASES["mixcode-extension"] = "mixcode-dark";

const BUILTIN_MIXCODE: Record<string, MixCodeTheme> = {
  "mixcode-dark": MIXCODE_DARK_THEME,
  "claude-warm": CLAUDE_WARM_THEME,
  "tokyo-night": TOKYO_NIGHT_THEME,
  terminal: TERMINAL_THEME,
};

const BUILTIN_PI_THEMES: Theme[] = [
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
];

/** MixCode resolution map: id → Theme (includes aliases and loader themes). */
let themeRegistry = new Map<string, Theme>();
/** Last loader themes so in-memory register can re-merge without dropping them. */
let lastLoaderThemes: Theme[] = [];
/** Cached MixCodeTheme adapters for third-party / non-builtin ids. */
const mixCodeThemeCache = new Map<string, MixCodeTheme>();

function builtinPiById(id: string): Theme | undefined {
  if (id === "mixcode-dark" || id === "terminal") return MIXCODE_EXTENSION_THEME;
  if (id === "claude-warm") return MIXCODE_EXTENSION_CLAUDE_WARM_THEME;
  if (id === "tokyo-night") return MIXCODE_EXTENSION_TOKYO_NIGHT_THEME;
  return undefined;
}

function publishRegistry(next: Map<string, Theme>): void {
  themeRegistry = next;
  // Pi registry keys by Theme.name only — unique named instances.
  const unique = new Map<string, Theme>();
  for (const theme of next.values()) {
    if (theme.name) unique.set(theme.name, theme);
  }
  setRegisteredThemes([...unique.values()]);
  mixCodeThemeCache.clear();
}

/** Register builtins + ResourceLoader themes. Loader wins on name collision. */
export function registerMixCodeThemes(loaderThemes: readonly Theme[] = []): void {
  lastLoaderThemes = [...loaderThemes];
  const next = new Map<string, Theme>();
  for (const theme of BUILTIN_PI_THEMES) {
    if (theme.name) next.set(theme.name, theme);
  }
  // terminal shares mixcode-dark Theme instance; list it as its own id in MixCode map.
  next.set("terminal", MIXCODE_EXTENSION_THEME);
  next.set("mixcode-extension", MIXCODE_EXTENSION_THEME);
  for (const theme of loaderThemes) {
    if (theme.name) next.set(theme.name, theme);
  }
  publishRegistry(next);
}

/** Add/replace one named Theme without dropping loader themes. */
export function registerAdditionalTheme(theme: Theme): void {
  const name = theme.name?.trim();
  if (!name) throw new Error("Theme must have a name");
  const next = new Map(themeRegistry);
  next.set(name, theme);
  // Keep loader list aware of in-memory themes for the next full register.
  lastLoaderThemes = [
    ...lastLoaderThemes.filter((entry) => entry.name !== name),
    theme,
  ];
  publishRegistry(next);
}

// Builtins available before ResourceLoader exists.
registerMixCodeThemes();

export function resolvePiTheme(themeId: string): Theme | undefined {
  const canonical = THEME_ALIASES[themeId.trim().toLowerCase()] ?? themeId.trim();
  if (!canonical) return undefined;
  return (
    themeRegistry.get(canonical) ??
    builtinPiById(canonical) ??
    // Skip pure alias keys that shadow Pi builtins (e.g. "dark" → mixcode-dark).
    (THEME_ALIASES[canonical] && THEME_ALIASES[canonical] !== canonical
      ? undefined
      : getThemeByName(canonical))
  );
}

export function listThemeInfos(): ThemeInfo[] {
  const infos = new Map<string, ThemeInfo>();
  for (const theme of THEMES) infos.set(theme.id, theme);
  for (const id of themeRegistry.keys()) {
    if (infos.has(id)) continue;
    // Hide pure alias keys from the picker.
    if (THEME_ALIASES[id] && THEME_ALIASES[id] !== id) continue;
    infos.set(id, {
      id,
      label: id,
      dark: !isLightThemeName(id),
    });
  }
  for (const name of getAvailableThemes()) {
    if (infos.has(name)) continue;
    if (THEME_ALIASES[name] && THEME_ALIASES[name] !== name) continue;
    infos.set(name, { id: name, label: name, dark: !isLightThemeName(name) });
  }
  return [...infos.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isLightThemeName(name: string): boolean {
  try {
    // Prefer Pi helper when the theme is loadable as JSON; fall back to id.
    return name === "light";
  } catch {
    return false;
  }
}

export function themeForId(themeId: string): MixCodeTheme {
  const canonical = normalizeThemeId(themeId) ?? themeId.trim();
  const builtin = BUILTIN_MIXCODE[canonical];
  if (builtin) return builtin;
  const cached = mixCodeThemeCache.get(canonical);
  if (cached) return cached;
  const piTheme = resolvePiTheme(canonical);
  if (!piTheme) throw new Error(`Unknown theme: ${themeId}`);
  const adapted = mixCodeThemeFromPi(piTheme);
  mixCodeThemeCache.set(canonical, adapted);
  return adapted;
}

export function setTheme(state: MixCodeState, themeId: string): void {
  const normalized = normalizeThemeId(themeId);
  if (!normalized) {
    throw new Error(`Unknown theme: ${themeId}`);
  }
  const piTheme = resolvePiTheme(normalized);
  if (!piTheme) {
    throw new Error(`Unknown theme: ${themeId}`);
  }
  state.theme = normalized;
  // Keep extension UI (footer/widget/custom/message renderers) on the same palette.
  noteActiveExtensionThemeId(normalized);
  applyPiThemeInstance(piTheme);
}

export function themeSuggestions(prefix: string): ThemeInfo[] {
  const query = prefix.trim().toLowerCase();
  return listThemeInfos().filter(
    (theme) =>
      !query ||
      theme.id.startsWith(query) ||
      theme.label.toLowerCase().includes(query) ||
      (theme.aliases ?? []).some((alias) => alias.startsWith(query)),
  );
}

export function normalizeThemeId(themeId: string): string | undefined {
  const normalized = themeId.trim().toLowerCase();
  if (!normalized) return undefined;
  const aliased = THEME_ALIASES[normalized] ?? normalized;
  if (BUILTIN_MIXCODE[aliased] || themeRegistry.has(aliased) || resolvePiTheme(aliased)) {
    return aliased;
  }
  return undefined;
}

export function resolveThemeInput(themeId: string): string {
  const exact = normalizeThemeId(themeId);
  if (exact) return exact;
  const query = themeId.trim().toLowerCase();
  const matches = listThemeInfos().filter(
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
  for (const theme of listThemeInfos()) {
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
