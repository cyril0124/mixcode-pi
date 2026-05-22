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

const MIXCODE_DARK_THINKING_BORDERS: Record<string, (text: string) => string> = {
  off: rgb("#505050"),
  minimal: rgb("#6e6e6e"),
  low: rgb("#5f87af"),
  medium: rgb("#81a2be"),
  high: rgb("#b294bb"),
  xhigh: rgb("#d183e8"),
};

const MIXCODE_LIGHT_THINKING_BORDERS: Record<string, (text: string) => string> = {
  off: rgb("#b0b0b0"),
  minimal: rgb("#767676"),
  low: rgb("#547da7"),
  medium: rgb("#5a8080"),
  high: rgb("#875f87"),
  xhigh: rgb("#8b008b"),
};

function thinkingBorderFor(
  palette: Record<string, (text: string) => string>,
): (thinkingLevel?: string) => (text: string) => string {
  return (thinkingLevel = "off") => palette[thinkingLevel] ?? palette.off ?? identity;
}

export const MIXCODE_DARK_THEME: MixCodeTheme = {
  name: "pi-dark",
  border: rgb("#5f87ff"),
  borderDim: rgb("#505050"),
  text: rgb("#d4d4d4"),
  dim: rgb("#666666"),
  subtle: rgb("#808080"),
  accent: rgb("#8abeb7"),
  danger: rgb("#cc6666"),
  warning: rgb("#ffff00"),
  success: rgb("#b5bd68"),
  done: rgb("#b5bd68"),
  background: persistentBgRgb("#18181e"),
  surface: persistentBgRgb("#1e1e24"),
  panel: persistentBgRgb("#282832"),
  setupPanel: persistentBgRgb("#282832"),
  selection: persistentBgRgb("#3a3a4a"),
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  shellBorder: rgb("#b5bd68"),
  thinkingBorder: thinkingBorderFor(MIXCODE_DARK_THINKING_BORDERS),
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
  tool: rgb("#ffff00"),
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
  italic: (text: string) => `\x1b[3m${text}\x1b[23m`,
};

export const MIXCODE_LIGHT_THEME: MixCodeTheme = {
  name: "pi-light",
  border: rgb("#547da7"),
  borderDim: rgb("#b0b0b0"),
  text: rgb("#1f2328"),
  dim: rgb("#767676"),
  subtle: rgb("#6c6c6c"),
  accent: rgb("#5a8080"),
  danger: rgb("#aa5555"),
  warning: rgb("#9a7326"),
  success: rgb("#588458"),
  done: rgb("#588458"),
  background: persistentBgRgb("#f8f8f8"),
  surface: persistentBgRgb("#ffffff"),
  panel: persistentBgRgb("#e8e8f0"),
  setupPanel: persistentBgRgb("#e8e8f0"),
  selection: persistentBgRgb("#d0d0e0"),
  promptSurface: identity,
  shellPromptSurface: identity,
  vimPromptSurface: identity,
  shellBorder: rgb("#588458"),
  thinkingBorder: thinkingBorderFor(MIXCODE_LIGHT_THINKING_BORDERS),
  toolPendingBackground: bgPair("#e8e8f0"),
  toolSuccessBackground: bgPair("#e8f0e8"),
  toolErrorBackground: bgPair("#f0e8e8"),
  systemBackground: bgPair("#e8e8f0"),
  customMessageBackground: bgPair("#ede7f6"),
  tab: (text: string) => `${bgRgb("#e8e8f0")(rgb("#6c6c6c")(text))}`,
  activeTab: (text: string) => `${bgRgb("#d0d0e0")(rgb("#1f2328")(text))}`,
  homeTab: (text: string) => `${bgRgb("#547da7")(rgb("#ffffff")(text))}`,
  homeTabActive: (text: string) => `${bgRgb("#d0d0e0")(rgb("#5a8080")(text))}`,
  userMessage: persistentBgRgb("#e8e8e8"),
  thinking: rgb("#6c6c6c"),
  tool: rgb("#9a7326"),
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
  thinkingBorder: () => identity,
  toolPendingBackground: { start: "", end: "" },
  toolSuccessBackground: { start: "", end: "" },
  toolErrorBackground: { start: "", end: "" },
  systemBackground: { start: "", end: "" },
  customMessageBackground: { start: "", end: "" },
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
