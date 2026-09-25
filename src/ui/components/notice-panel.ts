/**
 * Notice/Error panel widget: a bottom-centered, non-capturing bordered box with
 * a width-wrapped message and a dim copy/Esc hint. The overlay host
 * (app-overlays.ts) owns presentation, console-line merging, and mouse
 * selection; this module owns the panel's look and terminal-relative sizing.
 */

import { visibleWidth, wrapTextWithAnsi, type OverlayOptions } from "@earendil-works/pi-tui";
import { overlayPanel } from "../rendering/primitives.js";
import { renderWithTheme } from "../rendering/context.js";
import type { MixCodeTheme } from "../themes.js";

export interface NoticeOptions {
  /** Title rendered in the panel's top border. */
  title: string;
  /** Render the border and title in the danger color (used for errors). */
  danger?: boolean;
}

const NOTICE_HINT = "c/y copy · Esc/q close";
const NOTICE_MAX_WIDTH_RATIO = 0.6;
const NOTICE_MAX_HEIGHT_RATIO = 0.6;
const NOTICE_MIN_BOX_WIDTH = 24;
// Lines consumed by panel chrome: top border, blank separator, hint line, bottom border.
const PANEL_CHROME_LINES = 4;

// Resolve the overlay width/height in terminal-relative terms. The TUI overlay
// engine has no maxWidth, only width/minWidth clamped to available space, so the
// content-fit cap at 60% screen width is computed here against the live
// terminal columns rather than expressed declaratively.
export function noticeOverlayOptions(text: string, title: string): OverlayOptions {
  const termWidth = Math.max(1, process.stdout.columns || 80);
  const termHeight = Math.max(1, process.stdout.rows || 24);
  const cap = Math.max(NOTICE_MIN_BOX_WIDTH, Math.floor(termWidth * NOTICE_MAX_WIDTH_RATIO));
  // +4: two border columns + one space of inner padding on each side.
  const longestLine = Math.max(
    visibleWidth(title) + 4,
    visibleWidth(NOTICE_HINT) + 4,
    ...text.split(/\r?\n/).map((line) => visibleWidth(line) + 4),
  );
  const width = Math.min(cap, Math.max(NOTICE_MIN_BOX_WIDTH, longestLine));
  return {
    anchor: "bottom-center",
    width,
    maxHeight: Math.max(6, Math.floor(termHeight * NOTICE_MAX_HEIGHT_RATIO)),
    margin: 1,
    offsetY: -4,
    nonCapturing: true,
  };
}

// Render a bordered notice/error panel: a titled box whose body is the
// width-wrapped message followed by a dim copy/Esc hint.
//
// When maxHeight is provided and the wrapped lines exceed the available body
// height, the oldest lines are dropped and a dim indicator is prepended so the
// panel always fits within maxHeight. The full text is still copyable via c/y.
export function renderNoticePanel(
  text: string,
  width: number,
  theme: MixCodeTheme,
  options: NoticeOptions,
  maxHeight?: number,
): string[] {
  return renderWithTheme(theme, () => {
    const innerWidth = Math.max(1, width - 4);
    const wrapped = text.split(/\r?\n/).flatMap((line) => {
      const rows = wrapTextWithAnsi(line, innerWidth);
      return rows.length > 0 ? rows : [""];
    });

    let bodyLines: string[];
    if (maxHeight !== undefined && wrapped.length > maxHeight - PANEL_CHROME_LINES) {
      // Keep the most recent lines so the panel stays within maxHeight.
      // Reserve one line for the truncation indicator itself.
      const keepCount = Math.max(0, maxHeight - PANEL_CHROME_LINES - 1);
      const hiddenCount = wrapped.length - keepCount;
      const indicator = theme.dim(
        `(${hiddenCount} earlier ${hiddenCount === 1 ? "line" : "lines"} hidden · c/y copy all)`,
      );
      bodyLines = [
        indicator,
        ...wrapped.slice(wrapped.length - keepCount).map((line) => theme.text(line)),
      ];
    } else {
      bodyLines = wrapped.map((line) => theme.text(line));
    }

    const body = [...bodyLines, "", theme.dim(NOTICE_HINT)];
    const border = options.danger ? theme.error : undefined;
    return overlayPanel(options.title, body, width, border);
  });
}
