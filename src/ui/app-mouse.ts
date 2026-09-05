import {
  captureScrollableChatSelection,
  pointInChatSurface,
  screenToChatSelectionPoint,
  selectedChatText,
  selectedInputText,
  selectedNoticeText,
  selectedScrollableChatText,
  startScrollableChatSelection,
  toScrollableChatSelectionPoint,
  type ChatSelectionPoint,
  type ChatSelectionState,
} from "../core/chat-selection.js";
import { copyToClipboard as writeClipboard } from "@earendil-works/pi-coding-agent";
import { parseSgrMouseInput, type SgrMouseInput } from "../core/mouse.js";
import { chatScrollbarFor } from "./chat-scrollbar.js";
import { clearScrollFreeze } from "./rendering/agent-surface-scroll.js";
import {
  acceptCommandPaletteSelection,
  acceptTabJumpSelection,
  clearChatScrollAnchor,
  isOverlayActive,
  closeActiveOverlay,
  moveCommandPaletteSelection,
  moveTabJumpSelection,
  openTabJump,
  scrollChat,
  scrollExtensionPanel,
} from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import { createPicker } from "../core/pickers.js";
import { activateTab } from "../core/tabs.js";
import { closeTreeSelector } from "./components/tree-selector.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import {
  closeAppOverlay,
  getActiveNotice,
  getAppOverlayBounds,
  hasActiveNotice,
  errorMessage,
  hasAnyOverlay,
  setActiveNoticeSelection,
  showErrorOverlay,
  showLinesOverlay,
  syncOwnedAppOverlay,
} from "./app-overlays.js";
import type { CommandPaletteActions, MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { handleListOverlayMouse } from "./components/list-overlay-mouse.js";
import {
  planCommandPaletteList,
  planTabJumpList,
  renderCommandPalette,
  renderTabJumpOverlay,
  tabBarHitRegions,
} from "./rendering.js";

type ClipboardWriter = (text: string) => Promise<void>;
type ActiveTab = MixCodeState["tabs"][number];

const CHAT_SELECTION_AUTO_SCROLL_INTERVAL_MS = 50;

interface ChatSelectionAutoScrollState {
  active: ActiveTab;
  selection: ChatSelectionState;
  tui: OverlayTui;
  pointer: { x: number; y: number };
  scrollDelta: -1 | 1;
  timer?: ReturnType<typeof setInterval>;
}

let chatSelectionAutoScroll: ChatSelectionAutoScrollState | undefined;

export function stopChatSelectionAutoScroll(): void {
  if (chatSelectionAutoScroll?.timer) clearInterval(chatSelectionAutoScroll.timer);
  chatSelectionAutoScroll = undefined;
}

function stopChatSelectionAutoScrollFor(selection: ChatSelectionState): void {
  if (chatSelectionAutoScroll?.selection === selection) stopChatSelectionAutoScroll();
}

function updateChatSelectionAutoScroll(
  active: ActiveTab,
  selection: ChatSelectionState,
  mouse: SgrMouseInput,
  tui: OverlayTui,
): void {
  const bounds = active.chatSurfaceBounds;
  if (!bounds) {
    stopChatSelectionAutoScrollFor(selection);
    return;
  }
  const bottom = bounds.top + bounds.height - 1;
  const scrollDelta = mouse.y <= bounds.top ? 1 : mouse.y >= bottom ? -1 : 0;
  if (scrollDelta === 0 || !canAutoScrollChat(active, scrollDelta)) {
    stopChatSelectionAutoScrollFor(selection);
    return;
  }
  if (chatSelectionAutoScroll?.selection === selection) {
    chatSelectionAutoScroll.pointer = { x: mouse.x, y: mouse.y };
    chatSelectionAutoScroll.scrollDelta = scrollDelta;
    return;
  }

  stopChatSelectionAutoScroll();
  const state: ChatSelectionAutoScrollState = {
    active,
    selection,
    tui,
    pointer: { x: mouse.x, y: mouse.y },
    scrollDelta,
  };
  chatSelectionAutoScroll = state;
  state.timer = setInterval(
    () => autoScrollChatSelection(state),
    CHAT_SELECTION_AUTO_SCROLL_INTERVAL_MS,
  );
  state.timer.unref();
}

function autoScrollChatSelection(state: ChatSelectionAutoScrollState): void {
  const { active, selection, pointer, scrollDelta, tui } = state;
  const bounds = active.chatSurfaceBounds;
  if (
    chatSelectionAutoScroll !== state ||
    active.chatSelection !== selection ||
    !selection.dragging ||
    !bounds ||
    !canAutoScrollChat(active, scrollDelta)
  ) {
    stopChatSelectionAutoScrollFor(selection);
    return;
  }

  const lines = active.lastRenderedChatLines ?? [];
  captureScrollableChatSelection(selection, lines, active.chatScrollOffset);
  scrollChat(active, scrollDelta);
  const point = screenToChatSelectionPoint(bounds, pointer.y, pointer.x);
  selection.focus = toScrollableChatSelectionPoint(
    selection,
    point,
    lines,
    active.chatScrollOffset,
  );
  tui.requestRender();
}

function canAutoScrollChat(active: ActiveTab, scrollDelta: -1 | 1): boolean {
  const metrics = active.lastChatScrollMetrics;
  if (!metrics?.scrollable) return false;
  return scrollDelta > 0 ? metrics.start > 0 : metrics.end < metrics.total;
}

export function handleChatSelectionMouseInput(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
  _runtime?: Pick<MixCodeKeyRuntime, "appendSystemMessage">,
  copyToClipboard: ClipboardWriter = writeClipboard,
): boolean {
  const mouse = parseSgrMouseInput(data);
  if (!mouse || !active || state.activeTabId === HOME_TAB_ID) return false;
  return handleChatSelectionMouse(active, mouse, tui, copyToClipboard);
}

export function handleInputSelectionMouseInput(
  _state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
  copyToClipboard: ClipboardWriter = writeClipboard,
): boolean {
  const mouse = parseSgrMouseInput(data);
  if (!mouse || !active) return false;
  return handleInputSelectionMouse(active, mouse, tui, copyToClipboard);
}

export function handleMouseInput(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
  _shellManager?: unknown,
  runtime?: Pick<MixCodeKeyRuntime, "appendSystemMessage">,
  copyToClipboard: ClipboardWriter = writeClipboard,
): boolean {
  const mouse = parseSgrMouseInput(data);
  if (!mouse) return false;
  if (handleChatScrollbarMouseInput(state, active, data, tui)) return true;
  if (handleChromeMouse(state, active, mouse, tui)) return true;
  if (!active) return false;
  if (mouse.wheel && active.extensionUi.waitingForInputs.length > 0) {
    scrollChat(active, mouse.wheel === "up" ? 3 : -3);
    tui.requestRender();
    return true;
  }
  // Notice is nonCapturing: selection inside notice bounds, otherwise continue
  // to wheel/input/chat paths so Notice does not freeze the rest of the UI.
  if (handleNoticeSelectionMouse(active, mouse, tui, copyToClipboard)) return true;
  if (hasAnyOverlay(tui) && !hasActiveNotice()) return false;
  if (handleInputSelectionMouse(active, mouse, tui, copyToClipboard)) return true;
  // While an extension dialog/custom UI owns input, keep the side panel visible
  // but do not let panel selection/scroll steal clicks or drags from the modal.
  const panelInteractive = active.panelOpen && active.extensionUi.waitingForInputs.length === 0;
  if (panelInteractive && handlePanelSelectionMouse(active, mouse, tui, copyToClipboard)) {
    return true;
  }
  if (handleChatSelectionMouseInput(state, active, data, tui, runtime, copyToClipboard)) {
    return true;
  }
  // Wheel over the open side panel scrolls the panel; anywhere else scrolls
  // chat. Region routing keeps the two side-by-side scroll regions independent.
  // Notice does not block wheel outside its bounds (handled above only for selection).
  // Pending interactions already force wheel→chat above; this path is idle-only.
  if (
    mouse.wheel &&
    panelInteractive &&
    pointInChatSurface(active.panelSurfaceBounds, { row: mouse.y, col: mouse.x })
  ) {
    scrollExtensionPanel(active, mouse.wheel === "up" ? -3 : 3);
    tui.requestRender();
    return true;
  }
  if (mouse.wheel && state.activeTabId !== HOME_TAB_ID) {
    scrollChat(active, mouse.wheel === "up" ? 3 : -3);
    tui.requestRender();
    return true;
  }
  return false;
}

export function handleChromeMouseInput(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
): boolean {
  const mouse = parseSgrMouseInput(data);
  return mouse ? handleChromeMouse(state, active, mouse, tui) : false;
}

/** Wheel scrolls the selection; click on a row jumps (same as Enter). */
export function handleTabJumpMouse(state: MixCodeState, data: string, tui: OverlayTui): boolean {
  return handleListOverlayMouse(data, {
    isOpen: () => state.tabJumpOpen,
    plan: () => planTabJumpList(state),
    bounds: () => getAppOverlayBounds(tui),
    onMove: (delta) => moveTabJumpSelection(state, delta),
    onAccept: (entryIndex) => {
      state.tabJumpIndex = entryIndex;
      acceptTabJumpSelection(state);
      closeAppOverlay(tui);
      tui.requestRender();
    },
    reshow: () => showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width)),
  });
}

