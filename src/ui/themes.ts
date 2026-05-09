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

export const MIXCODE_DARK_THEME: MixCodeTheme = {
  name: "claude-warm",
  border: rgb("#4d4c48"),
  borderDim: rgb("#3d3d3a"),
  text: rgb("#faf9f5"),
  dim: rgb("#87867f"),
  subtle: rgb("#7a7a72"),
  accent: rgb("#d97757"),
  danger: rgb("#b53333"),
  warning: rgb("#ffff00"),
  success: rgb("#8fa87a"),
  done: rgb("#a8c896"),
  background: persistentBgRgb("#141413"),
  surface: persistentBgRgb("#1c1c1a"),
  panel: persistentBgRgb("#232321"),
  setupPanel: persistentBgRgb("#2a2a27"),
  selection: persistentBgRgb("#5e392f"),
  promptSurface: persistentBgRgb("#1c1c1a"),
  shellPromptSurface: persistentBgRgb("#1d2a33"),
  vimPromptSurface: persistentBgRgb("#2d2538"),
  shellBorder: rgb("#dcecf4"),
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

export const MIXCODE_LIGHT_THEME: MixCodeTheme = {
  name: "mixcode-light",
  border: rgb("#b8b1a5"),
  borderDim: rgb("#d2cabd"),
  text: rgb("#1f1e1c"),
  dim: rgb("#6f6a60"),
  subtle: rgb("#8a8377"),
  accent: rgb("#c45d3d"),
  danger: rgb("#9f2d2d"),
  warning: rgb("#9a7326"),
  success: rgb("#557a4e"),
  done: rgb("#4f8a46"),
  background: persistentBgRgb("#f4f2ec"),
  surface: persistentBgRgb("#ece7dc"),
  panel: persistentBgRgb("#e3ded2"),
  setupPanel: persistentBgRgb("#ebe5d8"),
  selection: persistentBgRgb("#ead1c5"),
  promptSurface: persistentBgRgb("#ece7dc"),
  shellPromptSurface: persistentBgRgb("#dcecf4"),
  vimPromptSurface: persistentBgRgb("#eadff4"),
  shellBorder: rgb("#1d2a33"),
  tab: (text: string) => `${bgRgb("#e3ded2")(rgb("#6f6a60")(text))}`,
  activeTab: (text: string) => `${bgRgb("#d2cabd")(rgb("#1f1e1c")(text))}`,
  homeTab: (text: string) => `${bgRgb("#c45d3d")(rgb("#fffaf0")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#8f3520")(rgb("#fff5ee")(text))}`,
  userMessage: persistentBgRgb("#f3e7dd"),
  thinking: rgb("#6f6a60"),
  tool: rgb("#8f6b2f"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const TERMINAL_THEME: MixCodeTheme = {
  name: "terminal",
  border: identity,
  borderDim: identity,
  text: identity,
  dim: (text: string) => `\x1b[2m${text}\x1b[22m`,
  subtle: identity,
  accent: (text: string) => `\x1b[1m${text}\x1b[22m`,
  danger: identity,
  warning: identity,
  success: identity,
  done: identity,
  background: identity,
  surface: identity,
  panel: identity,
  setupPanel: identity,
  selection: (text: string) => `\x1b[7m${text}\x1b[27m`,
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  shellBorder: identity,
  tab: identity,
  activeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTab: (text: string) => `\x1b[7m${text}\x1b[27m`,
  homeTabActive: (text: string) => `\x1b[1m\x1b[7m${text}\x1b[27m\x1b[22m`,
  userMessage: identity,
  thinking: (text: string) => `\x1b[2m${text}\x1b[22m`,
  tool: identity,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export function themeForId(themeId: string): MixCodeTheme {
  if (themeId === "mixcode-dark") return MIXCODE_DARK_THEME;
  if (themeId === "mixcode-light") return MIXCODE_LIGHT_THEME;
  if (themeId === "terminal") return TERMINAL_THEME;
  throw new Error(`Unknown theme: ${themeId}`);
}
