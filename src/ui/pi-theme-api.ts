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
  getMarkdownTheme,
  getThemeByName,
  highlightCode,
  initTheme,
  setRegisteredThemes,
  setThemeInstance as applyPiThemeInstance,
} from "@earendil-works/pi-coding-agent";
