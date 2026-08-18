import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Theme } from "./pi-theme-api.js";

export interface MixCodeTheme {
  name: string;
  border: (text: string) => string;
  borderMuted: (text: string) => string;
  text: (text: string) => string;
  dim: (text: string) => string;
  muted: (text: string) => string;
  accent: (text: string) => string;
  error: (text: string) => string;
  warning: (text: string) => string;
  success: (text: string) => string;
  done: (text: string) => string;
  surface: (text: string) => string;
  panel: (text: string) => string;
  selectedBg: (text: string) => string;
  bashMode: (text: string) => string;
  vimBorder: (text: string) => string;
  thinkingBorder: (thinkingLevel?: string) => (text: string) => string;
  toolPendingBg: { start: string; end: string };
  toolSuccessBg: { start: string; end: string };
  toolErrorBg: { start: string; end: string };
  systemBackground: { start: string; end: string };
  customMessageBg: { start: string; end: string };
  tab: (text: string) => string;
  activeTab: (text: string) => string;
  recentTab: (text: string) => string;
  olderRecentTab: (text: string) => string;
  homeTab: (text: string) => string;
  homeTabActive: (text: string) => string;
  workingFg: (text: string) => string;
  waitingFg: (text: string) => string;
  doneFg: (text: string) => string;
  errorFg: (text: string) => string;
  userMessageBg: (text: string) => string;
  searchMatchBg: (text: string) => string;
  searchMatchText: (text: string) => string;
  thinkingText: (text: string) => string;
  toolTitle: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
}

/** Build MixCode TUI chrome colors from a Pi Theme via fixed token mapping. */
export function mixCodeThemeFromPi(theme: Theme): MixCodeTheme {
  const bgStart = (color: Parameters<Theme["getBgAnsi"]>[0]) => theme.getBgAnsi(color);
  const persistentBg = (color: Parameters<Theme["getBgAnsi"]>[0]) => {
    const start = bgStart(color);
    if (!start) return (text: string) => text;
    return (text: string) =>
      `${start}${text
        .replace(/\x1b\[0m/g, `\x1b[0m${start}`)
        .replace(/\x1b\[49m/g, `\x1b[49m${start}`)}\x1b[49m`;
  };
  const fg =
    (color: Parameters<Theme["fg"]>[0]) =>
    (text: string): string =>
      theme.fg(color, text);

  return {
    name: theme.name ?? "theme",
    border: fg("border"),
    borderMuted: fg("borderMuted"),
    text: fg("text"),
    dim: fg("dim"),
    muted: fg("muted"),
    accent: fg("accent"),
    error: fg("error"),
    warning: fg("warning"),
    success: fg("success"),
    done: fg("success"),
    surface: persistentBg("toolPendingBg"),
    panel: persistentBg("toolPendingBg"),
    selectedBg: persistentBg("selectedBg"),
    bashMode: (text) => theme.getBashModeBorderColor()(text),
    vimBorder: fg("borderAccent"),
    thinkingBorder: (thinkingLevel = "off") =>
      theme.getThinkingBorderColor(thinkingLevel as ThinkingLevel),
    toolPendingBg: { start: bgStart("toolPendingBg"), end: "\x1b[49m" },
    toolSuccessBg: { start: bgStart("toolSuccessBg"), end: "\x1b[49m" },
    toolErrorBg: { start: bgStart("toolErrorBg"), end: "\x1b[49m" },
    systemBackground: { start: bgStart("toolPendingBg"), end: "\x1b[49m" },
    customMessageBg: { start: bgStart("customMessageBg"), end: "\x1b[49m" },
    tab: (text) => theme.bg("toolPendingBg", theme.fg("muted", text)),
    activeTab: (text) => theme.bg("selectedBg", theme.fg("borderAccent", text)),
    recentTab: (text) => theme.bg("customMessageBg", theme.fg("text", text)),
    olderRecentTab: (text) => theme.bg("toolPendingBg", theme.fg("accent", text)),
    homeTab: (text) => theme.bg("selectedBg", theme.fg("accent", text)),
    homeTabActive: (text) => theme.bg("selectedBg", theme.fg("borderAccent", text)),
    workingFg: fg("warning"),
    waitingFg: fg("toolTitle"),
    doneFg: fg("success"),
    errorFg: fg("error"),
    userMessageBg: persistentBg("userMessageBg"),
    searchMatchBg: persistentBg("searchMatchBg"),
    searchMatchText: fg("searchMatchText"),
    thinkingText: fg("thinkingText"),
    toolTitle: fg("toolTitle"),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
  };
}
