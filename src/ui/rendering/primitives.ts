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
  return text.replace(/\x1b\[([0-9;:]*)m/g, (sequence, params: string) =>
    sgrLeavesBackgroundReset(params) ? `${sequence}${backgroundStart}` : sequence,
  );
}

function sgrLeavesBackgroundReset(rawParams: string): boolean {
  const params = rawParams === "" ? ["0"] : rawParams.split(";");
  let reset = false;

  for (let index = 0; index < params.length; index++) {
    const raw = params[index] ?? "";
    const code = Number.parseInt(raw.split(":", 1)[0] || "0", 10);
    if (!Number.isFinite(code)) continue;

    if (code === 0 || code === 49) {
      reset = true;
    } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
      reset = false;
    }

    // Skip extended-color operands so an RGB/index value of 49 is not a reset.
    if (!raw.includes(":") && (code === 38 || code === 48 || code === 58)) {
      if (code === 48) reset = false;
      const mode = Number.parseInt(params[index + 1] ?? "", 10);
      if (mode === 2) index += 4;
      else if (mode === 5) index += 2;
    } else if (code === 48) {
      reset = false;
    }
  }

  return reset;
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

/** Shared box renderer for `box` and `overlayPanel`. */
interface DrawBoxOptions {
  title: string;
  lines: string[];
  width: number;
  theme?: MixCodeTheme;
  border?: (text: string) => string;
  inner?: (text: string) => string;
  rounded?: boolean;
}

function drawBox(opts: DrawBoxOptions): string[] {
  const {
    title,
    lines,
    width,
    theme = activeRenderTheme,
    border = (text: string) => theme.border(text),
    inner,
    rounded = false,
  } = opts;
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, [], innerWidth, { ...theme, border }, rounded);
  const body = lines.map((line) => {
    const content = padLine(line, innerWidth);
    return `${border("│")}${inner ? inner(content) : content}${border("│")}`;
  });
  const [bl, br] = rounded ? ["╰", "╯"] : ["└", "┘"];
  const bottom = `${border(bl)}${border("─".repeat(innerWidth))}${border(br)}`;
  return [top, ...body, bottom];
}

export function box(
  title: string,
  lines: string[],
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return drawBox({ title, lines, width, theme });
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
