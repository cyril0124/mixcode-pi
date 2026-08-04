import { type Component, Loader, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime, RuntimeTab } from "../agent/runtime.js";
import { highlightChatSelectionLine } from "../core/chat-selection.js";
import { isPendingEscapeActive } from "../core/escape.js";
import { DEFAULT_OVERSIZED_ASSISTANT_MESSAGE } from "../core/mixcode-settings.js";
import { retryStatusMessage } from "../core/tab-state.js";
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
  renderFloatingPanelOverlay,
  renderFooter,
  renderHeader,
  renderInputMeta,
  renderPreviewOverlay,
  renderTabBar,
  renderTabBarSeparator,
  tabBarMaxRows,
  renderWorkingIndicator,
  setCurrentUiTheme,
  zenUnreadDoneCount,
} from "./rendering.js";
import { themeForId, type MixCodeTheme } from "./themes.js";

export const TERMINAL_SCROLL_GUARD_ROWS = 0;
const WORKING_GAP_ROWS = 1;
// Horizontal rule under the tab bar (renderTabBarSeparator). Always reserve so
// a tall custom editor cannot squeeze main down to tabs-only and drop it.
const TAB_BAR_SEPARATOR_ROWS = 1;
// Keep enough rows for chat + editor chrome so a flood of extension widgets
// cannot push the tab bar into scrollback.
const MIN_CHAT_AND_EDITOR_ROWS = 6;
// Preserve enough Home rows for one agent card and its navigation hint.
const MIN_HOME_CONTENT_ROWS = 10;

