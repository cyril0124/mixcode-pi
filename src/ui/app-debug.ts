import type { MixCodeState, PendingEscapeAction } from "../core/types.js";

interface MixCodeTuiDebugState {
  version: 1;
  workdir: string;
  activeTabId: string;
  theme: string;
  overlays: {
    exportChooserOpen: boolean;
    exportChooserIndex: number;
    quitConfirmOpen: boolean;
    commandPaletteOpen: boolean;
    commandPalette: MixCodeState["commandPalette"];
    tabJumpOpen: boolean;
    tabJumpQuery: string;
    tabJumpIndex: number;
    picker?: Omit<NonNullable<MixCodeState["picker"]>, "items"> & { itemCount: number };
  };
  tabs: Array<{
    index: number;
    sessionId: string;
    title: string;
    status: string;
    active: boolean;
    workdir: string;
    alias: string;
    thinkingLevel: string;
    pendingDialogCount: number;
    chatScrollOffset: number;
    previewOpen: boolean;
    previewIndex: number;
    previewScrollOffset: number;
    previewHint: string;
    unreadDone: boolean;
    pendingEscapeAction?: PendingEscapeAction;
    workingStartedAt?: string;
    lastWorkedDurationSeconds?: number;
    extensionUi: {
      statusCount: number;
      widgetCount: number;
      toolsExpanded: boolean;
      workingVisible: boolean;
      hasWorkingIndicatorFrames: boolean;
      workingIndicatorIntervalMs?: number;
      hasWorkingMessage: boolean;
      hasTitle: boolean;
      headerLineCount: number;
      footerLineCount: number;
    };
    inputMetaHitRegions?: MixCodeState["tabs"][number]["inputMetaHitRegions"];
  }>;
}
export function createTuiDebugState(state: MixCodeState): MixCodeTuiDebugState {
  return {
    version: 1,
    workdir: state.workdir,
    activeTabId: state.activeTabId,
    theme: state.theme,
    overlays: {
      exportChooserOpen: state.exportChooserOpen,
      exportChooserIndex: state.exportChooserIndex,
      quitConfirmOpen: state.quitConfirmOpen,
      commandPaletteOpen: state.commandPaletteOpen,
      commandPalette: state.commandPalette,
      tabJumpOpen: state.tabJumpOpen,
      tabJumpQuery: state.tabJumpQuery,
      tabJumpIndex: state.tabJumpIndex,
      picker: state.picker
        ? {
            kind: state.picker.kind,
            title: state.picker.title,
            query: state.picker.query,
            selectedIndex: state.picker.selectedIndex,
            workdirBase: state.picker.workdirBase,
            itemCount: state.picker.items.length,
          }
        : undefined,
    },
    tabs: state.tabs.map((tab) => ({
      index: tab.index,
      sessionId: tab.sessionId,
      title: tab.title,
      status: tab.status,
      active: tab.sessionId === state.activeTabId,
      workdir: tab.workdir,
      alias: tab.alias,
      thinkingLevel: tab.thinkingLevel,
      pendingDialogCount: tab.pendingDialogs.length,
      chatScrollOffset: tab.chatScrollOffset,
      previewOpen: tab.previewOpen,
      previewIndex: tab.previewIndex,
      previewScrollOffset: tab.previewScrollOffset,
      previewHint: tab.previewHint,
      unreadDone: tab.unreadDone,
      pendingEscapeAction: tab.pendingEscapeAction,
      workingStartedAt: tab.workingStartedAt,
      lastWorkedDurationSeconds: tab.lastWorkedDurationSeconds,
      extensionUi: {
        statusCount: tab.extensionUi.statuses.length,
        widgetCount: tab.extensionUi.widgets.length,
        toolsExpanded: tab.extensionUi.toolsExpanded,
        workingVisible: tab.extensionUi.workingVisible,
        hasWorkingIndicatorFrames: Boolean(tab.extensionUi.workingIndicatorFrames?.length),
        workingIndicatorIntervalMs: tab.extensionUi.workingIndicatorIntervalMs,
        hasWorkingMessage: Boolean(tab.extensionUi.workingMessage),
        hasTitle: Boolean(tab.extensionUi.title),
        headerLineCount: tab.extensionUi.header?.lines.length ?? 0,
        footerLineCount: tab.extensionUi.footer?.lines.length ?? 0,
      },
      inputMetaHitRegions: tab.inputMetaHitRegions,
    })),
  };
}
