import { hitMouseRegion, parseSgrMouseInput } from "../core/mouse.js";
import { scrollChat, scrollPreview, scrollShell } from "../core/overlays.js";
import { createPicker } from "../core/pickers.js";
import { activateTab } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { hasAnyOverlay, showLinesOverlay } from "./app-overlays.js";
import { activeExtensionCommands } from "./app-runtime.js";
import type { OverlayTui, ShellKeyManager } from "./app-types.js";
import { renderCommandPalette, renderPickerOverlay, tabBarHitRegions } from "./rendering.js";

export function handleMouseInput(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
  shellManager?: ShellKeyManager,
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
  if (hasAnyOverlay(tui)) return false;
  if (active.shellOpen) {
    if (active.shellSession?.sgrMouse || (mouse.wheel && active.shellSession?.alternateScreen)) {
      const forwarded = shellManager?.writeMouse?.(active, mouse) ?? false;
      if (forwarded) {
        tui.requestRender();
        return true;
      }
    }
    if (mouse.wheel && scrollShell(active, mouse.wheel === "up" ? -3 : 3)) {
      tui.requestRender();
      return true;
    }
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
  if (state.activeTabId === "config" && mouse.button === 0 && !mouse.release && !mouse.wheel) {
    const action = state.configActionHitRegions?.find(
      (region) => region.row === mouse.y && mouse.x >= region.startX && mouse.x <= region.endX,
    )?.action;
    if (!action) return false;
    if (action === "theme") {
      state.picker = createPicker(action, state, active);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      tui.requestRender();
      return true;
    }
    const commands: Record<
      NonNullable<MixCodeState["configActionHitRegions"]>[number]["action"],
      string
    > = {
      "new-session": "/new-session",
      theme: "/theme",
      "save-workspace": "/save-workspace",
      "restore-workspace": "/restore-workspace",
      "delete-workspace": "/delete-workspace",
    };
    state.commandPaletteOpen = true;
    state.commandPalette.query = commands[action];
    state.commandPalette.selectedIndex = 0;
    showLinesOverlay(tui, (width) =>
      renderCommandPalette(state, width, activeExtensionCommands(state, undefined)),
    );
    tui.requestRender();
    return true;
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

function tabBarMouseRow(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
): number {
  return state.tabBarHitRow ?? 1 + (active?.extensionUi?.header?.lines.length ?? 0);
}