/** Wheel scrolls palette selection; click runs the row (same as Enter). */
export function handleCommandPaletteMouse(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  commandPaletteActions?: CommandPaletteActions,
): boolean {
  const extensionCommands = commandPaletteActions?.extensionCommands?.() ?? [];
  return handleListOverlayMouse(data, {
    isOpen: () => state.commandPaletteOpen,
    plan: () => planCommandPaletteList(state, extensionCommands),
    bounds: () => getAppOverlayBounds(tui),
    onMove: (delta) => moveCommandPaletteSelection(state, delta, extensionCommands),
    onAccept: (entryIndex) => {
      state.commandPalette.selectedIndex = entryIndex;
      const selected = planCommandPaletteList(state, extensionCommands).entries[entryIndex];
      if (selected && !commandPaletteActions?.executeCommand) {
        throw new Error("Command palette selection requires command execution support");
      }
      const command = acceptCommandPaletteSelection(state, extensionCommands);
      closeAppOverlay(tui);
      if (command) {
        void Promise.resolve(commandPaletteActions!.executeCommand(command)).catch(
          (error: unknown) => {
            showErrorOverlay(tui, error);
            tui.requestRender();
          },
        );
      }
      tui.requestRender();
    },
    reshow: () =>
      showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands)),
  });
}

