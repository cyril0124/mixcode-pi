import { compositeTuiLine, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FloatingPanelState, FloatingPanelThemeRole } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import { padLine } from "../rendering/primitives.js";

const SCROLLBAR_SAFE_RIGHT_MARGIN = 2;
const BOTTOM_GAP_ROWS = 1;

export interface FloatingPanelOverlayOptions {
  width: number;
  editorTopRow: number;
  theme: MixCodeTheme;
  now?: number;
}

export function renderFloatingPanelOverlay(
  lines: string[],
  panel: FloatingPanelState | undefined,
  options: FloatingPanelOverlayOptions,
): string[] {
  if (!panel) return lines;
  const now = options.now ?? Date.now();
  if (panel.expiresAt <= now) return lines;

  const terminalWidth = Math.max(0, Math.floor(options.width));
  const panelWidth = Math.min(Math.max(4, panel.width), terminalWidth - SCROLLBAR_SAFE_RIGHT_MARGIN);
  if (panelWidth < 4) return lines;

  const box = renderFloatingPanelBox(panel, panelWidth, options.theme);
  const editorTopIndex = Math.max(0, Math.floor(options.editorTopRow) - 1);
  const startRow = editorTopIndex - BOTTOM_GAP_ROWS - box.length;
  if (startRow < 0) return lines;
  const startCol = terminalWidth - SCROLLBAR_SAFE_RIGHT_MARGIN - panelWidth;
  if (startCol < 0) return lines;

  const result = lines.slice();
  while (result.length < startRow + box.length) result.push("");
  for (let index = 0; index < box.length; index++) {
    const row = startRow + index;
    // compositeTuiLine keeps content after the overlay so chat scrollbars survive.
    result[row] = compositeTuiLine(result[row] ?? "", box[index]!, startCol, panelWidth, terminalWidth);
  }
  return result;
}

function renderFloatingPanelBox(
  panel: FloatingPanelState,
  width: number,
  theme: MixCodeTheme,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const contentWidth = Math.max(0, width - 4);
  const border = themeRole(theme, panel.style?.border ?? "borderMuted");
  const title = themeRole(theme, panel.style?.title ?? panel.style?.border ?? "borderMuted");
  const bodyStyle = themeRole(theme, panel.style?.body ?? "surface");
  const highlighted = themeRole(theme, panel.style?.highlighted ?? "selectedBg");
  const top = renderFloatingPanelTop(panel.title, innerWidth, border, title);
  const body = panel.lines.map((line, index) => {
    const paddedContent = padLine(` ${truncateToWidth(line, contentWidth)} `, innerWidth);
    const styled = index === panel.highlightedIndex ? highlighted(paddedContent) : bodyStyle(paddedContent);
    return `${border("│")}${styled}${border("│")}`;
  });
  const bottom = `${border("╰")}${border("─".repeat(innerWidth))}${border("╯")}`;
  return [top, ...body, bottom];
}

function renderFloatingPanelTop(
  title: string,
  innerWidth: number,
  border: (text: string) => string,
  titleStyle: (text: string) => string,
): string {
  const titleText = truncateToWidth(title.trim(), Math.max(0, innerWidth - 2), "");
  const label = titleText ? ` ${titleStyle(titleText)} ` : "";
  const fill = Math.max(0, innerWidth - visibleWidth(label));
  return `${border("╭")}${label}${border("─".repeat(fill))}${border("╮")}`;
}

function themeRole(theme: MixCodeTheme, role: FloatingPanelThemeRole): (text: string) => string {
  return theme[role];
}