export function renderVisibleTabBar(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme,
  maxRows?: number,
): string[] {
  const active = getActiveTab(state);
  return active?.zenMode === true && state.activeTabId !== "config"
    ? []
    : renderTabBar(state, width, theme, maxRows);
}

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
    const viewportRows = this.getViewportRows?.();
    const limit = viewportRows
      ? Math.max(0, viewportRows - this.getReservedRows())
      : undefined;
    const minContentRows =
      !active || this.state.activeTabId === "config"
        ? MIN_HOME_CONTENT_ROWS
        : MIN_CHAT_AND_EDITOR_ROWS;
    // Cap tab-bar height: min(15% of terminal rows, rows left after min content).
    const contentCap = limit === undefined ? undefined : Math.max(1, limit - minContentRows);
    const maxTabRows = tabBarMaxRows(viewportRows, contentCap);
    // Zen mode hides the tab bar only; separator and header stay so chrome
    // still frames the chat without tab chrome noise.
    const tabBarLines = renderVisibleTabBar(this.state, width, theme, maxTabRows);
    // Extension header is no longer pinned here; it now scrolls with the
    // conversation (rendered at the top of the agent surface), matching Pi.
    const top = [...renderHeader(width, theme), ...tabBarLines];
    this.state.tabBarHitRow = top.length;
    // First absolute (1-indexed) row of the tab bar = rows above it + 1. Mouse
    // handlers use this with lastRenderWidth to map clicks onto wrapped rows.
    this.state.tabBarTopRow = top.length - tabBarLines.length + 1;
    this.state.lastRenderWidth = width;
    if (!active || this.state.activeTabId === "config") {
      const configRows = limit === undefined ? undefined : Math.max(0, limit - top.length);
      return this.fitRootLines(
        [...top, ...renderConfig(this.state, width, theme, top.length, configRows)],
        width,
      );
    }
    const runtimeTab = this.runtime.getTab(active.sessionId);
    // Horizontal rule directly under the tab bar (replaces the old blank gap).
    // Color tracks the active tab's editor border so the chrome reads as one frame.
    // Zen: left-anchor ● for other agents' unreadDone (tab bar is hidden).
    const contentGap = renderTabBarSeparator(
      width,
      {
        thinkingLevel: active.thinkingLevel,
        vimMode: active.vimMode,
        zenMode: active.zenMode === true,
        zenDoneCount: active.zenMode
          ? zenUnreadDoneCount(this.state.tabs, active.sessionId)
          : 0,
      },
      theme,
    );
    const preview = renderPreviewOverlay(active, width, theme);
    const bottomBeforeMeta = [...preview];
    if (!viewportRows || limit === undefined) {
      const middle = renderAgentSurface(active, runtimeTab, width, undefined, theme, {
        oversizedAssistantMessage: this.oversizedAssistantMessagePolicy(),
        hideThinking: this.state.hideThinkingBlock ?? false,
        renderMermaid: this.renderMermaidEnabled(),
      });
      return [...top, ...contentGap, ...middle, ...bottomBeforeMeta];
    }
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
    runtimeTab: RuntimeTab | undefined,
    width: number,
    middleHeight: number,
    topRows: number,
    theme: MixCodeTheme,
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
      return renderAgentSurface(active, runtimeTab, width, middleHeight, theme, {
        oversizedAssistantMessage: this.oversizedAssistantMessagePolicy(),
        hideThinking: this.state.hideThinkingBlock ?? false,
        renderMermaid: this.renderMermaidEnabled(),
      });
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
    const chat = renderAgentSurface(active, runtimeTab, chatWidth, middleHeight, theme, {
      oversizedAssistantMessage: this.oversizedAssistantMessagePolicy(),
      hideThinking: this.state.hideThinkingBlock ?? false,
      renderMermaid: this.renderMermaidEnabled(),
    });
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

  private oversizedAssistantMessagePolicy() {
    return this.state.ui?.oversizedAssistantMessage ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE;
  }

  private renderMermaidEnabled(): boolean {
    return this.state.ui?.renderMermaid !== false;
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
    // Home uses getActiveTab() as the selected agent for previews/toasts, but
    // extension footer is per-agent chrome and must not paint on the config tab.
    if (this.state.activeTabId === "config") return [...renderFooter(width)];
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
    const viewportRowsForClamp = this.getViewportRows?.();
    const activeForFooter =
      this.state.activeTabId === "config" ? undefined : active;
    // Count real extension footer lines (renderFooter is intentionally empty).
    const footerRows =
      renderExtensionFooter(activeForFooter, width).length + renderFooter(width).length;
    // Shared budget for above+below editor widgets so tab bar + chat/editor stay on screen.
    // Include the tab-bar separator: MixCodeRoot emits tabs + separator as fixedTop.
    const mainTopReserve = (this.state.tabBarHitRow ?? 1) + TAB_BAR_SEPARATOR_ROWS;
    const widgetBudget =
      viewportRowsForClamp === undefined
        ? undefined
        : Math.max(
            0,
            viewportRowsForClamp -
              mainTopReserve -
              WORKING_GAP_ROWS - // control top gap
              1 - // min editor row
              metaProbe.length -
              footerRows -
              MIN_CHAT_AND_EDITOR_ROWS,
          );
    const uncappedAbove =
      isAgentTab && !hideEditorWidgets
        ? renderExtensionWidgets(active, width, "aboveEditor", theme)
        : [];
    const uncappedBelow =
      isAgentTab && !hideEditorWidgets
        ? renderExtensionWidgets(active, width, "belowEditor", theme)
        : [];
    const { above: widgetsAbove, below: widgetsBelow } = fitEditorWidgets(
      uncappedAbove,
      uncappedBelow,
      widgetBudget,
      theme,
    );
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
        mainTopReserve,
        controlTopGapRows,
        widgetsAbove.length,
        widgetsAboveBottomGapRows,
        workingLines.length,
        workingBottomGapRows,
        widgetsBelow.length,
        metaProbe.length,
        footerRows,
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
        mainTopReserve,
        controlTopGapRows,
        widgetsAbove.length,
        widgetsAboveBottomGapRows,
        workingLines.length,
        workingBottomGapRows,
        widgetsBelow.length,
        metaProbe.length,
        footerRows,
      );
    }
    // Clamp editor lines so extension editor components cannot overflow the
    // terminal and push the tab bar into scrollback. Reserve tab bar + separator
    // (mainTopReserve); fall back before the first frame sets tabBarHitRow.
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
            footerRows,
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
    const assembled = [
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
    return active && this.state.activeTabId !== "config"
      ? renderFloatingPanelOverlay(assembled, active.floatingPanel, {
          width,
          editorTopRow: editorTop,
          theme,
        })
      : assembled;
  }

  private setEmbeddedTerminalRows(
    sessionId: string | undefined,
    viewportRows: number | undefined,
    mainTopReserve: number,
    controlTopGapRows: number,
    widgetsAboveRows: number,
    widgetsAboveBottomGapRows: number,
    workingRows: number,
    workingBottomGapRows: number,
    widgetsBelowRows: number,
    metaRows: number,
    footerRows: number,
  ): boolean {
    // Pi custom components size with `terminal.rows - RESERVED_APP_LINES` (3).
    // Report the same budget as maxEditorRows, plus that reserve, so their
    // output fits without the head+last clamp dropping the input content row.
    const PI_RESERVED_APP_LINES = 3;
    return this.editor.setEmbeddedTerminalRows(
      viewportRows === undefined
        ? undefined
        : Math.max(
            1,
            viewportRows -
              mainTopReserve -
              controlTopGapRows -
              widgetsAboveRows -
              widgetsAboveBottomGapRows -
              workingRows -
              workingBottomGapRows -
              widgetsBelowRows -
              metaRows -
              footerRows +
              PI_RESERVED_APP_LINES,
          ),
      sessionId,
    );
  }

  private renderWorkingLoader(
    active: MixCodeState["tabs"][number],
    width: number,
    theme: MixCodeTheme,
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
  // During auto-retry, mirror Pi's countdown status line. The 80ms working
  // redraw drives the live ticking; see retryStatusMessage.
  const retry = retryStatusMessage(active, now);
  if (retry) return retry;
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

/** Cap stacked editor widgets to a shared row budget; prefer aboveEditor first. */
function fitEditorWidgets(
  above: string[],
  below: string[],
  budget: number | undefined,
  theme: MixCodeTheme,
): { above: string[]; below: string[] } {
  if (budget === undefined) return { above, below };
  const total = above.length + below.length;
  if (total <= budget) return { above, below };
  if (budget <= 0) return { above: [], below: [] };

  const marker = theme.dim("… (widgets truncated)");
  // Reserve one row for the marker when we have content to show.
  const contentBudget = Math.max(0, budget - 1);
  const keptAbove = above.slice(0, contentBudget);
  const remaining = Math.max(0, contentBudget - keptAbove.length);
  const keptBelow = below.slice(0, remaining);
  if (keptBelow.length > 0) {
    return { above: keptAbove, below: [...keptBelow, marker] };
  }
  if (keptAbove.length > 0) {
    return { above: [...keptAbove, marker], below: [] };
  }
  return { above: [marker], below: [] };
}
