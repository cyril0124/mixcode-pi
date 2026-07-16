import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Theme } from "@earendil-works/pi-coding-agent";
import { noteActiveExtensionThemeId } from "../core/active-extension-theme-id.js";
import { allKnownThinkingLevels } from "../core/thinking-levels.js";
import type { MixCodeState } from "../core/types.js";

export interface MixCodeTheme {
  name: string;
  border: (text: string) => string;
  borderDim: (text: string) => string;
  text: (text: string) => string;
  dim: (text: string) => string;
  subtle: (text: string) => string;
  accent: (text: string) => string;
  danger: (text: string) => string;
  warning: (text: string) => string;
  success: (text: string) => string;
  done: (text: string) => string;
  background: (text: string) => string;
  surface: (text: string) => string;
  panel: (text: string) => string;
  setupPanel: (text: string) => string;
  selection: (text: string) => string;
  promptSurface: (text: string) => string;
  shellPromptSurface: (text: string) => string;
  vimPromptSurface: (text: string) => string;
  shellBorder: (text: string) => string;
  vimBorder: (text: string) => string;
  thinkingBorder: (thinkingLevel?: string) => (text: string) => string;
  toolPendingBackground: { start: string; end: string };
  toolSuccessBackground: { start: string; end: string };
  toolErrorBackground: { start: string; end: string };
  systemBackground: { start: string; end: string };
  customMessageBackground: { start: string; end: string };
  tab: (text: string) => string;
  activeTab: (text: string) => string;
  homeTab: (text: string) => string;
  homeTabActive: (text: string) => string;
  userMessage: (text: string) => string;
  thinking: (text: string) => string;
  tool: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
}

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
  borderDim: rgb("#505050"),
  text: rgb("#d4d4d4"),
  dim: rgb("#888888"),
  subtle: rgb("#808080"),
  accent: rgb("#8abeb7"),
  danger: rgb("#d46a6a"),
  warning: rgb("#f0c674"),
  success: rgb("#b5bd68"),
  done: rgb("#b5bd68"),
  background: persistentBgRgb("#18181e"),
  surface: persistentBgRgb("#212128"),
  panel: persistentBgRgb("#282832"),
  setupPanel: persistentBgRgb("#282832"),
  selection: persistentBgRgb("#3a3a4a"),
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  shellBorder: rgb("#b5bd68"),
  vimBorder: rgb("#8abeb7"),
  thinkingBorder: thinkingBorderFor(["#505050", "#6e6e6e", "#5f87af", "#81a2be", "#b294bb", "#d183e8"]),
  toolPendingBackground: bgPair("#282832"),
  toolSuccessBackground: bgPair("#283228"),
  toolErrorBackground: bgPair("#3c2828"),
  systemBackground: bgPair("#232321"),
  customMessageBackground: bgPair("#2d2838"),
  tab: (text: string) => `${bgRgb("#282832")(rgb("#808080")(text))}`,
  activeTab: (text: string) => `${bgRgb("#3a3a4a")(rgb("#d4d4d4")(text))}`,
  homeTab: (text: string) => `${bgRgb("#5f87ff")(rgb("#18181e")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#3a3a4a")(rgb("#8abeb7")(text))}`,
  userMessage: persistentBgRgb("#343541"),
  thinking: rgb("#808080"),
  tool: rgb("#d4a656"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const CLAUDE_WARM_THEME: MixCodeTheme = {
  name: "claude-warm",
  border: rgb("#4d4c48"),
  borderDim: rgb("#3d3d3a"),
  text: rgb("#faf9f5"),
  dim: rgb("#87867f"),
  subtle: rgb("#7a7a72"),
  accent: rgb("#d97757"),
  danger: rgb("#d94444"),
  warning: rgb("#e6b422"),
  success: rgb("#8fa87a"),
  done: rgb("#a8c896"),
  background: persistentBgRgb("#141413"),
  surface: persistentBgRgb("#1c1c1a"),
  panel: persistentBgRgb("#232321"),
  setupPanel: persistentBgRgb("#2a2a27"),
  selection: persistentBgRgb("#7a4a3a"),
  promptSurface: persistentBgRgb("#1c1c1a"),
  shellPromptSurface: persistentBgRgb("#1d2a33"),
  vimPromptSurface: persistentBgRgb("#332a45"),
  shellBorder: rgb("#dcecf4"),
  vimBorder: rgb("#c9a4ff"),
  thinkingBorder: thinkingBorderFor(["#3d3d3a", "#87867f", "#8f6b2f", "#d97757", "#c45d3d", "#a63d20"]),
  toolPendingBackground: bgPair("#232321"),
  toolSuccessBackground: bgPair("#253020"),
  toolErrorBackground: bgPair("#34211e"),
  systemBackground: bgPair("#232321"),
  customMessageBackground: bgPair("#2d2538"),
  tab: (text: string) => `${bgRgb("#232321")(rgb("#87867f")(text))}`,
  activeTab: (text: string) => `${bgRgb("#3d3d3a")(rgb("#faf9f5")(text))}`,
  homeTab: (text: string) => `${bgRgb("#d97757")(rgb("#141413")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#a63d20")(rgb("#ffe8dc")(text))}`,
  userMessage: persistentBgRgb("#221d1a"),
  thinking: rgb("#87867f"),
  tool: rgb("#d6b25e"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const TOKYO_NIGHT_THEME: MixCodeTheme = {
  name: "tokyo-night",
  border: rgb("#7aa2f7"),
  borderDim: rgb("#3b4261"),
  text: rgb("#c0caf5"),
  dim: rgb("#565f89"),
  subtle: rgb("#737aa2"),
  accent: rgb("#7dcfff"),
  danger: rgb("#f7768e"),
  warning: rgb("#e0af68"),
  success: rgb("#9ece6a"),
  done: rgb("#9ece6a"),
  background: persistentBgRgb("#1a1b26"),
  surface: persistentBgRgb("#1f2335"),
  panel: persistentBgRgb("#24283b"),
  setupPanel: persistentBgRgb("#292e42"),
  selection: persistentBgRgb("#33467c"),
  promptSurface: persistentBgRgb("#1f2335"),
  shellPromptSurface: persistentBgRgb("#1b2a3a"),
  vimPromptSurface: persistentBgRgb("#2a2440"),
  shellBorder: rgb("#9ece6a"),
  vimBorder: rgb("#bb9af7"),
  thinkingBorder: thinkingBorderFor(["#3b4261", "#565f89", "#7aa2f7", "#bb9af7", "#ff9e64", "#f7768e"]),
  toolPendingBackground: bgPair("#24283b"),
  toolSuccessBackground: bgPair("#203326"),
  toolErrorBackground: bgPair("#3a202c"),
  systemBackground: bgPair("#202436"),
  customMessageBackground: bgPair("#29243d"),
  tab: (text: string) => `${bgRgb("#24283b")(rgb("#737aa2")(text))}`,
  activeTab: (text: string) => `${bgRgb("#33467c")(rgb("#c0caf5")(text))}`,
  homeTab: (text: string) => `${bgRgb("#7aa2f7")(rgb("#1a1b26")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#2f4175")(rgb("#7dcfff")(text))}`,
  userMessage: persistentBgRgb("#25293c"),
  thinking: rgb("#565f89"),
  tool: rgb("#ff9e64"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const TERMINAL_THEME: MixCodeTheme = {
  name: "terminal",
  border: ansiBlue,
  borderDim: dim,
  text: identity,
  dim: dim,
  subtle: dim,
  accent: (text: string) => `\x1b[1m${text}\x1b[22m`,
  danger: ansiRed,
  warning: ansiYellow,
  success: ansiGreen,
  done: ansiGreen,
  background: identity,
  surface: identity,
  panel: identity,
  setupPanel: identity,
  selection: (text: string) => `\x1b[7m${text}\x1b[27m`,
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  shellBorder: ansiGreen,
  vimBorder: ansiCyan,
  thinkingBorder: terminalThinkingBorderFor(),
  toolPendingBackground: { start: "", end: "" },
  toolSuccessBackground: { start: "", end: "" },
  toolErrorBackground: { start: "", end: "" },
  systemBackground: { start: "", end: "" },
  customMessageBackground: { start: "", end: "" },
  tab: dim,
  activeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTabActive: (text: string) => `\x1b[1m\x1b[7m${text}\x1b[27m\x1b[22m`,
  userMessage: identity,
  thinking: dim,
  tool: ansiYellow,
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
  { name: "mixcode-extension" },
);

export const MIXCODE_EXTENSION_TOKYO_NIGHT_THEME = new Theme(
  {
    accent: "#7dcfff",
    border: "#7aa2f7",
    borderAccent: "#bb9af7",
    borderMuted: "#3b4261",
    success: "#9ece6a",
    error: "#f7768e",
    warning: "#e0af68",
    muted: "#737aa2",
    dim: "#565f89",
    text: "#c0caf5",
    thinkingText: "#565f89",
    userMessageText: "#c0caf5",
    customMessageText: "#c0caf5",
    customMessageLabel: "#bb9af7",
    toolTitle: "#c0caf5",
    toolOutput: "#737aa2",
    mdHeading: "#e0af68",
    mdLink: "#7aa2f7",
    mdLinkUrl: "#565f89",
    mdCode: "#7dcfff",
    mdCodeBlock: "#9ece6a",
    mdCodeBlockBorder: "#565f89",
    mdQuote: "#737aa2",
    mdQuoteBorder: "#3b4261",
    mdHr: "#3b4261",
    mdListBullet: "#7dcfff",
    toolDiffAdded: "#9ece6a",
    toolDiffRemoved: "#f7768e",
    toolDiffContext: "#737aa2",
    syntaxComment: "#565f89",
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
    accent: "#d97757",
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

export const MIXCODE_EXTENSION_TERMINAL_THEME = MIXCODE_EXTENSION_THEME;

export const THEMES: ThemeInfo[] = [
  { id: "mixcode-dark", label: "MixCode Dark", dark: true, aliases: ["dark", "mixcode"] },
  { id: "claude-warm", label: "Claude Warm", dark: true, aliases: ["claude", "warm"] },
  { id: "tokyo-night", label: "Tokyo Night", dark: true, aliases: ["tokyo", "toyko"] },
  { id: "terminal", label: "Terminal", dark: true },
];

export function themeForId(themeId: string): MixCodeTheme {
  if (themeId === "mixcode-dark") return MIXCODE_DARK_THEME;
  if (themeId === "claude-warm") return CLAUDE_WARM_THEME;
  if (themeId === "tokyo-night") return TOKYO_NIGHT_THEME;
  if (themeId === "terminal") return TERMINAL_THEME;
  throw new Error(`Unknown theme: ${themeId}`);
}

export function setTheme(state: MixCodeState, themeId: string): void {
  const normalized = normalizeThemeId(themeId);
  if (!normalized) {
    throw new Error(`Unknown theme: ${themeId}`);
  }
  state.theme = normalized;
  // Keep extension UI (footer/widget/custom/message renderers) on the same palette.
  noteActiveExtensionThemeId(normalized);
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
