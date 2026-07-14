import { matchesKey } from "@earendil-works/pi-tui";
import { applyContextLimit, parseContextLimitValue, adjustCompactionSettingsForLimit } from "../core/context-limit.js";
import { findModelRef } from "../core/models.js";
import {
  acceptPickerSelection,
  completeWorkdirPickerSelection,
  movePickerSelection,
  navigatePickerToParent,
  togglePickerHidden,
  updatePickerQuery,
} from "../core/pickers.js";
import { getActiveTab } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { applyModelSelection, applyThinkingLevel, applyWorkdirSelection } from "./app-actions.js";
import { closeAppOverlay, showErrorOverlay, showLinesOverlay } from "./app-overlays.js";
import type { MixCodeKeyRuntime, OverlayTui } from "./app-types.js";
import { renderPickerOverlay } from "./rendering.js";
import { setTheme } from "./themes.js";

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
    // In custom input mode, Esc goes back to the picker list
    if (picker.customInputMode) {
      picker.customInputMode = false;
      picker.customInputError = undefined;
      picker.query = "";
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      return true;
    }
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
  // Workdir picker: left arrow navigates to parent directory
  if (picker.kind === "workdir" && matchesKey(data, "left")) {
    if (navigatePickerToParent(picker)) {
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    }
    return true;
  }
  // Workdir picker: Ctrl+H toggles hidden directories
  if (picker.kind === "workdir" && matchesKey(data, "ctrl+h")) {
    togglePickerHidden(picker);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    if (picker.customInputMode) return true;
    if (
      picker.kind === "workdir" &&
      matchesKey(data, "tab") &&
      completeWorkdirPickerSelection(picker)
    ) {
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      return true;
    }
    if (picker.kind !== "workdir") {
      movePickerSelection(picker, matchesKey(data, "shift+tab") ? -1 : 1);
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    }
    return true;
  }
  if (matchesKey(data, "enter")) {
    // Context-limit picker: custom input mode
    if (picker.kind === "context-limit" && picker.customInputMode) {
      const value = parseContextLimitValue(picker.query);
      if (value === undefined) {
        picker.customInputError = "Invalid: enter a number (e.g. 32k, 40000)";
        showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
        return true;
      }
      const active = getActiveTab(state);
      if (active) {
        applyContextLimit(active, value);
        const runtimeTab = runtime?.getTab?.(active.sessionId);
        if (runtimeTab) {
          adjustCompactionSettingsForLimit(
            runtimeTab.agentSession.settingsManager,
            active.contextLimit,
            active.contextLimitOverridden ?? false,
          );
        }
      }
      state.picker = undefined;
      closeAppOverlay(tui);
      void onStateChanged?.(state);
      tui.requestRender();
      return true;
    }

    // For workdir picker: Enter confirms the current browsing directory as the new workdir.
    // Exception: if the selected item is a custom path (no completeValue), use that instead.
    let selectedId: string;
    if (picker.kind === "workdir") {
      const selected = acceptPickerSelection(picker);
      if (selected && !selected.completeValue) {
        // Custom path entry — use its resolved id
        selectedId = selected.id;
      } else {
        // Normal case: confirm the current browsing directory
        selectedId = picker.browsingDir ?? picker.workdirBase ?? process.cwd();
      }
    } else {
      const selected = acceptPickerSelection(picker);
      if (!selected) return true;
      selectedId = selected.id;
    }

    // Context-limit picker: "custom" item selected → enter custom input mode
    if (picker.kind === "context-limit" && selectedId === "custom") {
      picker.customInputMode = true;
      picker.customInputError = undefined;
      picker.query = "";
      showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
      return true;
    }

    const finish = () => {
      state.picker = undefined;
      closeAppOverlay(tui);
      void onStateChanged?.(state);
      tui.requestRender();
    };
    try {
      const result = applyPickerSelection(state, selectedId, runtime);
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
    if (picker.customInputMode) return true;
    movePickerSelection(picker, 1);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "up")) {
    if (picker.customInputMode) return true;
    movePickerSelection(picker, -1);
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (data === "\u007f") {
    updatePickerQuery(picker, picker.query.slice(0, -1));
    if (picker.customInputMode) picker.customInputError = undefined;
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    updatePickerQuery(picker, picker.query + data);
    if (picker.customInputMode) picker.customInputError = undefined;
    showLinesOverlay(tui, (width) => renderPickerOverlay(state, width));
    return true;
  }
  // Modal: swallow unbound keys so they cannot fall through.
  return true;
}

function applyPickerSelection(
  state: MixCodeState,
  selectedId: string,
  runtime?: MixCodeKeyRuntime,
): void | Promise<void> {
  const active = getActiveTab(state);
  if (!state.picker) return;
  if (state.picker.kind === "models" && active) {
    const model = findModelRef(state.availableModels, selectedId);
    return applyModelSelection(state, active, model, runtime);
  } else if (state.picker.kind === "thinking" && active) {
    applyThinkingLevel(state, active, selectedId, runtime);
  } else if (state.picker.kind === "theme") {
    setTheme(state, selectedId);
  } else if (state.picker.kind === "context-limit" && active) {
    // "reset" item or a numeric preset
    const value = selectedId === "reset" ? "reset" as const : parseInt(selectedId, 10);
    if (value === "reset" || (typeof value === "number" && value > 0)) {
      applyContextLimit(active, value);
      const runtimeTab = runtime?.getTab?.(active.sessionId);
      if (runtimeTab) {
        adjustCompactionSettingsForLimit(
          runtimeTab.agentSession.settingsManager,
          active.contextLimit,
          active.contextLimitOverridden ?? false,
        );
      }
    }
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
