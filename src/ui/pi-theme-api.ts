/**
 * Pi theme runtime API.
 *
 * Package root re-exports these from the theme module (see patch on
 * @earendil-works/pi-coding-agent). Import only from the package root so Theme
 * instances and the global registry stay single-instance.
 */
export {
  Theme,
  getAvailableThemes,
  getAvailableThemesWithPaths,
  getEditorTheme,
  getMarkdownTheme,
  getSelectListTheme,
  getThemeByName,
  highlightCode,
  initTheme,
  isLightTheme,
  loadThemeFromPath,
  setRegisteredThemes,
  setTheme as applyPiThemeByName,
  setThemeInstance as applyPiThemeInstance,
  type ThemeBg,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
