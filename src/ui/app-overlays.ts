import {
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  type ChatSelectionState,
  type ChatSurfaceBounds,
  highlightChatSelectionLine,
  selectedChatText,
} from "../core/chat-selection.js";
import { editTextInExternalEditor } from "../core/external-editor.js";
import type { OverlayTui } from "./app-types.js";
import { overlayPanel, padLine } from "./rendering.js";
import { getCurrentUiTheme, renderWithTheme } from "./rendering/context.js";
import type { MixCodeTheme } from "./themes.js";

const activeOverlayHandles = new WeakMap<object, OverlayHandle>();

/** Live Notice/Error panel state for mouse select + full-text copy. */
export interface ActiveNotice {
  text: string;
  title: string;
  danger?: boolean;
  /** 1-based screen bounds matching chat/input selection coordinates. */
  bounds?: ChatSurfaceBounds;
  selection?: ChatSelectionState;
  /** Last rendered panel lines (ANSI ok); selection extracts plain text. */
  renderedLines: string[];
}

let activeNotice: ActiveNotice | undefined;

export function getActiveNotice(): ActiveNotice | undefined {
  return activeNotice;
}

export function hasActiveNotice(): boolean {
  return activeNotice !== undefined;
}

export function setActiveNoticeSelection(selection: ChatSelectionState | undefined): void {
  if (!activeNotice) return;
  activeNotice.selection = selection;
}

export function selectedNoticeText(): string {
  if (!activeNotice?.selection) return "";
  return selectedChatText(activeNotice.renderedLines, activeNotice.selection);
}

