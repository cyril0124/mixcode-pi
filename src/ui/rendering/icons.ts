import {
  DEFAULT_ICON_MODE,
  type IconMode,
} from "../../core/mixcode-settings.js";

export type { IconMode };

export interface IconGlyphs {
  model: string;
  thinking: string;
  context: string;
  git: string;
  barFilled: string;
  barEmpty: string;
  /** Solid status dot (zen markers, extension enabled). */
  statusOn: string;
  /** Hollow status dot (extension disabled). */
  statusOff: string;
}

const NERD_GLYPHS: IconGlyphs = {
  model: "\u{f06a9}",
  thinking: "\uf0eb",
  context: "\uf0c9",
  git: "\ue0a0",
  barFilled: "█",
  barEmpty: "░",
  // U+25CF / U+25CB are geometric shapes (not PUA), kept in the rich set.
  statusOn: "\u25cf",
  statusOff: "\u25cb",
};

const ASCII_GLYPHS: IconGlyphs = {
  model: "M",
  thinking: "~",
  context: "#",
  git: "*",
  barFilled: "#",
  barEmpty: "-",
  statusOn: "*",
  statusOff: "o",
};

const NERD_FONT_TERMINALS = new Set([
  "iTerm.app",
  "Ghostty",
  "WezTerm",
  "kitty",
  "rio",
  "tabby",
  "WindowsTerminal",
  "vscode",
]);

/** Heuristic Nerd Font support from terminal env (open-tui style). */
export function detectNerdFont(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const termProgram = env.TERM_PROGRAM;
  if (termProgram && NERD_FONT_TERMINALS.has(termProgram)) return true;
  const lcTerminal = env.LC_TERMINAL;
  if (lcTerminal && NERD_FONT_TERMINALS.has(lcTerminal)) return true;
  if (env.TERM === "xterm-kitty") return true;
  if (env.WT_SESSION) return true;
  return false;
}

export function resolveIconMode(
  mode: IconMode = DEFAULT_ICON_MODE,
  env: NodeJS.ProcessEnv = process.env,
): "nerd" | "ascii" {
  if (mode === "nerd") return "nerd";
  if (mode === "ascii") return "ascii";
  return detectNerdFont(env) ? "nerd" : "ascii";
}

export function resolveGlyphs(
  mode: IconMode = DEFAULT_ICON_MODE,
  env: NodeJS.ProcessEnv = process.env,
): IconGlyphs {
  return resolveIconMode(mode, env) === "nerd" ? NERD_GLYPHS : ASCII_GLYPHS;
}
