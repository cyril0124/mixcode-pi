import {
  type Component,
  type OverlayHandle,
  type OverlayOptions,
  resolveOverlayLayout,
} from "@earendil-works/pi-tui";
import {
  type ChatSelectionState,
  type ChatSurfaceBounds,
  highlightChatSelectionLine,
} from "../core/chat-selection.js";
import { editTextInExternalEditor } from "../core/external-editor.js";
import type { OverlayTui } from "./app-types.js";
import { overlayPanel, padLine } from "./rendering.js";
import {
  noticeOverlayOptions,
  renderNoticePanel,
  type NoticeOptions,
} from "./components/notice-panel.js";
import { getCurrentUiTheme, renderWithTheme } from "./rendering/context.js";
import type { MixCodeTheme } from "./themes.js";

const activeAppOverlays = new WeakMap<
  object,
  { handle: OverlayHandle; component: Component; capturing: boolean }
>();

export const DEFAULT_OVERLAY_MAX_HEIGHT_PERCENT = 80;

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
  showComponentOverlay(tui, new LinesOverlay(renderLines), options);
}

/** Show a focusable Component overlay and track it as the app overlay. */
export function showComponentOverlay(
  tui: OverlayTui,
  component: Component,
  options: OverlayOptions = defaultOverlayOptions(),
): OverlayHandle | undefined {
  closeAppOverlay(tui);
  const handle = tui.showOverlay(component, options);
  if (!isOverlayHandle(handle)) return undefined;
  activeAppOverlays.set(tui, {
    handle,
    component,
    capturing: options.nonCapturing !== true,
  });
  return handle;
}

/**
 * True when the tracked app overlay is an input-capable component. Such
 * overlays own their key semantics (e.g. Esc steps a confirm mode back), so
 * the generic Esc-closes-overlay fallback must not fire for them.
 */
export function appOverlayHandlesInput(tui: OverlayTui): boolean {
  return typeof activeAppOverlays.get(tui)?.component.handleInput === "function";
}

export function closeAppOverlay(tui: OverlayTui): void {
  // Only hide overlays we registered via showLinesOverlay/showComponentOverlay.
  // Never fall back to tui.hideOverlay(): that pops the stack top and can
  // destroy an extension custom overlay whose close()/pending-interaction
  // bookkeeping never runs (zombie hasExtensionCustomOverlay → Esc freezes).
  activeNotice = undefined;
  const active = activeAppOverlays.get(tui);
  if (!active) return;
  active.handle.hide();
  activeAppOverlays.delete(tui);
}

export function hasAppOverlay(tui: OverlayTui): boolean {
  return activeAppOverlays.has(tui);
}

export function hasCapturingAppOverlay(tui: OverlayTui): boolean {
  return activeAppOverlays.get(tui)?.capturing === true;
}

export function renderAppOverlay(tui: OverlayTui, width: number): string[] {
  const active = activeAppOverlays.get(tui);
  return active ? active.component.render(width) : [];
}

export function hasAnyOverlay(tui: OverlayTui): boolean {
  return activeAppOverlays.has(tui) || (tui.hasOverlay?.() ?? false);
}

function isOverlayHandle(value: unknown): value is OverlayHandle {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as OverlayHandle).hide === "function"
  );
}

export function defaultOverlayOptions(): OverlayOptions {
  return {
    anchor: "center",
    width: "78%",
    maxHeight: `${DEFAULT_OVERLAY_MAX_HEIGHT_PERCENT}%`,
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
        "Delete all open agent tabs and permanently delete their session files?",
        "This cannot be undone — deleted sessions cannot be resumed.",
        "",
        "[Y] Delete permanently    [N] Cancel",
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
  // Command errors carry the standard `Error:` prefix so they read correctly in
  // chat and ctl output; the panel title already says Error, so drop it here
  // instead of rendering "Error" above "Error: ...".
  showNoticeOverlay(tui, errorMessage(error).replace(/^Error:\s*/, ""), {
    title: "Error",
    danger: true,
  });
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


// Bottom-centered, non-capturing notice/error panel. The message is wrapped to
// the panel width (never per-line truncated) and the panel auto-fits its
// content up to ~60% of the terminal, so the common short message stays compact
// while a long diagnostic gets enough room to read.
function showNoticeOverlay(tui: OverlayTui, text: string, options: NoticeOptions): void {
  // Console bridge fires once per console.* call. Append consecutive console
  // lines into the open Notice instead of replacing it, so multi-line diagnostics
  // are not reduced to only the last emit.
  if (
    options.title === "Notice" &&
    !options.danger &&
    activeNotice &&
    activeNotice.title === "Notice" &&
    !activeNotice.danger &&
    isConsoleNoticeLine(text) &&
    isConsoleNoticeBody(activeNotice.text)
  ) {
    activeNotice.text = `${activeNotice.text}\n${text}`;
    // Rebuild the overlay with the merged body (showLinesOverlay closes prior).
    const merged = activeNotice.text;
    const notice: ActiveNotice = {
      text: merged,
      title: options.title,
      danger: options.danger,
      renderedLines: [],
    };
    const overlayOptions = noticeOverlayOptions(merged, options.title);
    showLinesOverlay(
      tui,
      (width) => {
        const theme = getCurrentUiTheme();
        const lines = renderNoticePanel(merged, width, theme, options);
        const termWidth = Math.max(1, process.stdout.columns || 80);
        const termHeight = Math.max(1, process.stdout.rows || 24);
        const layout = resolveOverlayLayout(overlayOptions, lines.length, termWidth, termHeight);
        notice.bounds = {
          top: layout.row + 1,
          left: layout.col + 1,
          width: layout.width,
          height: lines.length,
        };
        notice.renderedLines = lines;
        if (!notice.selection) return lines;
        return lines.map((line, row) =>
          highlightChatSelectionLine(line, row, notice.selection, theme.selectedBg),
        );
      },
      overlayOptions,
    );
    activeNotice = notice;
    return;
  }

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
      const layout = resolveOverlayLayout(overlayOptions, lines.length, termWidth, termHeight);
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
        highlightChatSelectionLine(line, row, notice.selection, theme.selectedBg),
      );
    },
    overlayOptions,
  );
  activeNotice = notice;
}

function isConsoleNoticeLine(text: string): boolean {
  return /^\[console\.(log|info|debug|warn|error)\]:/.test(text);
}

function isConsoleNoticeBody(text: string): boolean {
  return text.split(/\r?\n/).every((line) => line.length === 0 || isConsoleNoticeLine(line));
}


export async function editTextWithTuiPaused(
  tui: OverlayTui,
  text: string,
  editor?: string,
): Promise<string> {
  // pause/resume, never stop()/start(): stop() is the app-shutdown path and
  // would permanently tear down the ctl server, heartbeat, and peer tab sync.
  const canPause = Boolean(tui.pause && tui.resume);
  if (canPause) tui.pause?.();
  try {
    return await editTextInExternalEditor(text, { editor });
  } finally {
    if (canPause) tui.resume?.();
  }
}
