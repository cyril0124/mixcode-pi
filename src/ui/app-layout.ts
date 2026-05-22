import { type Component, Loader, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { MixCodeRuntime } from "../agent/runtime.js";
import { isPendingEscapeActive } from "../core/escape.js";
import type { MixCodeState } from "../core/types.js";
import type { EditorSlot } from "./app-editor.js";
import {
  fitHeadLines,
  padLine,
  renderAgentSurface,
  renderConfig,
  renderExtensionFooter,
  renderExtensionHeader,
  renderExtensionWidgets,
  renderFooter,
  renderHeader,
  renderInputMeta,
  renderPreviewOverlay,
  renderQuestionOverlay,
  renderShellOverlay,
  renderStatus,
  renderTabBar,
  renderWorkingIndicator,
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
    const active =
      this.state.tabs.find((tab) => tab.sessionId === this.state.activeTabId) ?? this.state.tabs[0];
    const theme = themeForId(this.state.theme);
    const top = [
      ...renderHeader(width, theme),
      ...renderExtensionHeader(active, width),
      ...renderTabBar(this.state, width, theme),
    ];
    this.state.tabBarHitRow = top.length;
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
    top.push(...renderStatus(active, width, theme));
    const contentGap = [padLine("", width)];
    const shell = renderShellOverlay(active, width, theme);
    const preview = renderPreviewOverlay(active, width, theme);
    const question = renderQuestionOverlay(active, width, theme);
    const bottomBeforeMeta = [...shell, ...preview, ...question];
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
    active.chatSurfaceBounds = {
      top: fixedTop.length + 1,
      left: 1,
      width: Math.max(1, width - 1),
      height: middleHeight,
    };
    const middle = renderAgentSurface(active, runtimeTab, width, middleHeight, theme);
    return [...fixedTop, ...middle, ...visibleBottom];
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
    const active =
      this.state.tabs.find((tab) => tab.sessionId === this.state.activeTabId) ?? this.state.tabs[0];
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
    const editorLines = this.editor.render(width);
    const active =
      this.state.tabs.find((tab) => tab.sessionId === this.state.activeTabId) ?? this.state.tabs[0];
    const metaProbe =
      active && this.state.activeTabId !== "config"
        ? renderInputMeta(active, width, 0, theme, false)
        : [];
    const workingLines =
      active && this.state.activeTabId !== "config"
        ? this.renderWorkingLoader(active, width, theme)
        : [];
    const widgetsAbove =
      active && this.state.activeTabId !== "config"
        ? renderExtensionWidgets(active, width, "aboveEditor", theme)
        : [];
    const widgetsBelow =
      active && this.state.activeTabId !== "config"
        ? renderExtensionWidgets(active, width, "belowEditor", theme)
        : [];
    const widgetsAboveBottomGapRows =
      widgetsAbove.length > 0 && (workingLines.length > 0 || editorLines.length > 0)
        ? WORKING_GAP_ROWS
        : 0;
    const controlTopGapRows = editorLines.length > 0 ? WORKING_GAP_ROWS : 0;
    const workingBottomGapRows = workingLines.length > 0 ? WORKING_GAP_ROWS : 0;
    this.setEditorRows(editorLines.length);
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
            editorLines.length -
            widgetsBelow.length -
            metaProbe.length -
            footerLines.length,
        )
      : 0;
    const guardRows = Math.min(TERMINAL_SCROLL_GUARD_ROWS, floatingRows);
    const spacerRows = Math.max(0, floatingRows - guardRows);
    const metaRow =
      mainLines.length +
      spacerRows +
      controlTopGapRows +
      widgetsAbove.length +
      workingLines.length +
      workingBottomGapRows +
      widgetsAboveBottomGapRows +
      editorLines.length +
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
      ...editorLines,
      ...widgetsBelow,
      ...metaLines,
      ...footerLines,
      ...Array.from({ length: guardRows }, () => padLine("", Math.max(0, width - 1))),
    ];
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