/** Copy the full active Notice body. Used by app key handler and tests. */
export async function copyActiveNoticeText(
  copyToClipboard: (text: string) => Promise<void>,
): Promise<{ chars: number } | { error: string }> {
  const text = activeNotice?.text ?? "";
  if (!text) return { error: "No notice text to copy." };
  try {
    await copyToClipboard(text);
    return { chars: text.length };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

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
  activeNotice = undefined;
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

export function renderDeleteAllSessionsConfirm(width: number, theme: MixCodeTheme): string[] {
  return renderWithTheme(theme, () =>
    overlayPanel(
      "Delete All Sessions",
      [
        "Delete all open agent tabs and their sessions?",
        "",
        "[Y] Delete    [N] Cancel",
        "Esc: cancel",
      ],
      width,
    ),
  );
}

export function renderCloseAllSessionsConfirm(width: number, theme: MixCodeTheme): string[] {
  return renderWithTheme(theme, () =>
    overlayPanel(
      "Close All Sessions",
      [
        "Close all open agent tabs? Sessions are kept and can be resumed.",
        "",
        "[Y] Close    [N] Cancel",
        "Esc: cancel",
      ],
      width,
    ),
  );
}

export function renderSessionActionConfirm(
  width: number,
  theme: MixCodeTheme,
  action: "close" | "delete",
  title: string,
): string[] {
  const verb = action === "close" ? "Close" : "Delete";
  const detail =
    action === "close"
      ? "The session is kept and can be resumed."
      : "This deletes the session file.";
  return renderWithTheme(theme, () =>
    overlayPanel(
      `${verb} Session`,
      [`${verb} session "${title}"?`, detail, "", `[Y] ${verb}    [N] Cancel`, "Esc: cancel"],
      width,
    ),
  );
}

export function showNoticeTextOverlay(tui: OverlayTui, text: string): void {
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

const NOTICE_HINT = "c/y copy · Esc close";
const NOTICE_MAX_WIDTH_RATIO = 0.6;
const NOTICE_MAX_HEIGHT_RATIO = 0.6;
const NOTICE_MIN_BOX_WIDTH = 24;

// Bottom-centered, non-capturing notice/error panel. The message is wrapped to
// the panel width (never per-line truncated) and the panel auto-fits its
// content up to ~60% of the terminal, so the common short message stays compact
// while a long diagnostic gets enough room to read.
function showNoticeOverlay(tui: OverlayTui, text: string, options: NoticeOptions): void {
  // Keep a stable object so the render callback can mutate bounds/selection
  // after showLinesOverlay clears the previous activeNotice via closeAppOverlay.
  const notice: ActiveNotice = {
    text,
    title: options.title,
    danger: options.danger,
    renderedLines: [],
  };
  const overlayOptions = noticeOverlayOptions(text, options.title);
  showLinesOverlay(
    tui,
    // Resolve the live UI theme at render time. The TUI compositor invokes this
    // callback outside any renderWithTheme scope, so reading activeRenderTheme
    // here would always yield the module default and ignore the user's theme.
    (width) => {
      const theme = getCurrentUiTheme();
      const lines = renderNoticePanel(text, width, theme, options);
      const termWidth = Math.max(1, process.stdout.columns || 80);
      const termHeight = Math.max(1, process.stdout.rows || 24);
      const layout = resolveNoticeOverlayLayout(
        overlayOptions,
        lines.length,
        termWidth,
        termHeight,
      );
      // pi-tui layout row/col are 0-based; MixCode mouse selection uses 1-based.
      notice.bounds = {
        top: layout.row + 1,
        left: layout.col + 1,
        width: layout.width,
        height: lines.length,
      };
      notice.renderedLines = lines;
      if (!notice.selection) return lines;
      return lines.map((line, row) =>
        highlightChatSelectionLine(line, row, notice.selection, theme.selection),
      );
    },
    overlayOptions,
  );
  activeNotice = notice;
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

/**
 * Mirror pi-tui resolveOverlayLayout for Notice so mouse hit-testing matches
 * where the compositor places the panel (bottom-center + margin + offsetY).
 * Exported for focused layout tests.
 */
export function resolveNoticeOverlayLayout(
  options: OverlayOptions,
  overlayHeight: number,
  termWidth: number,
  termHeight: number,
): { width: number; row: number; col: number; maxHeight?: number } {
  const margin = typeof options.margin === "number"
    ? { top: options.margin, right: options.margin, bottom: options.margin, left: options.margin }
    : (options.margin ?? {});
  const marginTop = Math.max(0, margin.top ?? 0);
  const marginRight = Math.max(0, margin.right ?? 0);
  const marginBottom = Math.max(0, margin.bottom ?? 0);
  const marginLeft = Math.max(0, margin.left ?? 0);
  const availWidth = Math.max(1, termWidth - marginLeft - marginRight);
  const availHeight = Math.max(1, termHeight - marginTop - marginBottom);

  let width = typeof options.width === "number" ? options.width : Math.min(80, availWidth);
  if (options.minWidth !== undefined) width = Math.max(width, options.minWidth);
  width = Math.max(1, Math.min(width, availWidth));

  let maxHeight = typeof options.maxHeight === "number" ? options.maxHeight : undefined;
  if (maxHeight !== undefined) maxHeight = Math.max(1, Math.min(maxHeight, availHeight));
  const effectiveHeight = maxHeight !== undefined ? Math.min(overlayHeight, maxHeight) : overlayHeight;

  let row = marginTop + availHeight - effectiveHeight; // bottom-center default for Notice
  let col = marginLeft + Math.floor((availWidth - width) / 2);
  if (options.offsetY !== undefined) row += options.offsetY;
  if (options.offsetX !== undefined) col += options.offsetX;
  row = Math.max(marginTop, Math.min(row, termHeight - marginBottom - effectiveHeight));
  col = Math.max(marginLeft, Math.min(col, termWidth - marginRight - width));
  return { width, row, col, maxHeight };
}

// Render a bordered notice/error panel: a titled box whose body is the
// width-wrapped message followed by a dim copy/Esc hint. Exported for
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
    const body = [...wrapped, "", theme.dim(NOTICE_HINT)];
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