/** Scrollbar capture precedes text selection; mouse coordinates are 1-based. */
export function handleChatScrollbarMouseInput(
  state: MixCodeState,
  active: ActiveTab | undefined,
  data: string,
  tui: OverlayTui,
): boolean {
  if (!active) return false;
  const scrollbar = chatScrollbarFor(active);
  if (
    state.activeTabId === HOME_TAB_ID ||
    isOverlayActive(state) ||
    active.extensionUi.waitingForInputs.length > 0 ||
    (hasAnyOverlay(tui) && !hasActiveNotice())
  ) {
    scrollbar.reset();
    return false;
  }
  const mouse = parseSgrMouseInput(data);
  const bounds = active.chatSurfaceBounds;
  const geometry = scrollbar.geometry;
  if (!mouse || !bounds || !geometry) return false;
  const notice = hasActiveNotice() ? getAppOverlayBounds(tui) : undefined;
  if (
    notice &&
    mouse.x > notice.col &&
    mouse.x <= notice.col + notice.width &&
    mouse.y > notice.row &&
    mouse.y <= notice.row + notice.height
  ) {
    scrollbar.reset();
    return false;
  }
  scrollbar.requestRender = () => tui.requestRender();
  const row = mouse.y - bounds.top;
  const onTrack =
    mouse.x === bounds.left + geometry.column && row >= 0 && row < geometry.trackHeight;
  const scrollToPointer = (grabOffset: number): void => {
    const travel = geometry.trackHeight - geometry.thumbHeight;
    const thumbTop = Math.max(0, Math.min(travel, row - grabOffset));
    const start = travel === 0 ? 0 : Math.round((thumbTop / travel) * geometry.maxScrollTop);
    // A pointer seek is absolute, not a delta relative to a frozen/anchored message.
    clearChatScrollAnchor(active);
    clearScrollFreeze(active);
    active.chatScrollOffset = geometry.maxScrollTop - start;
    tui.requestRender();
  };

  if (scrollbar.grabOffset !== undefined) {
    if (mouse.release) {
      scrollbar.grabOffset = undefined;
      scrollbar.hover(onTrack);
      tui.requestRender();
      return true;
    }
    if (mouse.motion && mouse.button === 0) {
      scrollToPointer(scrollbar.grabOffset);
      return true;
    }
  }
  if (active.chatSelection?.dragging) return false;
  // Button 3 + motion is an unpressed pointer move (SGR raw button 35).
  if (mouse.motion && mouse.button === 3) {
    scrollbar.hover(onTrack);
    return onTrack;
  }
  if (mouse.wheel || mouse.release || mouse.motion || mouse.button !== 0 || !onTrack) return false;

  stopChatSelectionAutoScroll();
  active.chatSelection = undefined;
  active.inputSelection = undefined;
  active.panelSelection = undefined;
  scrollbar.hover(true);
  const onThumb = row >= geometry.thumbTop && row < geometry.thumbTop + geometry.thumbHeight;
  scrollbar.grabOffset = onThumb ? row - geometry.thumbTop : Math.floor(geometry.thumbHeight / 2);
  if (!onThumb) scrollToPointer(scrollbar.grabOffset);
  return true;
}

