import { type Component, Loader, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { highlightChatSelectionLine } from "../core/chat-selection.js";
import { isPendingEscapeActive } from "../core/escape.js";
import type { MixCodeState } from "../core/types.js";
import { getActiveTab } from "../core/tabs.js";
import type { EditorSlot } from "./app-editor.js";
import {
  fitHeadLines,
  joinColumns,
  padLine,
  renderAgentSurface,
  renderConfig,
  renderExtensionFooter,
  renderExtensionPanel,
  renderExtensionWidgets,
  extensionPanelWidth,
  renderFooter,
  renderHeader,
  renderInputMeta,
  renderPreviewOverlay,
  renderTabBar,
  renderTabBarSeparator,
  renderWorkingIndicator,
  setCurrentUiTheme,
} from "./rendering.js";
import { themeForId } from "./themes.js";

export const TERMINAL_SCROLL_GUARD_ROWS = 0;
const WORKING_GAP_ROWS = 1;
export class MixCodeRoot implements Component {
  constructor(
    private readonly state: MixCodeState,
    private readonly runtime: MixCodeRuntime,
    private readonly getViewportRows?: () => number,
    private readonly getReservedRows: () => number = () => 2,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const active = getActiveTab(this.state);
    const theme = themeForId(this.state.theme);
    const tabBarLines = renderTabBar(this.state, width, theme);
    // Extension header is no longer pinned here; it now scrolls with the
    // conversation (rendered at the top of the agent surface), matching Pi.
    const top = [...renderHeader(width, theme), ...tabBarLines];
    this.state.tabBarHitRow = top.length;
    // First absolute (1-indexed) row of the tab bar = rows above it + 1. Mouse
    // handlers use this with lastRenderWidth to map clicks onto wrapped rows.
    this.state.tabBarTopRow = top.length - tabBarLines.length + 1;
    this.state.lastRenderWidth = width;
    if (!active || this.state.activeTabId === "config") {
      const viewportRows = this.getViewportRows?.();
      const limit = viewportRows ? Math.max(0, viewportRows - this.getReservedRows()) : undefined;
      const configRows = limit === undefined ? undefined : Math.max(0, limit - top.length);
      return this.fitRootLines(
        [...top, ...renderConfig(this.state, width, theme, top.length, configRows)],
        width,
      );
    }
    const runtimeTab = this.runtime.getTab(active.sessionId);
    // Horizontal rule directly under the tab bar (replaces the old blank gap).
    // Color tracks the active tab's editor border so the chrome reads as one frame.
    const contentGap = renderTabBarSeparator(
      width,
      { thinkingLevel: active.thinkingLevel, vimMode: active.vimMode },
      theme,
    );
    const preview = renderPreviewOverlay(active, width, theme);
    const bottomBeforeMeta = [...preview];
    const viewportRows = this.getViewportRows?.();
    if (!viewportRows) {
      const middle = renderAgentSurface(active, runtimeTab, width, undefined, theme);
      return [...top, ...contentGap, ...middle, ...bottomBeforeMeta];
    }
    const limit = Math.max(0, viewportRows - this.getReservedRows());
    if (top.length >= limit) return top.slice(0, limit);
    const fixedTop = [...top, ...contentGap];
    if (fixedTop.length >= limit) return fixedTop.slice(0, limit);
    const maxBottomRows = Math.max(0, limit - fixedTop.length);
    const placeholderBottom = bottomBeforeMeta;
    const visibleBottom = placeholderBottom.slice(0, maxBottomRows);
    const middleHeight = Math.max(0, limit - fixedTop.length - visibleBottom.length);
    const middle = this.renderMiddle(active, runtimeTab, width, middleHeight, fixedTop.length, theme);
    return [...fixedTop, ...middle, ...visibleBottom];
  }

  /**
   * Render the chat surface for the given height, optionally splitting off a
   * right-hand extension widget panel when the tab has it open. Sets the screen
   * bounds for chat (and panel) so mouse text-selection maps correctly.
   */
  private renderMiddle(
    active: MixCodeState["tabs"][number],
    runtimeTab: ReturnType<MixCodeRuntime["getTab"]>,
    width: number,
    middleHeight: number,
    topRows: number,
    theme: ReturnType<typeof themeForId>,
  ): string[] {
    if (!active.panelOpen) {
      active.panelSurfaceBounds = undefined;
      active.lastRenderedPanelLines = [];
      active.chatSurfaceBounds = {
        top: topRows + 1,
        left: 1,
        width: Math.max(1, width - 1),
        height: middleHeight,
      };
      return renderAgentSurface(active, runtimeTab, width, middleHeight, theme);
    }
    // Split: chat on the left, widget panel on the right (1-col gap between).
    const panelWidth = extensionPanelWidth(width);
    const gap = 1;
    const chatWidth = Math.max(1, width - panelWidth - gap);
    active.chatSurfaceBounds = {
      top: topRows + 1,
      left: 1,
      width: Math.max(1, chatWidth - 1),
      height: middleHeight,
    };
    const chat = renderAgentSurface(active, runtimeTab, chatWidth, middleHeight, theme);
    let panel = renderExtensionPanel(active, panelWidth, middleHeight, theme);
    active.lastRenderedPanelLines = panel;
    // Panel occupies the columns after chat + gap (1-based screen coordinates).
    active.panelSurfaceBounds = {
      top: topRows + 1,
      left: chatWidth + gap + 1,
      width: panelWidth,
      height: panel.length,
    };
    if (active.panelSelection) {
      panel = panel.map((line, row) =>
        highlightChatSelectionLine(line, row, active.panelSelection, theme.selection),
      );
    }
    return joinColumns(chat, panel, chatWidth, panelWidth);
  }

  private fitRootLines(lines: string[], width: number): string[] {
    const viewportRows = this.getViewportRows?.();
    if (!viewportRows) return lines;
    return fitHeadLines(lines, viewportRows - this.getReservedRows(), width);
  }
}

export class MixCodeFooterRoot implements Component {
  constructor(private readonly state: MixCodeState) {}

  invalidate(): void {}

  render(width: number): string[] {
    const active = getActiveTab(this.state);
    return [...renderExtensionFooter(active, width), ...renderFooter(width)];
  }
}

export class MixCodeLayoutRoot implements Component {
  constructor(
    private readonly state: MixCodeState,
    private readonly main: MixCodeRoot,
    private readonly editor: EditorSlot,
    private readonly footer: MixCodeFooterRoot,
    private readonly setEditorRows: (rows: number) => void,
    private readonly setMetaRows: (rows: number) => void,
    private readonly getViewportRows?: () => number,
    private readonly tui?: Pick<TuiType, "requestRender">,
  ) {}

  private workingLoader?: Loader;
  private workingLoaderKey = "";

  invalidate(): void {
    this.main.invalidate();
    this.editor.invalidate();
    this.footer.invalidate();
  }

  dispose(): void {
    this.stopWorkingLoader();
  }

  render(width: number): string[] {
    const theme = themeForId(this.state.theme);
    setCurrentUiTheme(theme);
    const active = getActiveTab(this.state);
    const isAgentTab = active && this.state.activeTabId !== "config";
    // Vim mode is a read-only chat-scrolling surface; suppress extension
    // widgets (above/below editor) so reclaimed rows grow the chat history.
    // Widget registration/lifecycle is untouched — this only gates rendering.
    // The side panel likewise relocates these widgets, so hide them here when
    // it is open (they render inside the panel via MixCodeRoot).
    const isVim = active?.vimMode === true;
    const panelOpen = active?.panelOpen === true;
    const hideEditorWidgets = isVim || panelOpen;
    const metaProbe = isAgentTab ? renderInputMeta(active, width, 0, theme, false) : [];
    const workingLines = isAgentTab ? this.renderWorkingLoader(active, width, theme) : [];
    const widgetsAbove =
      isAgentTab && !hideEditorWidgets
        ? renderExtensionWidgets(active, width, "aboveEditor", theme)
        : [];
    const widgetsBelow =
      isAgentTab && !hideEditorWidgets
        ? renderExtensionWidgets(active, width, "belowEditor", theme)
        : [];
    const viewportRowsForClamp = this.getViewportRows?.();
    const workingBottomGapRows = 0;
    let editorLines = this.editor.render(width);
    let widgetsAboveBottomGapRows =
      widgetsAbove.length > 0 && (workingLines.length > 0 || editorLines.length > 0)
        ? WORKING_GAP_ROWS
        : 0;
    let controlTopGapRows = editorLines.length > 0 ? WORKING_GAP_ROWS : 0;
    if (
      this.setEmbeddedTerminalRows(
        active?.sessionId,
        viewportRowsForClamp,
        widgetsAbove.length,
        widgetsAboveBottomGapRows,
        workingLines.length,
        workingBottomGapRows,
        widgetsBelow.length,
      )
    ) {
      editorLines = this.editor.render(width);
      widgetsAboveBottomGapRows =
        widgetsAbove.length > 0 && (workingLines.length > 0 || editorLines.length > 0)
          ? WORKING_GAP_ROWS
          : 0;
      controlTopGapRows = editorLines.length > 0 ? WORKING_GAP_ROWS : 0;
      this.setEmbeddedTerminalRows(
        active?.sessionId,
        viewportRowsForClamp,
        widgetsAbove.length,
        widgetsAboveBottomGapRows,
        workingLines.length,
        workingBottomGapRows,
        widgetsBelow.length,
      );
    }
    // Clamp editor lines so extension editor components (e.g. the btw answer
    // pager) cannot overflow the terminal and push the tab bar into scrollback.
    // Reserve exactly the main region's tab-bar rows: when the editor is large,
    // MixCodeRoot self-clamps to emit only its fixed top (tabBarHitRow rows) and
    // drops its internal content gap, so reserving more would needlessly cut the
    // editor component's own bottom chrome (e.g. the btw bottom border).
    // Fall back to 1 (single tab-bar row) before the first frame sets the value.
    const mainTopReserve = this.state.tabBarHitRow ?? 1;
    const maxEditorRows = viewportRowsForClamp
      ? Math.max(
          1,
          viewportRowsForClamp -
            mainTopReserve -
            controlTopGapRows -
            workingLines.length -
            workingBottomGapRows -
            widgetsAboveBottomGapRows -
            widgetsAbove.length -
            widgetsBelow.length -
            metaProbe.length -
            renderFooter(width).length,
        )
      : undefined;
    if (this.editor.setEditorMaxRows(maxEditorRows, active?.sessionId)) {
      editorLines = this.editor.render(width);
    }
    // Clamp by keeping the bottom row: components that don't self-size (e.g. the
    // SDK extension selector) render their full box unconditionally, so a plain
    // head slice would drop their trailing border. Keep head + final line.
    const clampedEditorLines =
      maxEditorRows && editorLines.length > maxEditorRows
        ? maxEditorRows >= 2
          ? [...editorLines.slice(0, maxEditorRows - 1), editorLines[editorLines.length - 1]!]
          : editorLines.slice(0, maxEditorRows)
        : editorLines;
    this.setEditorRows(clampedEditorLines.length);
    this.setMetaRows(
      controlTopGapRows +
        workingLines.length +
        workingBottomGapRows +
        widgetsAboveBottomGapRows +
        widgetsAbove.length +
        widgetsBelow.length +
        metaProbe.length,
    );
    const mainLines = this.main.render(width);
    const footerLines = this.footer.render(width);
    const viewportRows = this.getViewportRows?.();
    const floatingRows = viewportRows
      ? Math.max(
          0,
          viewportRows -
            mainLines.length -
            controlTopGapRows -
            widgetsAbove.length -
            workingLines.length -
            workingBottomGapRows -
            widgetsAboveBottomGapRows -
            clampedEditorLines.length -
            widgetsBelow.length -
            metaProbe.length -
            footerLines.length,
        )
      : 0;
    const guardRows = Math.min(TERMINAL_SCROLL_GUARD_ROWS, floatingRows);
    const spacerRows = Math.max(0, floatingRows - guardRows);
    const editorTop =
      mainLines.length +
      spacerRows +
      controlTopGapRows +
      widgetsAbove.length +
      widgetsAboveBottomGapRows +
      workingLines.length +
      workingBottomGapRows +
      1;
    let visibleEditorLines = clampedEditorLines;
    if (active) {
      active.inputSurfaceBounds = {
        top: editorTop,
        left: 1,
        width: Math.max(1, width),
        height: clampedEditorLines.length,
      };
      active.lastRenderedInputLines = clampedEditorLines;
      if (active.inputSelection) {
        visibleEditorLines = clampedEditorLines.map((line, row) =>
          highlightChatSelectionLine(line, row, active.inputSelection, theme.selection),
        );
      }
    }
    const metaRow =
      mainLines.length +
      spacerRows +
      controlTopGapRows +
      widgetsAbove.length +
      workingLines.length +
      workingBottomGapRows +
      widgetsAboveBottomGapRows +
      clampedEditorLines.length +
      widgetsBelow.length +
      1;
    const metaLines =
      active && this.state.activeTabId !== "config"
        ? renderInputMeta(active, width, metaRow, theme)
        : [];
    return [
      ...mainLines,
      ...Array.from({ length: spacerRows }, () => padLine("", width)),
      ...Array.from({ length: controlTopGapRows }, () => padLine("", width)),
      ...widgetsAbove,
      ...Array.from({ length: widgetsAboveBottomGapRows }, () => padLine("", width)),
      ...workingLines,
      ...Array.from({ length: workingBottomGapRows }, () => padLine("", width)),
      ...visibleEditorLines,
      ...widgetsBelow,
      ...metaLines,
      ...footerLines,
      ...Array.from({ length: guardRows }, () => padLine("", Math.max(0, width - 1))),
    ];
  }

  private setEmbeddedTerminalRows(
    sessionId: string | undefined,
    viewportRows: number | undefined,
    widgetsAboveRows: number,
    widgetsAboveBottomGapRows: number,
    workingRows: number,
    workingBottomGapRows: number,
    widgetsBelowRows: number,
  ): boolean {
    return this.editor.setEmbeddedTerminalRows(
      viewportRows === undefined
        ? undefined
        : Math.max(
            1,
            viewportRows -
              widgetsAboveRows -
              widgetsAboveBottomGapRows -
              workingRows -
              workingBottomGapRows -
              widgetsBelowRows,
          ),
      sessionId,
    );
  }

  private renderWorkingLoader(
    active: MixCodeState["tabs"][number],
    width: number,
    theme: ReturnType<typeof themeForId>,
  ): string[] {
    const key = workingLoaderKey(active, theme.name);
    if (!key) {
      this.stopWorkingLoader();
      return renderWorkingIndicator(active, width, new Date(), theme);
    }
    if (!this.workingLoader || this.workingLoaderKey !== key) {
      this.stopWorkingLoader();
      this.workingLoader = new Loader(
        this.tui as TuiType,
        theme.accent,
        theme.dim,
        workingLoaderMessage(active, new Date()),
        workingLoaderIndicator(active),
      );
      this.workingLoaderKey = key;
    } else {
      this.workingLoader.setMessage(workingLoaderMessage(active, new Date()));
    }
    return this.workingLoader.render(width).filter((line) => line.trim() !== "");
  }

  private stopWorkingLoader(): void {
    this.workingLoader?.stop();
    this.workingLoader = undefined;
    this.workingLoaderKey = "";
  }
}

function workingLoaderKey(active: MixCodeState["tabs"][number], themeName: string): string {
  if (!active.extensionUi.workingVisible) return "";
  if (active.status !== "running" && active.status !== "thinking") return "";
  return JSON.stringify([
    active.sessionId,
    themeName,
    active.extensionUi.workingMessage?.trim() || "Working",
    active.extensionUi.workingIndicatorFrames,
    active.extensionUi.workingIndicatorIntervalMs,
  ]);
}

function workingLoaderMessage(active: MixCodeState["tabs"][number], now: Date): string {
  const message = active.extensionUi.workingMessage?.trim() || "Working";
  const elapsed = formatElapsed(active.workingStartedAt, now);
  const detail = isPendingEscapeActive(active, "abort-agent", now.getTime())
    ? "esc again to interrupt"
    : "esc to interrupt";
  return `${message} (${elapsed} • ${detail})`;
}

function workingLoaderIndicator(
  active: MixCodeState["tabs"][number],
): { frames?: string[]; intervalMs?: number } | undefined {
  const frames = active.extensionUi.workingIndicatorFrames;
  if (frames === undefined) return undefined;
  return {
    frames,
    intervalMs: active.extensionUi.workingIndicatorIntervalMs,
  };
}

function formatElapsed(startedAt: string | undefined, now: Date): string {
  const start = startedAt ? Date.parse(startedAt) : NaN;
  const elapsedSeconds = Number.isFinite(start)
    ? Math.max(0, Math.floor((now.getTime() - start) / 1000))
    : 0;
  return formatDuration(elapsedSeconds);
}

function formatDuration(elapsedSeconds: number): string {
  const hours = Math.floor(elapsedSeconds / 3600);
  const minutes = Math.floor((elapsedSeconds % 3600) / 60);
  const seconds = elapsedSeconds % 60;
  if (hours > 0)
    return `${hours}h ${String(minutes).padStart(2, "0")}m ${String(seconds).padStart(2, "0")}s`;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}
