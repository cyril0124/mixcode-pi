import { CURSOR_MARKER, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { MixCodeTheme } from "../themes.js";
import { activeRenderTheme } from "./context.js";

const FULL_RESET = "\x1b[0m";

export function padLine(text: string, width: number): string {
  const singleLine = sanitizeTerminalText(text)
    .replace(/\t/g, "  ")
    .replace(/[\r\n]+/g, " ");
  const clipped =
    visibleWidth(singleLine) <= width
      ? singleLine
      : moveFullResetAfterPadding(truncateToWidth(singleLine, width), width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

export function sanitizeTerminalText(text: string): string {
  let output = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char !== "\x1b") {
      output += isPrintableOrWhitespace(char) ? char : "";
      continue;
    }

    const next = text[index + 1];
    if (next === "[") {
      const end = findCsiEnd(text, index + 2);
      if (end === -1) break;
      const sequence = text.slice(index, end + 1);
      if (isSgrSequence(sequence)) output += sequence;
      index = end;
      continue;
    }

    if (next === "]" || next === "P" || next === "X" || next === "^" || next === "_") {
      const end = findStringControlEnd(text, index + 2);
      if (end === -1) break;
      const sequence = text.slice(index, end + 1);
      if (sequence === CURSOR_MARKER) output += sequence;
      index = end;
      continue;
    }

    if (next !== undefined) index++;
  }
  return output;
}

function isPrintableOrWhitespace(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 0x20 || char === "\n" || char === "\r" || char === "\t";
}

export function findCsiEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function isSgrSequence(sequence: string): boolean {
  return /^\x1b\[[0-9;:]*m$/.test(sequence);
}

export function findStringControlEnd(text: string, start: number): number {
  for (let index = start; index < text.length; index++) {
    if (text[index] === "\x07") return index;
    if (text[index] === "\x1b" && text[index + 1] === "\\") return index + 1;
  }
  return -1;
}

function moveFullResetAfterPadding(text: string, width: number): string {
  const withoutPreEllipsisReset = text.replaceAll(`${FULL_RESET}...`, "...");
  if (!withoutPreEllipsisReset.endsWith(FULL_RESET)) return withoutPreEllipsisReset;
  const body = withoutPreEllipsisReset.slice(0, -FULL_RESET.length);
  return `${body}${" ".repeat(Math.max(0, width - visibleWidth(body)))}${FULL_RESET}`;
}

export function box(
  title: string,
  lines: string[],
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, [], innerWidth, theme);
  const body = lines.map(
    (line) => `${theme.border("│")}${padLine(line, innerWidth)}${theme.border("│")}`,
  );
  const bottom = `${theme.border("└")}${theme.border("─".repeat(innerWidth))}${theme.border("┘")}`;
  return [top, ...body, bottom];
}

export function titledBox(
  title: string,
  meta: string[],
  lines: string[],
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, meta, innerWidth, theme);
  const body = lines.map(
    (line) => `${theme.border("│")}${padLine(line, innerWidth)}${theme.border("│")}`,
  );
  const bottom = `${theme.border("└")}${theme.border("─".repeat(innerWidth))}${theme.border("┘")}`;
  return [top, ...body, bottom];
}

export function renderBoxTop(
  title: string,
  meta: string[],
  innerWidth: number,
  theme: MixCodeTheme,
): string {
  const left = title ? ` ${title} ` : "";
  const right = meta.length ? ` ${meta.join("  |  ")} ` : "";
  const availableRightWidth = Math.max(0, innerWidth - visibleWidth(left) - 1);
  const clippedRight = right ? truncateToWidth(right, availableRightWidth) : "";
  const fillWidth = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(clippedRight));
  const line = truncateToWidth(`${left}${"─".repeat(fillWidth)}${clippedRight}`, innerWidth);
  return `${theme.border("┌")}${theme.border(padLine(line, innerWidth))}${theme.border("┐")}`;
}

export function panelBox(title: string, lines: string[], width: number): string[] {
  const theme = activeRenderTheme;
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, [], innerWidth, { ...theme, border: theme.borderDim });
  const body = lines.map(
    (line) =>
      `${theme.borderDim("│")}${theme.setupPanel(padLine(line, innerWidth))}${theme.borderDim("│")}`,
  );
  const bottom = `${theme.borderDim("└")}${theme.borderDim("─".repeat(innerWidth))}${theme.borderDim("┘")}`;
  return [padLine("", width), top, ...body, bottom];
}

export function overlayPanel(title: string, lines: string[], width: number): string[] {
  const theme = activeRenderTheme;
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, [], innerWidth, theme);
  const body = lines.map(
    (line) => `${theme.border("│")}${theme.surface(padLine(line, innerWidth))}${theme.border("│")}`,
  );
  const bottom = `${theme.border("└")}${theme.border("─".repeat(innerWidth))}${theme.border("┘")}`;
  return [top, ...body, bottom];
}
