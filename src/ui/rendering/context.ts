import { MIXCODE_DARK_THEME as DEFAULT_RENDER_THEME, type MixCodeTheme } from "../themes.js";

export let activeRenderTheme: MixCodeTheme = DEFAULT_RENDER_THEME;

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
