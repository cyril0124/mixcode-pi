import { matchesKey } from "@earendil-works/pi-tui";
import { findModelRef } from "../core/models.js";
import {
  acceptPickerSelection,
  completeWorkdirPickerSelection,
  movePickerSelection,
  updatePickerQuery,
} from "../core/pickers.js";
import { setTheme } from "../core/theme-registry.js";
import type { MixCodeState } from "../core/types.js";
import { applyModelSelection, applyThinkingLevel, applyWorkdirSelection } from "./app-actions.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { renderPickerOverlay } from "./rendering.js";

export function handlePickerKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const picker = state.picker;
  if (!picker) return false;
  if (matchesKey(data, "escape")) {
    state.picker = undefined;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (picker.kind === "workdir" && matchesKey(data, "ctrl+u")) {
    updatePickerQuery(picker, "");
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    if (
      picker.kind === "workdir" &&
      matchesKey(data, "tab") &&
      completeWorkdirPickerSelection(picker)
    ) {
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      return true;
    }
    movePickerSelection(picker, matchesKey(data, "shift+tab") ? -1 : 1);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "enter")) {
    const selected = acceptPickerSelection(picker);
    if (!selected) return true;
    const finish = () => {
      state.picker = undefined;
      closeAppOverlay(tui);
      void onStateChanged?.(state);
      tui.requestRender();
    };
    try {
      const result = applyPickerSelection(state, selected.id, runtime);
      if (isPromiseLike(result)) {
        void result.then(finish).catch((error: unknown) => {
          showErrorOverlay(tui, error);
          tui.requestRender();
        });
      } else {
        finish();
      }
    } catch (error) {
      showErrorOverlay(tui, error);
      tui.requestRender();
    }
    return true;
  }
  if (matchesKey(data, "down")) {
    movePickerSelection(picker, 1);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "up")) {
    movePickerSelection(picker, -1);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (data === "\u007f") {
    updatePickerQuery(picker, picker.query.slice(0, -1));
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (/^[\x20-\x7e]$/.test(data)) {
    updatePickerQuery(picker, picker.query + data);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  return false;
}

function applyPickerSelection(
  state: MixCodeState,
  selectedId: string,
  runtime?: MixCodeKeyRuntime,
): void | Promise<void> {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (!state.picker) return;
  if (state.picker.kind === "models" && active) {
    const model = findModelRef(state.availableModels, selectedId);
    applyModelSelection(state, active, model, runtime);
  } else if (state.picker.kind === "thinking" && active) {
    applyThinkingLevel(state, active, selectedId, runtime);
  } else if (state.picker.kind === "theme") {
    setTheme(state, selectedId);
  } else if (state.picker.kind === "workdir" && active) {
    return applyWorkdirSelection(active, selectedId, runtime);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as PromiseLike<void>).then === "function"
  );
}
