import {
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { editTextInExternalEditor } from "../core/external-editor.js";
import type { OverlayTui } from "./app-types.js";
import { overlayPanel, padLine } from "./rendering.js";
import { getCurrentUiTheme, renderWithTheme } from "./rendering/context.js";
import type { MixCodeTheme } from "./themes.js";

const activeOverlayHandles = new WeakMap<object, OverlayHandle>();

class LinesOverlay implements Component {
  constructor(private readonly renderLines: (width: number) => string[]) {}

  invalidate(): void {}

  render(width: number): string[] {
    return this.renderLines(width)
      .flatMap((line) => line.split(/\r?\n/))
      .map((line) => padLine(line, width));
  }
}
export function showTextOverlay(tui: OverlayTui, text: string, options?: OverlayOptions): void {
  showLinesOverlay(tui, () => text.split(/\r?\n/), options);
}

export function showLinesOverlay(
  tui: OverlayTui,
  renderLines: (width: number) => string[],
  options: OverlayOptions = defaultOverlayOptions(),
): void {
  closeAppOverlay(tui);
  const handle = tui.showOverlay(new LinesOverlay(renderLines), options);
  if (isOverlayHandle(handle)) activeOverlayHandles.set(tui, handle);
}

export function closeAppOverlay(tui: OverlayTui): void {
  const handle = activeOverlayHandles.get(tui);
  if (handle) {
    handle.hide();
    activeOverlayHandles.delete(tui);
    return;
  }
  if (tui.hasOverlay?.()) tui.hideOverlay?.();
}

export function hasAppOverlay(tui: OverlayTui): boolean {
  return activeOverlayHandles.has(tui);
}

export function hasAnyOverlay(tui: OverlayTui): boolean {
  return activeOverlayHandles.has(tui) || (tui.hasOverlay?.() ?? false);
}

function isOverlayHandle(value: unknown): value is OverlayHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OverlayHandle).hide === "function"
  );
}

function defaultOverlayOptions(): OverlayOptions {
  return {
    anchor: "center",
    width: "78%",
    maxHeight: "80%",
    margin: 1,
  };
}

export function quitOverlayOptions(): OverlayOptions {
  return {
    anchor: "center",
    width: 72,
    margin: 1,
  };
}

export function renderQuitConfirm(width: number, theme: MixCodeTheme): string[] {
  return renderWithTheme(theme, () =>
    overlayPanel(
      "Quit MixCode",
      ["Are you sure you want to quit?", "", "[Y] Quit    [N] Cancel", "Esc: cancel"],
      width,
    ),
  );
}

export function showTransientTextOverlay(tui: OverlayTui, text: string): void {
  showNoticeOverlay(tui, text, { title: "Notice" });
}

export function showErrorOverlay(tui: OverlayTui, error: unknown): void {
  showNoticeOverlay(tui, errorMessage(error), { title: "Error", danger: true });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface NoticeOptions {
  /** Title rendered in the panel's top border. */
  title: string;
  /** Render the border and title in the danger color (used for errors). */
  danger?: boolean;
}

const NOTICE_ESC_HINT = "Esc to close";
const NOTICE_MAX_WIDTH_RATIO = 0.6;
const NOTICE_MAX_HEIGHT_RATIO = 0.6;
const NOTICE_MIN_BOX_WIDTH = 24;

// Bottom-centered, non-capturing notice/error panel. The message is wrapped to
// the panel width (never per-line truncated) and the panel auto-fits its
// content up to ~60% of the terminal, so the common short message stays compact
// while a long diagnostic gets enough room to read.
function showNoticeOverlay(tui: OverlayTui, text: string, options: NoticeOptions): void {
  showLinesOverlay(
    tui,
    // Resolve the live UI theme at render time. The TUI compositor invokes this
    // callback outside any renderWithTheme scope, so reading activeRenderTheme
    // here would always yield the module default and ignore the user's theme.
    (width) => renderNoticePanel(text, width, getCurrentUiTheme(), options),
    noticeOverlayOptions(text, options.title),
  );
}

// Resolve the overlay width/height in terminal-relative terms. The TUI overlay
// engine has no maxWidth, only width/minWidth clamped to available space, so the
// content-fit cap at 60% screen width is computed here against the live
// terminal columns rather than expressed declaratively.
function noticeOverlayOptions(text: string, title: string): OverlayOptions {
  const termWidth = Math.max(1, process.stdout.columns || 80);
  const termHeight = Math.max(1, process.stdout.rows || 24);
  const cap = Math.max(NOTICE_MIN_BOX_WIDTH, Math.floor(termWidth * NOTICE_MAX_WIDTH_RATIO));
  // +4: two border columns + one space of inner padding on each side.
  const longestLine = Math.max(
    visibleWidth(title) + 4,
    visibleWidth(NOTICE_ESC_HINT) + 4,
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
// width-wrapped message followed by a dim "Esc to close" hint. Exported for
// focused rendering tests.
export function renderNoticePanel(
  text: string,
  width: number,
  theme: MixCodeTheme,
  options: NoticeOptions,
): string[] {
  return renderWithTheme(theme, () => {
    const innerWidth = Math.max(1, width - 4);
    const wrapped = text
      .split(/\r?\n/)
      .flatMap((line) => {
        const rows = wrapTextWithAnsi(line, innerWidth);
        return rows.length > 0 ? rows : [""];
      })
      .map((line) => theme.text(line));
    const body = [...wrapped, "", theme.dim(NOTICE_ESC_HINT)];
    const border = options.danger ? theme.danger : undefined;
    return overlayPanel(options.title, body, width, border);
  });
}

export async function editTextWithTuiPaused(
  tui: OverlayTui,
  text: string,
  editor?: string,
): Promise<string> {
  const canPause = Boolean(tui.stop && tui.start);
  if (canPause) tui.stop?.();
  try {
    return await editTextInExternalEditor(text, { editor });
  } finally {
    if (canPause) {
      tui.start?.();
      tui.requestRender(true);
    }
  }
}
