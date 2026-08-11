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
import { scrollChat, scrollExtensionPanel, scrollPreview, clearChatScrollAnchor } from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import { createPicker } from "../core/pickers.js";
import { activateTab } from "../core/tabs.js";
import { closeTreeSelector } from "./tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import {
  getActiveNotice,
  hasActiveNotice,
  hasAnyOverlay,
  setActiveNoticeSelection,
  showLinesOverlay,
} from "./app-overlays.js";
import { activeExtensionCommands } from "./app-runtime.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { renderCommandPalette, renderPickerOverlay, tabBarHitRegions } from "./rendering.js";

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
  if (!mouse || !active || state.activeTabId === "config") return false;
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
  if (handleChromeMouse(state, active, mouse, tui)) return true;
  if (!active) return false;
  if (mouse.wheel && active.previewOpen) {
    scrollPreview(active, mouse.wheel === "up" ? -3 : 3);
    tui.requestRender();
    return true;
  }
  if (mouse.wheel && active.extensionUi.waitingForInputs.length > 0) {
    scrollChat(active, mouse.wheel === "up" ? 3 : -3);
    tui.requestRender();
    return true;
  }
  // Notice is nonCapturing: selection inside notice bounds, otherwise continue
  // to wheel/input/chat paths so Notice does not freeze the rest of the UI.
  if (handleNoticeSelectionMouse(active, mouse, tui, copyToClipboard)) return true;
  if (hasAnyOverlay(tui) && !hasActiveNotice()) return false;
  // Clicking the chat scrollbar gutter jumps scroll position (before text selection).
  if (handleChatScrollbarMouse(state, active, mouse, tui)) return true;
  if (handleInputSelectionMouse(active, mouse, tui, copyToClipboard)) return true;
  // While an extension dialog/custom UI owns input, keep the side panel visible
  // but do not let panel selection/scroll steal clicks or drags from the modal.
  const panelInteractive =
    active.panelOpen &&
    active.extensionUi.waitingForInputs.length === 0 &&
    active.pendingDialogs.length === 0;
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
  if (mouse.wheel && state.activeTabId !== "config") {
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

/**
 * Click on the rightmost chat gutter (scrollbar track/thumb) maps y → chatScrollOffset.
 * offset 0 = bottom (newest); maxOffset = top (oldest). Matches fitScrolledLinesWithInfo.
 */
function handleChatScrollbarMouse(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  mouse: SgrMouseInput,
  tui: OverlayTui,
): boolean {
  if (state.activeTabId === "config") return false;
  if (mouse.wheel || mouse.release || mouse.button !== 0) return false;
  const bounds = active.chatSurfaceBounds;
  const metrics = active.lastChatScrollMetrics;
  if (!bounds || !metrics?.scrollable || metrics.viewport <= 0 || metrics.total <= metrics.viewport) {
    return false;
  }
  // Scrollbar is painted in the last column of the full chat surface (bounds.width is content).
  const barCol = bounds.left + bounds.width;
  if (mouse.x !== barCol) return false;
  if (mouse.y < bounds.top || mouse.y >= bounds.top + bounds.height) return false;

  const viewport = metrics.viewport;
  const maxOffset = Math.max(0, metrics.total - viewport);
  const rowInBar = Math.min(viewport - 1, Math.max(0, mouse.y - bounds.top));
  // Thumb top fraction maps start; start = total - viewport - offset (approx).
  // Clicking top of track → older (high offset); bottom → newer (offset 0).
  const fraction = viewport <= 1 ? 0 : rowInBar / (viewport - 1);
  const nextOffset = Math.round((1 - fraction) * maxOffset);
  clearChatScrollAnchor(active);
  active.chatScrollOffset = Math.min(1_000_000, Math.max(0, nextOffset));
  tui.requestRender();
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
  const tabBarVisible =
    !(active?.zenMode === true && state.activeTabId !== "config");
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
      activateTab(state, tabId);
      tui.requestRender();
      return true;
    }
  }
  // Agent footer meta regions stay on the tab after leaving for Home; ignore them
  // while config is active so Home clicks cannot open model/thinking/workdir pickers.
  if (
    active &&
    state.activeTabId !== "config" &&
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
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
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
  const notice = getActiveNotice();
  if (!notice?.bounds) return false;
  return handleTextSelectionMouse({
    active,
    mouse,
    tui,
    copyToClipboard,
    bounds: notice.bounds,
    getSelection: () => notice.selection,
    setSelection: (selection) => {
      setActiveNoticeSelection(selection);
    },
    getLines: () => notice.renderedLines,
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tabBarMouseRow(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
): number {
  return state.tabBarHitRow ?? 1 + (active?.extensionUi?.header?.lines.length ?? 0);
}
