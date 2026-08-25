import {
  compositeTuiLine,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ToastNotification, ToastType } from "../../core/toast.js";
import type { MixCodeTheme } from "../themes.js";
import { padLine } from "../rendering/primitives.js";

// compositeTuiLine can drop the base line's trailing SGR reset (its "after"
// segment re-opens the styling active at the overlay edge but stops at the
// last visible column). Terminate every composited row explicitly so no open
// state leaks into content appended after the row (scrollbar cell, sidebar).
const SGR_RESET = "\x1b[0m";

const TOAST_TOP_MARGIN = 1;
const TOAST_RIGHT_MARGIN = 1;
const TOAST_MIN_BOX_WIDTH = 24;
const TOAST_MAX_BOX_WIDTH = 48;
const TOAST_MAX_WIDTH_RATIO = 0.45;
const TOAST_MAX_MESSAGE_ROWS = 3;

export function applyToastOverlay(
  lines: string[],
  toast: ToastNotification | undefined,
  width: number,
  viewportHeight: number,
  theme: MixCodeTheme,
): string[] {
  if (!toast) return lines;
  const lineWidth = Math.max(0, Math.floor(width));
  const viewportRows = Math.max(0, Math.floor(viewportHeight));
  const boxWidth = toastBoxWidth(toast, lineWidth);
  if (boxWidth === undefined) return lines;

  const contentWidth = boxWidth - 4;
  const messageRows = toastMessageRows(toast, contentWidth);
  const overlay = toastCardLines(messageRows, boxWidth, toast.type, theme);
  const requiredRows = TOAST_TOP_MARGIN + overlay.length;
  if (viewportRows < requiredRows) return lines;

  const startCol = lineWidth - TOAST_RIGHT_MARGIN - boxWidth;
  if (startCol < 0) return lines;

  const result = lines.slice();
  while (result.length < requiredRows) result.push("");
  for (let index = 0; index < overlay.length; index++) {
    const row = TOAST_TOP_MARGIN + index;
    result[row] = `${compositeTuiLine(
      result[row] ?? "",
      overlay[index]!,
      startCol,
      boxWidth,
      lineWidth,
    )}${SGR_RESET}`;
  }
  return result;
}

function toastBoxWidth(toast: ToastNotification, lineWidth: number): number | undefined {
  const maxByRatio = Math.floor(lineWidth * TOAST_MAX_WIDTH_RATIO);
  const maxBoxWidth = Math.min(
    lineWidth - TOAST_RIGHT_MARGIN,
    Math.max(TOAST_MIN_BOX_WIDTH, Math.min(TOAST_MAX_BOX_WIDTH, maxByRatio)),
  );
  if (maxBoxWidth < TOAST_MIN_BOX_WIDTH) return undefined;
  const preferredWidth = visibleWidth(`${toastIcon(toast.type)} ${toast.message}`) + 4;
  return Math.min(maxBoxWidth, Math.max(TOAST_MIN_BOX_WIDTH, preferredWidth));
}

function toastMessageRows(toast: ToastNotification, contentWidth: number): string[] {
  const rows = wrapTextWithAnsi(`${toastIcon(toast.type)} ${toast.message}`, contentWidth);
  if (rows.length <= TOAST_MAX_MESSAGE_ROWS) return rows;
  const visibleRows = rows.slice(0, TOAST_MAX_MESSAGE_ROWS);
  visibleRows[TOAST_MAX_MESSAGE_ROWS - 1] = addTrailingEllipsis(
    visibleRows[TOAST_MAX_MESSAGE_ROWS - 1] ?? "",
    contentWidth,
  );
  return visibleRows;
}

function addTrailingEllipsis(row: string, width: number): string {
  const ellipsis = "…";
  const available = Math.max(0, width - visibleWidth(ellipsis));
  return `${truncateToWidth(row.trimEnd(), available, "")}${ellipsis}`;
}

function toastCardLines(
  messageRows: string[],
  boxWidth: number,
  type: ToastType,
  theme: MixCodeTheme,
): string[] {
  const contentWidth = boxWidth - 4;
  const color = toastColor(type, theme);
  // Paint the full card (borders included). compositeTuiLine resets SGR before the
  // overlay, so borders without an explicit panel bg fall back to terminal black.
  const top = theme.panel(`${color("╭")}${color("─".repeat(boxWidth - 2))}${color("╮")}`);
  const body = messageRows.map((row, index) => {
    const content = padLine(
      styleToastRow(row, index === 0 ? type : undefined, theme),
      contentWidth,
    );
    return theme.panel(`${color("│")} ${content} ${color("│")}`);
  });
  const bottom = theme.panel(`${color("╰")}${color("─".repeat(boxWidth - 2))}${color("╯")}`);
  return [top, ...body, bottom];
}

function styleToastRow(row: string, type: ToastType | undefined, theme: MixCodeTheme): string {
  if (!type) return theme.text(row);
  const icon = toastIcon(type);
  if (!row.startsWith(icon)) return theme.text(row);
  const color = toastColor(type, theme);
  return `${color(icon)}${theme.text(row.slice(icon.length))}`;
}

function toastIcon(type: ToastType): string {
  if (type === "success") return "✓";
  if (type === "warning") return "⚠";
  if (type === "error") return "✖";
  return "•";
}

function toastColor(type: ToastType, theme: MixCodeTheme): (text: string) => string {
  if (type === "success") return theme.success;
  if (type === "warning") return theme.warning;
  if (type === "error") return theme.error;
  return theme.accent;
}
