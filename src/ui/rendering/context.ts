import { MIXCODE_DARK_THEME as DEFAULT_RENDER_THEME, type MixCodeTheme } from "../themes.js";

export let activeRenderTheme: MixCodeTheme = DEFAULT_RENDER_THEME;

// The live UI theme, published by the root render each frame. Unlike
// activeRenderTheme (a transient stack mutated only inside renderWithTheme),
// this persists between frames so code running outside a render scope — e.g.
// overlays whose render callback the TUI compositor invokes directly — can
// resolve the user's current theme instead of falling back to the module
// default.
let currentUiTheme: MixCodeTheme = DEFAULT_RENDER_THEME;

/** Publish the live UI theme. Called by the root render once per frame. */
export function setCurrentUiTheme(theme: MixCodeTheme): void {
  currentUiTheme = theme;
}

/** Read the live UI theme (valid outside a renderWithTheme scope). */
export function getCurrentUiTheme(): MixCodeTheme {
  return currentUiTheme;
}

export function renderWithTheme<T>(theme: MixCodeTheme, render: () => T): T {
  if (theme === activeRenderTheme) return render();
  const previous = activeRenderTheme;
  activeRenderTheme = theme;
  try {
    return render();
  } finally {
    activeRenderTheme = previous;
  }
}
