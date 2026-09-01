import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Editor,
  getKeybindings,
  isKeyRelease,
  matchesKey,
  type OverlayHandle,
  type OverlayOptions,
  resolveOverlayLayout,
  type TUI as TuiType,
} from "@earendil-works/pi-tui";
import {
  type ChatSelectionState,
  type ChatSurfaceBounds,
  highlightChatSelectionLine,
} from "../core/chat-selection.js";
import {
  editTextInExternalEditor,
  resolveAvailableExternalEditor,
} from "../core/external-editor.js";
import {
  isInstanceOverlayOpen,
  pickerIsLive,
  sessionActionConfirmIsLive,
} from "../core/overlays.js";
import type { MixCodeState } from "../core/types.js";
import type { OverlayTui } from "./app-types.js";
import { editorThemeFor } from "./app-editor.js";
import { overlayPanel, padLine, renderPickerOverlay } from "./rendering.js";
import {
  noticeOverlayOptions,
  renderNoticePanel,
  type NoticeOptions,
} from "./components/notice-panel.js";
import { getCurrentUiTheme, renderWithTheme } from "./rendering/context.js";
import { themeForId, type MixCodeTheme } from "./themes.js";

const activeAppOverlays = new WeakMap<
  object,
  { handle: OverlayHandle; component: Component; capturing: boolean }
>();

type OwnedPresentation = "picker" | "confirm";
const presentedOwnedOverlay = new WeakMap<object, OwnedPresentation>();

export const DEFAULT_OVERLAY_MAX_HEIGHT_PERCENT = 80;

const UP_KEY = "\x1b[A";
const DOWN_KEY = "\x1b[B";
const PAGE_UP_KEY = "\x1b[5~";
const PAGE_DOWN_KEY = "\x1b[6~";

class ReadOnlyEditorOverlay implements Component {
  private readonly editor: Editor;

  constructor(
    private readonly tui: OverlayTui,
    private readonly text: string,
    private readonly title: string,
  ) {
    this.editor = new Editor(tui as TuiType, editorThemeFor(getCurrentUiTheme()), { paddingX: 1 });
    this.editor.disableSubmit = true;
    this.editor.setText(text);
    this.editor.focused = true;
  }

  invalidate(): void {
    this.editor.invalidate();
  }

  render(width: number): string[] {
    const theme = getCurrentUiTheme();
    return [
      padLine(theme.bold(this.title), width),
      ...this.editor.render(width),
      padLine(theme.dim("j/k scroll  ctrl+u/d page  g/G top/bottom  ctrl+c copy  q close"), width),
    ];
  }

  handleInput(data: string): void {
    if (isKeyRelease(data)) return;
    if (matchesKey(data, "escape") || matchesKey(data, "q")) {
      closeAppOverlay(this.tui);
      return;
    }
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.input.copy")) {
      void copyToClipboard(this.text).catch((error: unknown) => {
        showErrorOverlay(this.tui, error);
        this.tui.requestRender();
      });
      return;
    }
    if (matchesKey(data, "g") || matchesKey(data, "shift+g")) {
      this.moveToBoundary(matchesKey(data, "g") ? PAGE_UP_KEY : PAGE_DOWN_KEY);
      return;
    }
    if (matchesKey(data, "k") || matchesKey(data, "ctrl+u")) {
      this.editor.handleInput(matchesKey(data, "k") ? UP_KEY : PAGE_UP_KEY);
      return;
    }
    if (matchesKey(data, "j") || matchesKey(data, "ctrl+d")) {
      this.editor.handleInput(matchesKey(data, "j") ? DOWN_KEY : PAGE_DOWN_KEY);
      return;
    }
    if (
      keybindings.matches(data, "tui.editor.cursorUp") ||
      keybindings.matches(data, "tui.editor.cursorDown") ||
      keybindings.matches(data, "tui.editor.cursorLeft") ||
      keybindings.matches(data, "tui.editor.cursorRight") ||
      keybindings.matches(data, "tui.editor.cursorWordLeft") ||
      keybindings.matches(data, "tui.editor.cursorWordRight") ||
      keybindings.matches(data, "tui.editor.cursorLineStart") ||
      keybindings.matches(data, "tui.editor.cursorLineEnd") ||
      keybindings.matches(data, "tui.editor.pageUp") ||
      keybindings.matches(data, "tui.editor.pageDown")
    ) {
      this.editor.handleInput(data);
    }
  }

  private moveToBoundary(key: string): void {
    for (;;) {
      const before = this.editor.getCursor();
      this.editor.handleInput(key);
      const after = this.editor.getCursor();
      if (before.line === after.line && before.col === after.col) return;
    }
  }
}

