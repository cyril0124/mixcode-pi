import {
  pointInChatSurface,
  screenToChatSelectionPoint,
  selectedChatText,
  selectedInputText,
} from "../core/chat-selection.js";
import { copyTextToClipboard, type ClipboardWriter } from "../core/clipboard.js";
import { hitMouseRegion, parseSgrMouseInput } from "../core/mouse.js";
import { scrollChat, scrollPreview } from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import { createPicker } from "../core/pickers.js";
import { activateTab } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { hasAnyOverlay, showLinesOverlay } from "./app-overlays.js";
import { activeExtensionCommands } from "./app-runtime.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { renderCommandPalette, renderPickerOverlay, tabBarHitRegions } from "./rendering.js";

export function handleChatSelectionMouseInput(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
  _runtime?: Pick<MixCodeKeyRuntime, "appendSystemMessage">,
  copyToClipboard: ClipboardWriter = copyTextToClipboard,
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
  copyToClipboard: ClipboardWriter = copyTextToClipboard,
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
  copyToClipboard: ClipboardWriter = copyTextToClipboard,
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
  if (mouse.wheel && active.extensionUi.pendingUserInteractions.length > 0) {
    scrollChat(active, mouse.wheel === "up" ? 3 : -3);
    tui.requestRender();
    return true;
  }
  if (hasAnyOverlay(tui)) return false;
  if (handleInputSelectionMouse(active, mouse, tui, copyToClipboard)) return true;
  if (active.panelOpen && handlePanelSelectionMouse(active, mouse, tui, copyToClipboard)) {
    return true;
  }
  if (handleChatSelectionMouseInput(state, active, data, tui, runtime, copyToClipboard)) {
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

function handleChromeMouse(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  mouse: NonNullable<ReturnType<typeof parseSgrMouseInput>>,
  tui: OverlayTui,
): boolean {
  if (
    mouse.y === tabBarMouseRow(state, active) &&
    mouse.button === 0 &&
    !mouse.release &&
    !mouse.wheel
  ) {
    const tabId = hitMouseRegion(tabBarHitRegions(state), mouse.x);
    if (tabId) {
      activateTab(state, tabId);
      tui.requestRender();
      return true;
    }
  }
  if (
    active &&
    mouse.button === 0 &&
    !mouse.release &&
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
  mouse: NonNullable<ReturnType<typeof parseSgrMouseInput>>,
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

function handleChatSelectionMouse(
  active: MixCodeState["tabs"][number],
  mouse: NonNullable<ReturnType<typeof parseSgrMouseInput>>,
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
    selectText: selectedChatText,
  });
}

function handlePanelSelectionMouse(
  active: MixCodeState["tabs"][number],
  mouse: NonNullable<ReturnType<typeof parseSgrMouseInput>>,
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
  mouse: NonNullable<ReturnType<typeof parseSgrMouseInput>>;
  tui: OverlayTui;
  copyToClipboard: ClipboardWriter;
  bounds: MixCodeState["tabs"][number]["chatSurfaceBounds"];
  getSelection: () => MixCodeState["tabs"][number]["chatSelection"];
  setSelection: (selection: MixCodeState["tabs"][number]["chatSelection"]) => void;
  getLines: () => string[];
  selectText: typeof selectedChatText;
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
    const point = screenToChatSelectionPoint(bounds, mouse.y, mouse.x);
    setSelection({ anchor: point, focus: point, dragging: true });
    tui.requestRender();
    return true;
  }
  const selection = getSelection();
  if (selection?.dragging && mouse.button === 0 && mouse.motion && !mouse.release && bounds) {
    selection.focus = screenToChatSelectionPoint(bounds, mouse.y, mouse.x);
    tui.requestRender();
    return true;
  }
  if (selection?.dragging && mouse.release) {
    selection.dragging = false;
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
