import { type Component, Loader, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime, RuntimeTab } from "../agent/runtime.js";
import { highlightChatSelectionLine } from "../core/chat-selection.js";
import { isPendingEscapeActive } from "../core/escape.js";
import {
  DEFAULT_ICON_MODE,
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
} from "../core/mixcode-settings.js";
import { retryStatusMessage, workingActivityMessage } from "../core/tab-state.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import { getActiveTab } from "../core/tabs.js";
import type { EditorSlot } from "./app-editor.js";
import {
  fitHeadLines,
  joinColumns,
  padLine,
  renderAgentSurface,
  exactContextUsageText,
  renderHome,
  renderExtensionFooter,
  renderExtensionPanel,
  renderExtensionWidgets,
  extensionPanelWidth,
  EXTENSION_PANEL_MIN_TERMINAL_WIDTH,
  formatElapsed,
  renderInputMeta,
  renderTabBar,
  renderTabBarSeparator,
  tabBarMaxRows,
  renderWorkingIndicator,
  setCurrentUiTheme,
  zenStatusMarkers,
} from "./rendering.js";
import { renderFloatingPanelOverlay } from "./components/floating-panel.js";
import { themeForId, type MixCodeTheme } from "./themes.js";

const WORKING_GAP_ROWS = 1;
// Horizontal rule under the tab bar (renderTabBarSeparator). Always reserve so
// a tall custom editor cannot squeeze main down to tabs-only and drop it.
const TAB_BAR_SEPARATOR_ROWS = 1;
// Keep enough rows for chat + editor chrome so a flood of extension widgets
// cannot push the tab bar into scrollback.
const MIN_CHAT_AND_EDITOR_ROWS = 6;
// Preserve enough Home rows for one agent card and its navigation hint.
const MIN_HOME_CONTENT_ROWS = 10;

function clampEditorLines(
  lines: string[],
  maxRows: number | undefined,
  autocompleteOpen: boolean,
): string[] {
  if (!maxRows || lines.length <= maxRows) return lines;
  if (autocompleteOpen) return lines.slice(-maxRows);
  return maxRows >= 2
    ? [...lines.slice(0, maxRows - 1), lines[lines.length - 1]!]
    : lines.slice(0, maxRows);
}

export function renderVisibleTabBar(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme,
  maxRows?: number,
): string[] {
  const active = getActiveTab(state);
  return active?.zenMode === true && state.activeTabId !== HOME_TAB_ID
    ? []
    : renderTabBar(state, width, theme, maxRows);
}

export class MixCodeRoot implements Component {
  constructor(
    private readonly state: MixCodeState,
    private readonly runtime: MixCodeRuntime,
    private readonly getViewportRows?: () => number,
    private readonly getReservedRows: () => number = () => 2,
    /** True when the active agent tab uses setEditorComponent (not dialogs). */
    private readonly hasCustomEditor: () => boolean = () => false,
    /** True when setInputComponent currently owns the input slot. */
    private readonly hasInputComponent: () => boolean = () => false,
  ) {}

  invalidate(): void {}