function handleChromeMouse(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  mouse: SgrMouseInput,
  tui: OverlayTui,
): boolean {
  // Capturing overlays own the screen; only non-capturing Notice allows chrome clicks.
  if (hasAnyOverlay(tui) && !hasActiveNotice()) return false;
  // Zen hides the tab bar; ghost hit-regions must not steal clicks on the
  // separator / chat that now occupy those screen rows.
  const tabBarVisible = !(active?.zenMode === true && state.activeTabId !== HOME_TAB_ID);
  const tabBarTop = state.tabBarTopRow ?? tabBarMouseRow(state, active);
  if (
    tabBarVisible &&
    mouse.y >= tabBarTop &&
    mouse.button === 0 &&
    !mouse.release &&
    !mouse.motion &&
    !mouse.wheel
  ) {
    const clickedRow = mouse.y - tabBarTop;
    const width = state.lastRenderWidth ?? Number.POSITIVE_INFINITY;
    const visibleRows =
      state.tabBarHitRow === undefined
        ? undefined
        : Math.max(0, state.tabBarHitRow - tabBarTop + 1);
    const tabId = tabBarHitRegions(state, width, visibleRows).find(
      (region) =>
        (region.row ?? 0) === clickedRow && mouse.x >= region.startX && mouse.x <= region.endX,
    )?.id;
    if (tabId) {
      // Tree is global; close owner editor before focusing another tab.
      if (state.treeSelector.open && state.activeTabId !== tabId) {
        closeTreeSelector(state, tui);
      }
      // Re-click the active tab (Home or agent) → same as Ctrl+T Tab Jump.
      if (tabId === state.activeTabId) {
        if (state.treeSelector.open) closeTreeSelector(state, tui);
        // Reset any tracked app overlay's routing flag before Tab Jump
        // replaces it (showLinesOverlay hides the component without
        // running its close path).
        closeAppOverlay(tui);
        closeActiveOverlay(state);
        openTabJump(state);
        showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
        return true;
      }
      activateTab(state, tabId);
      tui.requestRender();
      return true;
    }
  }
  // Agent footer meta regions stay on the tab after leaving for Home; ignore them
  // while config is active so Home clicks cannot open model/thinking/workdir pickers.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    mouse.button === 0 &&
    !mouse.release &&
    !mouse.motion &&
    !mouse.wheel &&
    active.inputMetaHitRegions?.length
  ) {
    const action = active.inputMetaHitRegions.find(
      (region) => region.row === mouse.y && mouse.x >= region.startX && mouse.x <= region.endX,
    )?.action;
    if (action) {
      state.picker = createPicker(action, state, active);
      syncOwnedAppOverlay(state, tui);
      tui.requestRender();
      return true;
    }
  }
  return false;
}

