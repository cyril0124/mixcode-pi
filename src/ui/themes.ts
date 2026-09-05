import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { DEFAULT_THEME_ID } from "../core/defaults.js";
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

function thinkingBorderFor(
  anchors: string[],
): (thinkingLevel?: string) => (text: string) => string {
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
  return formatRgb(
    hslToRgb([wrapHue(lastH + hueStep * extra), lastS, clamp(lastL + 0.04 * extra, 0.25, 0.82)]),
  );
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

function hslToRgb([hue, saturation, lightness]: [number, number, number]): [
  number,
  number,
  number,
] {
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
  scrollbarTrack: rgb("#808080"),
  scrollbarThumb: rgb("#d4d4d4"),
  accent: rgb("#8abeb7"),
  error: rgb("#d46a6a"),
  warning: rgb("#f0c674"),
  success: rgb("#b5bd68"),
  done: rgb("#b5bd68"),
  surface: persistentBgRgb("#212128"),
  panel: persistentBgRgb("#282832"),
  selectedBg: persistentBgRgb("#3a3a4a"),
  bashMode: rgb("#b5bd68"),
  vimBorder: rgb("#5f87ff"),
  thinkingBorder: thinkingBorderFor([
    "#505050",
    "#6e6e6e",
    "#5f87af",
    "#81a2be",
    "#b294bb",
    "#d183e8",
  ]),
  toolPendingBg: bgPair("#282832"),
  toolSuccessBg: bgPair("#283228"),
  toolErrorBg: bgPair("#3c2828"),
  systemBackground: bgPair("#232321"),
  customMessageBg: bgPair("#2d2838"),
  tab: (text: string) => `${bgRgb("#282832")(rgb("#808080")(text))}`,
  activeTab: (text: string) => `${bgRgb("#2f6b66")(rgb("#e8fffc")(text))}`,
  recentTab: (text: string) => `${bgRgb("#3a5552")(rgb("#d4e8e6")(text))}`,
  olderRecentTab: (text: string) => `${bgRgb("#323a42")(rgb("#b0b8c0")(text))}`,
  homeTab: (text: string) => `${bgRgb("#5f87ff")(rgb("#18181e")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#3a3a4a")(rgb("#8abeb7")(text))}`,
  workingFg: rgb("#e6b422"),
  waitingFg: rgb("#f0c674"),
  doneFg: rgb("#b5bd68"),
  errorFg: rgb("#ff8080"),
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
  scrollbarTrack: rgb("#7a7a72"),
  scrollbarThumb: rgb("#faf9f5"),
  accent: rgb("#d97757"),
  error: rgb("#d94444"),
  warning: rgb("#e6b422"),
  success: rgb("#8fa87a"),
  done: rgb("#a8c896"),
  surface: persistentBgRgb("#1c1c1a"),
  panel: persistentBgRgb("#232321"),
  selectedBg: persistentBgRgb("#7a4a3a"),
  bashMode: rgb("#dcecf4"),
  vimBorder: rgb("#c9a4ff"),
  thinkingBorder: thinkingBorderFor([
    "#3d3d3a",
    "#87867f",
    "#8f6b2f",
    "#d97757",
    "#c45d3d",
    "#a63d20",
  ]),
  toolPendingBg: bgPair("#232321"),
  toolSuccessBg: bgPair("#253020"),
  toolErrorBg: bgPair("#34211e"),
  systemBackground: bgPair("#232321"),
  customMessageBg: bgPair("#2d2538"),
  tab: (text: string) => `${bgRgb("#232321")(rgb("#87867f")(text))}`,
  activeTab: (text: string) => `${bgRgb("#8a6230")(rgb("#fff6e0")(text))}`,
  recentTab: (text: string) => `${bgRgb("#5a4a2e")(rgb("#f5ead0")(text))}`,
  olderRecentTab: (text: string) => `${bgRgb("#3a3530")(rgb("#d0c8c0")(text))}`,
  homeTab: (text: string) => `${bgRgb("#d97757")(rgb("#141413")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#a63d20")(rgb("#ffe8dc")(text))}`,
  workingFg: rgb("#f0c674"),
  waitingFg: rgb("#e6b422"),
  doneFg: rgb("#8fa87a"),
  errorFg: rgb("#ff8a80"),
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
  scrollbarTrack: rgb("#737aa2"),
  scrollbarThumb: rgb("#c0caf5"),
  accent: rgb("#7dcfff"),
  error: rgb("#f7768e"),
  warning: rgb("#e0af68"),
  success: rgb("#9ece6a"),
  done: rgb("#9ece6a"),
  surface: persistentBgRgb("#1f2335"),
  panel: persistentBgRgb("#24283b"),
  selectedBg: persistentBgRgb("#33467c"),
  bashMode: rgb("#9ece6a"),
  vimBorder: rgb("#bb9af7"),
  thinkingBorder: thinkingBorderFor([
    "#3b4261",
    "#565f89",
    "#7aa2f7",
    "#bb9af7",
    "#ff9e64",
    "#f7768e",
  ]),
  toolPendingBg: bgPair("#24283b"),
  toolSuccessBg: bgPair("#203326"),
  toolErrorBg: bgPair("#3a202c"),
  systemBackground: bgPair("#202436"),
  customMessageBg: bgPair("#29243d"),
  tab: (text: string) => `${bgRgb("#24283b")(rgb("#737aa2")(text))}`,
  activeTab: (text: string) => `${bgRgb("#1a5a6e")(rgb("#dff6ff")(text))}`,
  recentTab: (text: string) => `${bgRgb("#2a4a55")(rgb("#c8eaf5")(text))}`,
  olderRecentTab: (text: string) => `${bgRgb("#2a3048")(rgb("#a9b1d6")(text))}`,
  homeTab: (text: string) => `${bgRgb("#7aa2f7")(rgb("#1a1b26")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#2f4175")(rgb("#7dcfff")(text))}`,
  workingFg: rgb("#e0af68"),
  waitingFg: rgb("#ff9e64"),
  doneFg: rgb("#9ece6a"),
  errorFg: rgb("#f7768e"),
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
  scrollbarTrack: dim,
  scrollbarThumb: identity,
  accent: (text: string) => `\x1b[1m${text}\x1b[22m`,
  error: ansiRed,
  warning: ansiYellow,
  success: ansiGreen,
  done: ansiGreen,
  surface: identity,
  panel: identity,
  selectedBg: (text: string) => `\x1b[7m${text}\x1b[27m`,
  bashMode: ansiGreen,
  vimBorder: ansiCyan,
  thinkingBorder: terminalThinkingBorderFor(),
  toolPendingBg: { start: "", end: "" },
  toolSuccessBg: { start: "", end: "" },
  toolErrorBg: { start: "", end: "" },
  systemBackground: { start: "", end: "" },
  customMessageBg: { start: "", end: "" },
  tab: dim,
  activeTab: (text: string) => `\x1b[1m\x1b[7m${text}\x1b[27m\x1b[22m`,
  recentTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  olderRecentTab: (text: string) => `\x1b[4m${text}\x1b[24m`,
  homeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTabActive: (text: string) => `\x1b[1m\x1b[7m${text}\x1b[27m\x1b[22m`,
  workingFg: ansiYellow,
  waitingFg: ansiYellow,
  doneFg: ansiGreen,
  errorFg: ansiRed,
  userMessageBg: identity,
  thinkingText: dim,
  toolTitle: ansiYellow,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const CATPPUCCIN_THEME: MixCodeTheme = {
  name: "catppuccin",
  border: rgb("#89b4fa"),
  borderMuted: rgb("#45475a"),
  text: rgb("#cdd6f4"),
  dim: rgb("#6c7086"),
  muted: rgb("#a6adc8"),
  scrollbarTrack: rgb("#a6adc8"),
  scrollbarThumb: rgb("#cdd6f4"),
  accent: rgb("#94e2d5"),
  error: rgb("#f38ba8"),
  warning: rgb("#f9e2af"),
  success: rgb("#a6e3a1"),
  done: rgb("#a6e3a1"),
  surface: persistentBgRgb("#181825"),
  panel: persistentBgRgb("#313244"),
  selectedBg: persistentBgRgb("#45475a"),
  bashMode: rgb("#a6e3a1"),
  vimBorder: rgb("#cba6f7"),
  thinkingBorder: thinkingBorderFor([
    "#45475a",
    "#6c7086",
    "#89b4fa",
    "#cba6f7",
    "#fab387",
    "#f38ba8",
  ]),
  toolPendingBg: bgPair("#313244"),
  toolSuccessBg: bgPair("#1e2b22"),
  toolErrorBg: bgPair("#3a2228"),
  systemBackground: bgPair("#181825"),
  customMessageBg: bgPair("#2a2438"),
  tab: (text: string) => `${bgRgb("#313244")(rgb("#6c7086")(text))}`,
  activeTab: (text: string) => `${bgRgb("#2d6b63")(rgb("#e8fffc")(text))}`,
  recentTab: (text: string) => `${bgRgb("#3a5552")(rgb("#cdd6f4")(text))}`,
  olderRecentTab: (text: string) => `${bgRgb("#313244")(rgb("#a6adc8")(text))}`,
  homeTab: (text: string) => `${bgRgb("#89b4fa")(rgb("#1e1e2e")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#45475a")(rgb("#89b4fa")(text))}`,
  workingFg: rgb("#f9e2af"),
  waitingFg: rgb("#fab387"),
  doneFg: rgb("#a6e3a1"),
  errorFg: rgb("#f38ba8"),
  userMessageBg: persistentBgRgb("#181825"),
  thinkingText: rgb("#6c7086"),
  toolTitle: rgb("#fab387"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const KANAGAWA_THEME: MixCodeTheme = {
  name: "kanagawa",
  border: rgb("#7E9CD8"),
  borderMuted: rgb("#2A2A37"),
  text: rgb("#DCD7BA"),
  dim: rgb("#727169"),
  muted: rgb("#727169"),
  scrollbarTrack: rgb("#727169"),
  scrollbarThumb: rgb("#DCD7BA"),
  accent: rgb("#7AA89F"),
  error: rgb("#E82424"),
  warning: rgb("#E6C384"),
  success: rgb("#98BB6C"),
  done: rgb("#98BB6C"),
  surface: persistentBgRgb("#16161D"),
  panel: persistentBgRgb("#2A2A37"),
  selectedBg: persistentBgRgb("#363646"),
  bashMode: rgb("#98BB6C"),
  vimBorder: rgb("#957FB8"),
  thinkingBorder: thinkingBorderFor([
    "#2A2A37",
    "#727169",
    "#7E9CD8",
    "#957FB8",
    "#E6C384",
    "#FF5D62",
  ]),
  toolPendingBg: bgPair("#2A2A37"),
  toolSuccessBg: bgPair("#1e2b22"),
  toolErrorBg: bgPair("#3a2228"),
  systemBackground: bgPair("#16161D"),
  customMessageBg: bgPair("#2a2438"),
  tab: (text: string) => `${bgRgb("#2A2A37")(rgb("#727169")(text))}`,
  activeTab: (text: string) => `${bgRgb("#3d6b64")(rgb("#e8f5f2")(text))}`,
  recentTab: (text: string) => `${bgRgb("#3a4a46")(rgb("#DCD7BA")(text))}`,
  olderRecentTab: (text: string) => `${bgRgb("#2A2A37")(rgb("#C8C4A9")(text))}`,
  homeTab: (text: string) => `${bgRgb("#7E9CD8")(rgb("#1F1F28")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#363646")(rgb("#7E9CD8")(text))}`,
  workingFg: rgb("#E6C384"),
  waitingFg: rgb("#FFA066"),
  doneFg: rgb("#98BB6C"),
  errorFg: rgb("#E82424"),
  userMessageBg: persistentBgRgb("#181820"),
  thinkingText: rgb("#727169"),
  toolTitle: rgb("#E6C384"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const ROSE_PINE_THEME: MixCodeTheme = {
  name: "rose-pine",
  border: rgb("#c4a7e7"),
  borderMuted: rgb("#26233a"),
  text: rgb("#e0def4"),
  dim: rgb("#6e6a86"),
  muted: rgb("#908caa"),
  scrollbarTrack: rgb("#908caa"),
  scrollbarThumb: rgb("#e0def4"),
  accent: rgb("#9ccfd8"),
  error: rgb("#eb6f92"),
  warning: rgb("#f6c177"),
  success: rgb("#31748f"),
  done: rgb("#9ccfd8"),
  surface: persistentBgRgb("#1f1d2e"),
  panel: persistentBgRgb("#26233a"),
  selectedBg: persistentBgRgb("#403d52"),
  bashMode: rgb("#31748f"),
  vimBorder: rgb("#c4a7e7"),
  thinkingBorder: thinkingBorderFor([
    "#26233a",
    "#6e6a86",
    "#31748f",
    "#c4a7e7",
    "#f6c177",
    "#eb6f92",
  ]),
  toolPendingBg: bgPair("#26233a"),
  toolSuccessBg: bgPair("#1b2a22"),
  toolErrorBg: bgPair("#3a2228"),
  systemBackground: bgPair("#1f1d2e"),
  customMessageBg: bgPair("#2a2438"),
  tab: (text: string) => `${bgRgb("#26233a")(rgb("#6e6a86")(text))}`,
  activeTab: (text: string) => `${bgRgb("#2a5860")(rgb("#e0f4f6")(text))}`,
  recentTab: (text: string) => `${bgRgb("#2a4448")(rgb("#e0def4")(text))}`,
  olderRecentTab: (text: string) => `${bgRgb("#26233a")(rgb("#908caa")(text))}`,
  homeTab: (text: string) => `${bgRgb("#c4a7e7")(rgb("#191724")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#403d52")(rgb("#c4a7e7")(text))}`,
  workingFg: rgb("#f6c177"),
  waitingFg: rgb("#ea9a97"),
  doneFg: rgb("#9ccfd8"),
  errorFg: rgb("#eb6f92"),
  userMessageBg: persistentBgRgb("#1f1d2e"),
  thinkingText: rgb("#6e6a86"),
  toolTitle: rgb("#f6c177"),
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

export const MIXCODE_EXTENSION_CATPPUCCIN_THEME = new Theme(
  {
    accent: "#94e2d5",
    border: "#89b4fa",
    borderAccent: "#cba6f7",
    borderMuted: "#45475a",
    success: "#a6e3a1",
    error: "#f38ba8",
    warning: "#f9e2af",
    muted: "#a6adc8",
    dim: "#6c7086",
    text: "#cdd6f4",
    thinkingText: "#6c7086",
    userMessageText: "#cdd6f4",
    customMessageText: "#cdd6f4",
    customMessageLabel: "#cba6f7",
    toolTitle: "#cdd6f4",
    toolOutput: "#6c7086",
    mdHeading: "#f9e2af",
    mdLink: "#89b4fa",
    mdLinkUrl: "#6c7086",
    mdCode: "#94e2d5",
    mdCodeBlock: "#a6e3a1",
    mdCodeBlockBorder: "#6c7086",
    mdQuote: "#6c7086",
    mdQuoteBorder: "#45475a",
    mdHr: "#45475a",
    mdListBullet: "#94e2d5",
    toolDiffAdded: "#a6e3a1",
    toolDiffRemoved: "#f38ba8",
    toolDiffContext: "#6c7086",
    syntaxComment: "#6c7086",
    syntaxKeyword: "#cba6f7",
    syntaxFunction: "#89b4fa",
    syntaxVariable: "#cdd6f4",
    syntaxString: "#a6e3a1",
    syntaxNumber: "#fab387",
    syntaxType: "#94e2d5",
    syntaxOperator: "#89dceb",
    syntaxPunctuation: "#cdd6f4",
    ...thinkingThemeColors(["#45475a", "#6c7086", "#89b4fa", "#cba6f7", "#fab387", "#f38ba8"]),
    bashMode: "#a6e3a1",
  },
  {
    selectedBg: "#45475a",
    userMessageBg: "#181825",
    customMessageBg: "#2a2438",
    toolPendingBg: "#313244",
    toolSuccessBg: "#1e2b22",
    toolErrorBg: "#3a2228",
  },
  "truecolor",
  { name: "catppuccin" },
);

export const MIXCODE_EXTENSION_KANAGAWA_THEME = new Theme(
  {
    accent: "#7AA89F",
    border: "#7E9CD8",
    borderAccent: "#957FB8",
    borderMuted: "#2A2A37",
    success: "#98BB6C",
    error: "#E82424",
    warning: "#E6C384",
    muted: "#727169",
    dim: "#727169",
    text: "#DCD7BA",
    thinkingText: "#727169",
    userMessageText: "#DCD7BA",
    customMessageText: "#DCD7BA",
    customMessageLabel: "#957FB8",
    toolTitle: "#DCD7BA",
    toolOutput: "#727169",
    mdHeading: "#E6C384",
    mdLink: "#7E9CD8",
    mdLinkUrl: "#727169",
    mdCode: "#7AA89F",
    mdCodeBlock: "#98BB6C",
    mdCodeBlockBorder: "#727169",
    mdQuote: "#727169",
    mdQuoteBorder: "#2A2A37",
    mdHr: "#2A2A37",
    mdListBullet: "#7AA89F",
    toolDiffAdded: "#98BB6C",
    toolDiffRemoved: "#E82424",
    toolDiffContext: "#727169",
    syntaxComment: "#727169",
    syntaxKeyword: "#957FB8",
    syntaxFunction: "#7E9CD8",
    syntaxVariable: "#DCD7BA",
    syntaxString: "#98BB6C",
    syntaxNumber: "#D27E99",
    syntaxType: "#7AA89F",
    syntaxOperator: "#C0A36E",
    syntaxPunctuation: "#DCD7BA",
    ...thinkingThemeColors(["#2A2A37", "#727169", "#7E9CD8", "#957FB8", "#E6C384", "#FF5D62"]),
    bashMode: "#98BB6C",
  },
  {
    selectedBg: "#363646",
    userMessageBg: "#181820",
    customMessageBg: "#2a2438",
    toolPendingBg: "#2A2A37",
    toolSuccessBg: "#1e2b22",
    toolErrorBg: "#3a2228",
  },
  "truecolor",
  { name: "kanagawa" },
);

export const MIXCODE_EXTENSION_ROSE_PINE_THEME = new Theme(
  {
    accent: "#9ccfd8",
    border: "#c4a7e7",
    borderAccent: "#ebbcba",
    borderMuted: "#26233a",
    success: "#31748f",
    error: "#eb6f92",
    warning: "#f6c177",
    muted: "#908caa",
    dim: "#6e6a86",
    text: "#e0def4",
    thinkingText: "#6e6a86",
    userMessageText: "#e0def4",
    customMessageText: "#e0def4",
    customMessageLabel: "#c4a7e7",
    toolTitle: "#e0def4",
    toolOutput: "#6e6a86",
    mdHeading: "#f6c177",
    mdLink: "#c4a7e7",
    mdLinkUrl: "#6e6a86",
    mdCode: "#9ccfd8",
    mdCodeBlock: "#31748f",
    mdCodeBlockBorder: "#6e6a86",
    mdQuote: "#6e6a86",
    mdQuoteBorder: "#26233a",
    mdHr: "#26233a",
    mdListBullet: "#9ccfd8",
    toolDiffAdded: "#31748f",
    toolDiffRemoved: "#eb6f92",
    toolDiffContext: "#6e6a86",
    syntaxComment: "#6e6a86",
    syntaxKeyword: "#c4a7e7",
    syntaxFunction: "#9ccfd8",
    syntaxVariable: "#e0def4",
    syntaxString: "#f6c177",
    syntaxNumber: "#eb6f92",
    syntaxType: "#31748f",
    syntaxOperator: "#ebbcba",
    syntaxPunctuation: "#e0def4",
    ...thinkingThemeColors(["#26233a", "#6e6a86", "#31748f", "#c4a7e7", "#f6c177", "#eb6f92"]),
    bashMode: "#31748f",
  },
  {
    selectedBg: "#403d52",
    userMessageBg: "#1f1d2e",
    customMessageBg: "#2a2438",
    toolPendingBg: "#26233a",
    toolSuccessBg: "#1b2a22",
    toolErrorBg: "#3a2228",
  },
  "truecolor",
  { name: "rose-pine" },
);

/** Built-in MixCode themes with stable ids (chrome may be hand-tuned). */
export const THEMES: ThemeInfo[] = [
  { id: "mixcode-dark", label: "MixCode Dark", dark: true },
  { id: "claude-warm", label: "Claude Warm", dark: true },
  { id: "tokyo-night", label: "Tokyo Night", dark: true },
  { id: "terminal", label: "Terminal", dark: true },
  { id: "catppuccin", label: "Catppuccin", dark: true },
  { id: "kanagawa", label: "Kanagawa", dark: true },
  { id: "rose-pine", label: "Rosé Pine", dark: true },
];

/** Internal Pi Theme.name; not a user-facing MixCode theme id. */
const INTERNAL_THEME_IDS = new Set(["mixcode-extension"]);

const BUILTIN_MIXCODE: Record<string, MixCodeTheme> = {
  "mixcode-dark": MIXCODE_DARK_THEME,
  "claude-warm": CLAUDE_WARM_THEME,
  "tokyo-night": TOKYO_NIGHT_THEME,
  terminal: TERMINAL_THEME,
  catppuccin: CATPPUCCIN_THEME,
  kanagawa: KANAGAWA_THEME,
  "rose-pine": ROSE_PINE_THEME,
};

const BUILTIN_PI_THEMES: Theme[] = [
  MIXCODE_EXTENSION_THEME,
  MIXCODE_EXTENSION_CLAUDE_WARM_THEME,
  MIXCODE_EXTENSION_TOKYO_NIGHT_THEME,
  MIXCODE_EXTENSION_CATPPUCCIN_THEME,
  MIXCODE_EXTENSION_KANAGAWA_THEME,
  MIXCODE_EXTENSION_ROSE_PINE_THEME,
];

/** MixCode resolution map: id → Theme (includes loader themes). */
let themeRegistry = new Map<string, Theme>();
/** Last loader themes so in-memory register can re-merge without dropping them. */
let lastLoaderThemes: Theme[] = [];
/** Cached MixCodeTheme adapters for third-party / non-builtin ids. */
const mixCodeThemeCache = new Map<string, MixCodeTheme>();

function builtinPiById(id: string): Theme | undefined {
  if (id === "mixcode-dark" || id === "terminal") return MIXCODE_EXTENSION_THEME;
  if (id === "claude-warm") return MIXCODE_EXTENSION_CLAUDE_WARM_THEME;
  if (id === "tokyo-night") return MIXCODE_EXTENSION_TOKYO_NIGHT_THEME;
  if (id === "catppuccin") return MIXCODE_EXTENSION_CATPPUCCIN_THEME;
  if (id === "kanagawa") return MIXCODE_EXTENSION_KANAGAWA_THEME;
  if (id === "rose-pine") return MIXCODE_EXTENSION_ROSE_PINE_THEME;
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
  lastLoaderThemes = [...lastLoaderThemes.filter((entry) => entry.name !== name), theme];
  publishRegistry(next);
}

// Builtins available before ResourceLoader exists.
registerMixCodeThemes();

export function resolvePiTheme(themeId: string): Theme | undefined {
  const canonical = themeId.trim();
  if (!canonical) return undefined;
  return themeRegistry.get(canonical) ?? builtinPiById(canonical) ?? getThemeByName(canonical);
}

export function listThemeInfos(): ThemeInfo[] {
  const infos = new Map<string, ThemeInfo>();
  for (const theme of THEMES) infos.set(theme.id, theme);
  for (const id of themeRegistry.keys()) {
    if (infos.has(id) || INTERNAL_THEME_IDS.has(id)) continue;
    infos.set(id, {
      id,
      label: id,
      dark: !isLightThemeName(id),
    });
  }
  for (const name of getAvailableThemes()) {
    if (infos.has(name) || INTERNAL_THEME_IDS.has(name)) continue;
    infos.set(name, { id: name, label: name, dark: !isLightThemeName(name) });
  }
  return [...infos.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function isLightThemeName(name: string): boolean {
  return name === "light";
}

export function themeForId(themeId: string): MixCodeTheme {
  const canonical = normalizeThemeId(themeId) ?? themeId.trim();
  const builtin = BUILTIN_MIXCODE[canonical];
  if (builtin) return builtin;
  const cached = mixCodeThemeCache.get(canonical);
  if (cached) return cached;
  const piTheme = resolvePiTheme(canonical);
  if (!piTheme) throw new Error(`Error: Unknown theme: ${themeId}`);
  const adapted = mixCodeThemeFromPi(piTheme);
  mixCodeThemeCache.set(canonical, adapted);
  return adapted;
}

let activeExtensionThemeId = DEFAULT_THEME_ID;

export function noteActiveExtensionThemeId(themeId: string): void {
  const normalized = themeId.trim();
  if (normalized) activeExtensionThemeId = normalized;
}

export function getActiveExtensionThemeId(): string {
  return activeExtensionThemeId;
}

export function setTheme(state: MixCodeState, themeId: string): void {
  const normalized = normalizeThemeId(themeId);
  if (!normalized) {
    throw new Error(`Error: Unknown theme: ${themeId}`);
  }
  const piTheme = resolvePiTheme(normalized);
  if (!piTheme) {
    throw new Error(`Error: Unknown theme: ${themeId}`);
  }
  state.theme = normalized;
  // Keep extension UI (footer/widget/custom/message renderers) on the same palette.
  noteActiveExtensionThemeId(normalized);
  applyPiThemeInstance(piTheme);
}

export function normalizeThemeId(themeId: string): string | undefined {
  const normalized = themeId.trim().toLowerCase();
  if (!normalized || INTERNAL_THEME_IDS.has(normalized)) return undefined;
  if (BUILTIN_MIXCODE[normalized] || themeRegistry.has(normalized) || resolvePiTheme(normalized)) {
    return normalized;
  }
  return undefined;
}
