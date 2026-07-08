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

export function renderBackgroundLine(
  part: string,
  width: number,
  background: { start: string; end: string },
): string {
  const padded = padLine(part.replace(/\t/g, "  "), width);
  return `${background.start}${reapplyBackgroundAfterSgr(padded, background.start)}${background.end}`;
}

function reapplyBackgroundAfterSgr(text: string, backgroundStart: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*m/g, (sequence) => `${sequence}${backgroundStart}`);
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

/**
 * Options for {@link drawBox}, the shared box renderer that consolidates the
 * four public box helpers. The helpers differ only along these axes:
 * - `meta`: extra labels for the top rule (only `titledBox` passes any).
 * - `border`: color fn applied to the top, the `│` sides, and the bottom rule.
 * - `inner`: optional color fn wrapping each padded body line; default identity
 *   (raw `padLine`) so `box`/`titledBox` add no coloring where there was none.
 * - `leadingBlank`: prepend one blank `padLine("", width)` (only `panelBox`).
 */
interface DrawBoxOptions {
  title: string;
  meta?: string[];
  lines: string[];
  width: number;
  theme?: MixCodeTheme;
  border?: (text: string) => string;
  inner?: (text: string) => string;
  leadingBlank?: boolean;
  rounded?: boolean;
}

function drawBox(opts: DrawBoxOptions): string[] {
  const {
    title,
    meta = [],
    lines,
    width,
    theme = activeRenderTheme,
    border = (text: string) => theme.border(text),
    inner,
    leadingBlank = false,
    rounded = false,
  } = opts;
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, meta, innerWidth, { ...theme, border }, rounded);
  const body = lines.map((line) => {
    const content = padLine(line, innerWidth);
    return `${border("│")}${inner ? inner(content) : content}${border("│")}`;
  });
  const [bl, br] = rounded ? ["╰", "╯"] : ["└", "┘"];
  const bottom = `${border(bl)}${border("─".repeat(innerWidth))}${border(br)}`;
  const boxLines = [top, ...body, bottom];
  return leadingBlank ? [padLine("", width), ...boxLines] : boxLines;
}

export function box(
  title: string,
  lines: string[],
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return drawBox({ title, lines, width, theme });
}

export function titledBox(
  title: string,
  meta: string[],
  lines: string[],
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return drawBox({ title, meta, lines, width, theme });
}

export function renderBoxTop(
  title: string,
  meta: string[],
  innerWidth: number,
  theme: MixCodeTheme,
  rounded = false,
): string {
  const left = title ? ` ${title} ` : "";
  const right = meta.length ? ` ${meta.join("  |  ")} ` : "";
  const availableRightWidth = Math.max(0, innerWidth - visibleWidth(left) - 1);
  const clippedRight = right ? truncateToWidth(right, availableRightWidth) : "";
  const fillWidth = Math.max(0, innerWidth - visibleWidth(left) - visibleWidth(clippedRight));
  const line = truncateToWidth(`${left}${"─".repeat(fillWidth)}${clippedRight}`, innerWidth);
  const [tl, tr] = rounded ? ["╭", "╮"] : ["┌", "┐"];
  return `${theme.border(tl)}${theme.border(padLine(line, innerWidth))}${theme.border(tr)}`;
}

export function panelBox(title: string, lines: string[], width: number): string[] {
  const theme = activeRenderTheme;
  return drawBox({
    title,
    lines,
    width,
    theme,
    border: (text: string) => theme.borderDim(text),
    inner: (text: string) => theme.setupPanel(text),
    leadingBlank: true,
  });
}

export function overlayPanel(
  title: string,
  lines: string[],
  width: number,
  border?: (text: string) => string,
): string[] {
  const theme = activeRenderTheme;
  return drawBox({
    title,
    lines,
    width,
    theme,
    border: border ?? ((text: string) => theme.border(text)),
    inner: (text: string) => theme.surface(text),
  });
}