function handleInputSelectionMouse(
  active: MixCodeState["tabs"][number],
  mouse: SgrMouseInput,
  tui: OverlayTui,
  copyToClipboard: ClipboardWriter,
): boolean {
  return handleTextSelectionMouse({
    active,
    mouse,
    tui,
    copyToClipboard,
    bounds: active.inputSurfaceBounds,
    getSelection: () => active.inputSelection,
    setSelection: (selection) => {
      active.inputSelection = selection;
    },
    getLines: () => active.lastRenderedInputLines ?? [],
    selectText: selectedInputText,
  });
}

function handleNoticeSelectionMouse(
  active: MixCodeState["tabs"][number],
  mouse: SgrMouseInput,
  tui: OverlayTui,
  copyToClipboard: ClipboardWriter,
): boolean {
  if (!hasActiveNotice()) return false;
  // Compositor bounds are 0-based; chat selection coordinates are 1-based.
  const overlayBounds = getAppOverlayBounds(tui);
  if (!overlayBounds) return false;
  const bounds: MixCodeState["tabs"][number]["chatSurfaceBounds"] = {
    top: overlayBounds.row + 1,
    left: overlayBounds.col + 1,
    width: overlayBounds.width,
    height: overlayBounds.height,
  };
  return handleTextSelectionMouse({
    active,
    mouse,
    tui,
    copyToClipboard,
    bounds,
    getSelection: () => getActiveNotice()?.selection,
    setSelection: (selection) => {
      const notice = getActiveNotice();
      if (!notice) return;
      setActiveNoticeSelection(selection);
    },
    getLines: () => getActiveNotice()?.renderedLines ?? [],
    selectText: selectedNoticeText,
  });
}

function handleChatSelectionMouse(
  active: MixCodeState["tabs"][number],
  mouse: SgrMouseInput,
  tui: OverlayTui,
  copyToClipboard: ClipboardWriter,
): boolean {
  return handleTextSelectionMouse({
    active,
    mouse,
    tui,
    copyToClipboard,
    bounds: active.chatSurfaceBounds,
    getSelection: () => active.chatSelection,
    setSelection: (selection) => {
      active.chatSelection = selection;
    },
    getLines: () => active.lastRenderedChatLines ?? [],
    selectText: selectedScrollableChatText,
    mapPoint: (point, selection) => {
      if (!selection) return point;
      const lines = active.lastRenderedChatLines ?? [];
      captureScrollableChatSelection(selection, lines, active.chatScrollOffset);
      return toScrollableChatSelectionPoint(selection, point, lines, active.chatScrollOffset);
    },
    onSelectionStart: (selection) => {
      stopChatSelectionAutoScroll();
      startScrollableChatSelection(
        selection,
        active.lastRenderedChatLines ?? [],
        active.chatScrollOffset,
      );
    },
    onSelectionMotion: (selection) => {
      updateChatSelectionAutoScroll(active, selection, mouse, tui);
    },
    onSelectionRelease: (selection) => {
      captureScrollableChatSelection(
        selection,
        active.lastRenderedChatLines ?? [],
        active.chatScrollOffset,
      );
      stopChatSelectionAutoScrollFor(selection);
    },
  });
}

