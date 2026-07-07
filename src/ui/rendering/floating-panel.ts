import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { FloatingPanelState, FloatingPanelThemeRole } from "../../core/types.js";
import type { MixCodeTheme } from "../themes.js";
import { padLine } from "./primitives.js";

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
    result[row] = spliceVisibleLine(result[row] ?? "", startCol, panelWidth, box[index]!, terminalWidth);
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
  const border = themeRole(theme, panel.style?.border ?? "borderDim");
  const title = themeRole(theme, panel.style?.title ?? panel.style?.border ?? "borderDim");
  const bodyStyle = themeRole(theme, panel.style?.body ?? "surface");
  const highlighted = themeRole(theme, panel.style?.highlighted ?? "selection");
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

function spliceVisibleLine(
  line: string,
  startCol: number,
  replaceWidth: number,
  overlay: string,
  totalWidth: number,
): string {
  const left = truncateToWidth(line, startCol, "");
  const leftActual = visibleWidth(left);
  const gap = startCol - leftActual;
  // Preserve anything to the right of the overlay; chat scrollbars live in the
  // final column and must not be blanked by right padding.
  const suffix = visibleSuffix(line, startCol + replaceWidth);
  return truncateToWidth(padLine(`${left}${" ".repeat(gap)}${overlay}${suffix}`, totalWidth), totalWidth, "");
}

function visibleSuffix(line: string, startCol: number): string {
  let index = 0;
  let column = 0;
  while (index < line.length) {
    const ansiEnd = ansiSequenceEnd(line, index);
    if (ansiEnd !== undefined) {
      if (column >= startCol) return line.slice(index);
      index = ansiEnd;
      continue;
    }
    const codePoint = line.codePointAt(index)!;
    const charLength = codePoint > 0xffff ? 2 : 1;
    const char = line.slice(index, index + charLength);
    const charWidth = visibleWidth(char);
    if (column + charWidth > startCol) return line.slice(index);
    column += charWidth;
    index += charLength;
  }
  return "";
}

function ansiSequenceEnd(line: string, index: number): number | undefined {
  if (line[index] !== "\x1b") return undefined;
  const next = line[index + 1];
  if (next === "[") {
    const match = /\x1b\[[0-?]*[ -/]*[@-~]/.exec(line.slice(index));
    return match?.index === 0 ? index + match[0].length : undefined;
  }
  if (next === "]" || next === "_") {
    const terminator = line.indexOf("\x07", index + 2);
    const st = line.indexOf("\x1b\\", index + 2);
    const ends = [terminator >= 0 ? terminator + 1 : undefined, st >= 0 ? st + 2 : undefined]
      .filter((value): value is number => value !== undefined)
      .sort((a, b) => a - b);
    return ends[0];
  }
  return undefined;
}