/** Open text in an available external editor, otherwise in a read-only Pi Editor overlay. */
export async function showTextInPreferredViewer(
  tui: OverlayTui,
  text: string,
  title: string,
): Promise<void> {
  const preferred = resolvePreferredExternalEditor?.() ?? process.env.VISUAL ?? process.env.EDITOR;
  const editor = resolveAvailableExternalEditor(preferred);
  if (editor) {
    await editTextWithTuiPaused(tui, text, editor);
    return;
  }
  showComponentOverlay(tui, new ReadOnlyEditorOverlay(tui, text, title));
}

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

/** Feed a key to the live component overlay (settings / workspace / extension manager). */
export function dispatchAppOverlayInput(tui: OverlayTui, data: string): boolean {
  const active = activeAppOverlays.get(tui);
  const handleInput = active?.component.handleInput;
  if (!active || typeof handleInput !== "function") return false;
  handleInput.call(active.component, data);
  tui.requestRender();
  return true;
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
  presentedOwnedOverlay.delete(tui);
}

/** Show or hide the tab-owned picker/confirm to match the focused tab. */
export function syncOwnedAppOverlay(state: MixCodeState, tui: OverlayTui): void {
  if (isInstanceOverlayOpen(state)) return;
  if (pickerIsLive(state)) {
    if (presentedOwnedOverlay.get(tui) !== "picker" || !hasAppOverlay(tui)) {
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      presentedOwnedOverlay.set(tui, "picker");
    }
    tui.requestRender();
    return;
  }
  const confirm = state.sessionActionConfirm;
  if (confirm && sessionActionConfirmIsLive(state)) {
    const tab = state.tabs.find((item) => item.sessionId === confirm.sessionId);
    if (tab && (presentedOwnedOverlay.get(tui) !== "confirm" || !hasAppOverlay(tui))) {
      showLinesOverlay(
        tui,
        (width) =>
          renderSessionActionConfirm(width, themeForId(state.theme), confirm.action, tab.title),
        quitOverlayOptions(),
      );
      presentedOwnedOverlay.set(tui, "confirm");
    }
    tui.requestRender();
    return;
  }
  if (presentedOwnedOverlay.has(tui)) closeAppOverlay(tui);
}

export function hasAppOverlay(tui: OverlayTui): boolean {
  return activeAppOverlays.has(tui);
}

export function appOverlayComponent(tui: OverlayTui): Component | undefined {
  return activeAppOverlays.get(tui)?.component;
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

// settings.json externalEditor is the default for Ctrl+G, /editor,
// /system-prompt, and /system-tools. /console-history gets the explicit
// settings/env value separately so an unset editor can auto-detect nvim/vim.
let resolveDefaultExternalEditor: (() => string | undefined) | undefined;
let resolvePreferredExternalEditor: (() => string | undefined) | undefined;

export function setDefaultExternalEditorResolver(
  resolver: (() => string | undefined) | undefined,
  preferredResolver: (() => string | undefined) | undefined = resolver,
): void {
  resolveDefaultExternalEditor = resolver;
  resolvePreferredExternalEditor = preferredResolver;
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
    return await editTextInExternalEditor(text, {
      editor: editor ?? resolveDefaultExternalEditor?.(),
    });
  } finally {
    if (canPause) tui.resume?.();
  }
}