function handlePanelSelectionMouse(
  active: MixCodeState["tabs"][number],
  mouse: SgrMouseInput,
  tui: OverlayTui,
  copyToClipboard: ClipboardWriter,
): boolean {
  return handleTextSelectionMouse({
    active,
    mouse,
    tui,
    copyToClipboard,
    bounds: active.panelSurfaceBounds,
    getSelection: () => active.panelSelection,
    setSelection: (selection) => {
      active.panelSelection = selection;
    },
    getLines: () => active.lastRenderedPanelLines ?? [],
    selectText: selectedChatText,
  });
}

interface TextSelectionMouseOptions {
  active: MixCodeState["tabs"][number];
  mouse: SgrMouseInput;
  tui: OverlayTui;
  copyToClipboard: ClipboardWriter;
  bounds: MixCodeState["tabs"][number]["chatSurfaceBounds"];
  getSelection: () => MixCodeState["tabs"][number]["chatSelection"];
  setSelection: (selection: MixCodeState["tabs"][number]["chatSelection"]) => void;
  getLines: () => string[];
  selectText: typeof selectedChatText;
  mapPoint?: (
    point: ChatSelectionPoint,
    selection: ChatSelectionState | undefined,
  ) => ChatSelectionPoint;
  onSelectionStart?: (selection: ChatSelectionState) => void;
  onSelectionMotion?: (selection: ChatSelectionState) => void;
  onSelectionRelease?: (selection: ChatSelectionState) => void;
}

function handleTextSelectionMouse(options: TextSelectionMouseOptions): boolean {
  const {
    active,
    mouse,
    tui,
    copyToClipboard,
    bounds,
    getSelection,
    setSelection,
    getLines,
    selectText,
  } = options;
  const screenPoint = { row: mouse.y, col: mouse.x };
  if (mouse.wheel) return false;
  if (
    mouse.button === 0 &&
    !mouse.release &&
    !mouse.motion &&
    bounds !== undefined &&
    pointInChatSurface(bounds, screenPoint)
  ) {
    const rawPoint = screenToChatSelectionPoint(bounds, mouse.y, mouse.x);
    const point = options.mapPoint?.(rawPoint, undefined) ?? rawPoint;
    const selection = { anchor: point, focus: point, dragging: true };
    setSelection(selection);
    options.onSelectionStart?.(selection);
    tui.requestRender();
    return true;
  }
  const selection = getSelection();
  if (selection?.dragging && mouse.button === 0 && mouse.motion && !mouse.release && bounds) {
    const rawPoint = screenToChatSelectionPoint(bounds, mouse.y, mouse.x);
    selection.focus = options.mapPoint?.(rawPoint, selection) ?? rawPoint;
    options.onSelectionMotion?.(selection);
    tui.requestRender();
    return true;
  }
  if (selection?.dragging && mouse.release) {
    selection.dragging = false;
    options.onSelectionRelease?.(selection);
    const text = selectText(getLines(), selection);
    const chars = text.length;
    setSelection(undefined);
    if (!text) {
      tui.requestRender();
      return true;
    }
    void copyToClipboard(text)
      .then(() => {
        pushToast(active, { type: "success", message: `Copied ${chars} chars.` });
        tui.requestRender();
      })
      .catch((error: unknown) => {
        pushToast(active, { type: "error", message: `Copy failed: ${errorMessage(error)}` });
        tui.requestRender();
      });
    tui.requestRender();
    return true;
  }
  return false;
}

function tabBarMouseRow(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
): number {
  return state.tabBarHitRow ?? 1 + (active?.extensionUi?.header?.lines.length ?? 0);
}