  render(width: number): string[] {
    const active = getActiveTab(this.state);
    const theme = themeForId(this.state.theme);
    const viewportRows = this.getViewportRows?.();
    const limit = viewportRows ? Math.max(0, viewportRows - this.getReservedRows()) : undefined;
    const minContentRows =
      !active || this.state.activeTabId === HOME_TAB_ID
        ? MIN_HOME_CONTENT_ROWS
        : MIN_CHAT_AND_EDITOR_ROWS;
    // Cap tab-bar height: min(10% of terminal rows, rows left after min content).
    const contentCap = limit === undefined ? undefined : Math.max(1, limit - minContentRows);
    const maxTabRows = tabBarMaxRows(viewportRows, contentCap);
    // Zen mode hides the tab bar only; separator and header stay so chrome
    // still frames the chat without tab chrome noise.
    const tabBarLines = renderVisibleTabBar(this.state, width, theme, maxTabRows);
    // Extension header is no longer pinned here; it now scrolls with the
    // conversation (rendered at the top of the agent surface), matching Pi.
    const top = tabBarLines;
    this.state.tabBarHitRow = top.length;
    // First absolute (1-indexed) row of the tab bar = rows above it + 1. Mouse
    // handlers use this with lastRenderWidth to map clicks onto wrapped rows.
    this.state.tabBarTopRow = top.length - tabBarLines.length + 1;
    this.state.lastRenderWidth = width;
    if (!active || this.state.activeTabId === HOME_TAB_ID) {
      const homeRows = limit === undefined ? undefined : Math.max(0, limit - top.length);
      return this.fitRootLines(
        [
          ...top,
          ...renderHome(
            this.state,
            width,
            theme,
            top.length,
            homeRows,
            (sessionId) => this.runtime.getTab(sessionId)?.chat,
          ),
        ],
        width,
      );
    }
    const runtimeTab = this.runtime.getTab(active.sessionId);
    // Horizontal rule directly under the tab bar (replaces the old blank gap).
    // Color tracks the active tab's editor border so the chrome reads as one frame.
    // Custom setEditorComponent skins: put agent title / override context here so
    // EditorSlot does not paint a second label strip above the input body.
    // Zen (default editor): left-anchor meaningful states from other agents.
    const customEditor = this.hasCustomEditor();
    const contentGap = renderTabBarSeparator(
      width,
      {
        thinkingLevel: active.thinkingLevel,
        vimMode: active.vimMode,
        zenMode: active.zenMode === true,
        // Temporary custom()/dialog/setInputComponent takeovers keep VIM/ZEN
        // chrome as today, but do not advertise inline-widget mode on the
        // separator — the plugin/dialog owns the slot until it restores.
        inlineWidgets:
          active.inlineWidgets === true &&
          active.extensionUi.waitingForInputs.length === 0 &&
          !this.hasInputComponent(),
        zenStatusMarkers: active.zenMode ? zenStatusMarkers(this.state.tabs, active.sessionId) : [],
        iconMode: this.state.ui?.icons?.mode ?? DEFAULT_ICON_MODE,
        agentChrome: customEditor
          ? {
              title: active.title ?? "",
              contextText:
                active.contextLimitOverridden === true ? exactContextUsageText(active) : undefined,
              customBasePrompt: active.customBasePrompt === true,
            }
          : undefined,
      },
      theme,
    );
    if (!viewportRows || limit === undefined) {
      const middle = renderAgentSurface(active, runtimeTab, width, undefined, theme, {
        oversizedAssistantMessage: this.oversizedAssistantMessagePolicy(),
        hideThinking: this.state.hideThinkingBlock ?? false,
        ...this.chatSurfaceRenderOptions(),
      });
      return [...top, ...contentGap, ...middle];
    }
    if (top.length >= limit) return top.slice(0, limit);
    const fixedTop = [...top, ...contentGap];
    if (fixedTop.length >= limit) return fixedTop.slice(0, limit);
    const middleHeight = Math.max(0, limit - fixedTop.length);
    const middle = this.renderMiddle(
      active,
      runtimeTab,
      width,
      middleHeight,
      fixedTop.length,
      theme,
    );
    return [...fixedTop, ...middle];
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
    if (!active.panelOpen || width < EXTENSION_PANEL_MIN_TERMINAL_WIDTH) {
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
        ...this.chatSurfaceRenderOptions(),
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
      ...this.chatSurfaceRenderOptions(),
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
        highlightChatSelectionLine(line, row, active.panelSelection, theme.selectedBg),
      );
    }
    return joinColumns(chat, panel, chatWidth, panelWidth);
  }

  private oversizedAssistantMessagePolicy() {
    return this.state.ui?.oversizedAssistantMessage ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE;
  }

  /** Pi SettingsManager mirrors used by chat render (images + mermaid). */
  private chatSurfaceRenderOptions() {
    return {
      mermaidRenderingMode: this.state.mermaidRenderingMode ?? ("streaming" as const),
      showImages: this.state.showImages !== false,
      imageWidthCells: this.state.imageWidthCells ?? 60,
    };
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
    // extension footer is per-agent chrome and must not paint on Home.
    if (this.state.activeTabId === HOME_TAB_ID) return [];
    const active = getActiveTab(this.state);
    return renderExtensionFooter(active, width);
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
    const isAgentTab = active && this.state.activeTabId !== HOME_TAB_ID;
    // Vim mode is a read-only chat-scrolling surface; suppress extension
    // widgets (above/below editor) so reclaimed rows grow the chat history.
    // Widget registration/lifecycle is untouched — this only gates rendering.
    // The side panel likewise relocates these widgets, so hide them here when
    // it is open (they render inside the panel via MixCodeRoot).
    const isVim = active?.vimMode === true;
    const panelOpen = active?.panelOpen === true;
    const panelShowing = panelOpen && width >= EXTENSION_PANEL_MIN_TERMINAL_WIDTH;
    // Inline mode relocates widgets into the chat tail. A live side panel still
    // owns them (same as today). Narrow panelOpen does not actually split, so
    // leave widgets in the dock unless inline is on and the panel is closed.
    const hideEditorWidgets =
      isVim || panelShowing || (active?.inlineWidgets === true && !panelOpen);
    const iconMode = this.state.ui?.icons?.mode ?? DEFAULT_ICON_MODE;
    const metaProbe = isAgentTab ? renderInputMeta(active, width, 0, theme, false, iconMode) : [];
    const workingLines = isAgentTab ? this.renderWorkingLoader(active, width, theme) : [];
    const viewportRowsForClamp = this.getViewportRows?.();
    const activeForFooter = this.state.activeTabId === HOME_TAB_ID ? undefined : active;
    const footerRows = renderExtensionFooter(activeForFooter, width).length;
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
      width,
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
    // Clamp tall editors so they cannot push the tab bar into scrollback.
    // Pi uses flex minSize on the editor dock instead of slicing render output;
    // when we must clamp, keep head+last for selectors, and the tail while
    // autocomplete is open so the dropdown stays visible (custom skins are taller).
    let clampedEditorLines = clampEditorLines(
      editorLines,
      maxEditorRows,
      this.editor.isShowingAutocomplete(),
    );
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
    if (active?.vimTranscriptSearch) {
      clampedEditorLines = clampEditorLines(
        this.editor.render(width),
        maxEditorRows,
        this.editor.isShowingAutocomplete(),
      );
      this.setEditorRows(clampedEditorLines.length);
    }
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
    const spacerRows = floatingRows;
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
          highlightChatSelectionLine(line, row, active.inputSelection, theme.selectedBg),
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
    // Meta sits under the editor frame (not inside the bottom border).
    // Exact xxk/xxk is on the top border; without an extension footer this
    // row shows model/bar+%/git. When a footer is set, meta collapses.
    const metaLines =
      active && this.state.activeTabId !== HOME_TAB_ID
        ? renderInputMeta(active, width, metaRow, theme, true, iconMode)
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
    ];
    return active && this.state.activeTabId !== HOME_TAB_ID
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
    workingActivityMessage(active),
    active.extensionUi.workingIndicatorFrames,
    active.extensionUi.workingIndicatorIntervalMs,
  ]);
}

function workingLoaderMessage(active: MixCodeState["tabs"][number], now: Date): string {
  // During auto-retry, mirror Pi's countdown status line. The 80ms working
  // redraw drives the live ticking; see retryStatusMessage.
  const retry = retryStatusMessage(active, now);
  if (retry) return retry;
  const message = workingActivityMessage(active);
  const elapsed = formatElapsed(active.workingStartedAt, now);
  const detail = isPendingEscapeActive(active, now.getTime())
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

/** Cap stacked editor widgets to a shared row budget; prefer aboveEditor first. */
function fitEditorWidgets(
  above: string[],
  below: string[],
  budget: number | undefined,
  theme: MixCodeTheme,
  width: number,
): { above: string[]; below: string[] } {
  if (budget === undefined) return { above, below };
  const total = above.length + below.length;
  if (total <= budget) return { above, below };
  if (budget <= 0) return { above: [], below: [] };

  const marker = padLine(theme.dim("… (widgets truncated)"), width);
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
