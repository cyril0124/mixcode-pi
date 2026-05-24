import { matchesKey } from "@earendil-works/pi-tui";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../agent/runtime.js";
import {
  closeCommandPalette,
  closeTabJump,
  openCommandPalette,
  openTabJump,
} from "../core/overlays.js";
import { activateTab, nextTabId } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { clearPendingEscape, openQuitConfirm } from "./app-actions.js";
import { insertEditorText } from "./app-editor.js";
import { pasteDetector } from "./paste-detect.js";
import {
  canOpenCommandPalette,
  handleChatScrollKey,
  handleChromeMouseInput,
  handleCommandPaletteKey,
  handleExportChooserKey,
  handleChatSelectionMouseInput,
  handleMouseInput,
  handlePreviewKey,
  handleQuestionKey,
  handleQueuedFlushKey,
  handleQuitConfirmKey,
  handleStreamingAbortKey,
  handleTabJumpKey,
  handleVimModeKey,
} from "./app-key-handlers.js";
import {
  closeAppOverlay,
  hasAnyOverlay,
  hasAppOverlay,
  showLinesOverlay,
} from "./app-overlays.js";
import { handlePickerKey } from "./app-picker-keys.js";
import { activeExtensionCommands } from "./app-runtime.js";
import type {
  CommandPaletteActions,
  ExportChooserActions,
  MixCodeEditorActions,
  MixCodeKeyRuntime,
  OverlayTui,
  WorkspaceKeyOptions,
} from "./app-types.js";
import { handleExtensionManagerKey } from "./extension-manager.js";
import { renderCommandPalette, renderExportChooser, renderTabJumpOverlay } from "./rendering.js";
import { handleSessionSelectorKey } from "./session-selector.js";
import { handleTreeSelectorKey, openTreeSelector, type TreeSelectorRuntime } from "./tree-selector.js";
import { handleWorkspaceOverlayKey } from "./workspace-overlay.js";
export function handleMixCodeKeyInput(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  _shellManager?: unknown,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  isEditorAutocompleteOpen: () => boolean = () => false,
  editorActions?: MixCodeEditorActions,
  commandPaletteActions?: CommandPaletteActions,
  exportChooserActions: ExportChooserActions = {},
  workspaceOptions: WorkspaceKeyOptions = {},
): { consume?: boolean; data?: string } | undefined {
  pasteDetector.recordInput(data);
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (state.workspaceOverlay.open) {
    if (
      handleWorkspaceOverlayKey(
        state,
        data,
        tui,
        runtime,
        onStateChanged,
        workspaceOptions.workspaceFile,
      )
    ) {
      return { consume: true };
    }
  }
  if (handleChromeMouseInput(state, active, data, tui)) {
    return { consume: true };
  }
  if (state.treeSelector.open) {
    if (handleTreeSelectorKey(state, data, tui, runtime, onStateChanged)) {
      return { consume: true };
    }
  }
  // Escape-owned app interrupts must run before extension terminal handlers,
  // otherwise broad terminal handlers can consume Esc and make abort unreachable.
  if (
    active &&
    state.activeTabId !== "config" &&
    matchesKey(data, "escape") &&
    runtime?.hasExtensionCustomOverlay?.(active.sessionId)
  ) {
    clearPendingEscape(active, "abort-agent");
    runtime.focusExtensionCustomOverlay?.(active.sessionId);
    return undefined;
  }
  if (active && handleQueuedFlushKey(state, active, data, tui, runtime, isEditorAutocompleteOpen)) {
    return { consume: true };
  }
  if (
    active?.pendingDialogs.length &&
    handleQuestionKey(state, active, data, tui, runtime, onStateChanged)
  ) {
    clearPendingEscape(active, "abort-agent");
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    matchesKey(data, "escape") &&
    !hasAnyOverlay(tui) &&
    handleStreamingAbortKey(active, tui, runtime)
  ) {
    return { consume: true };
  }
  // Agent View table navigation on MixCode Home must run before per-session
  // extension terminal handlers because Home is not an agent input surface.
  if (state.activeTabId === "config" && !hasAnyOverlay(tui) && state.tabs.length > 0) {
    if (matchesKey(data, "up")) {
      state.homeSelectedTabIndex =
        (state.homeSelectedTabIndex - 1 + state.tabs.length) % state.tabs.length;
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "down")) {
      state.homeSelectedTabIndex = (state.homeSelectedTabIndex + 1) % state.tabs.length;
      tui.requestRender();
      return { consume: true };
    }
    if (matchesKey(data, "right") || matchesKey(data, "enter")) {
      const target = state.tabs[state.homeSelectedTabIndex];
      if (target) {
        transferVimModeForHomeAttach(state, target);
        activateTab(state, target.sessionId);
        tui.requestRender();
        return { consume: true };
      }
    }
  }
  if (handleChatSelectionMouseInput(state, active, data, tui, runtime)) {
    return { consume: true };
  }
  if (active && state.activeTabId !== "config" && !hasAnyOverlay(tui)) {
    const extensionInput = runtime?.dispatchTerminalInput?.(active.sessionId, data);
    if (extensionInput?.consume) return { consume: true };
    if (extensionInput?.data !== undefined) data = extensionInput.data;
    if (data.length === 0) return { consume: true };
  }
  if (handleMouseInput(state, active, data, tui, undefined, runtime)) {
    return { consume: true };
  }
  if (state.picker && handlePickerKey(state, data, tui, runtime, onStateChanged)) {
    return { consume: true };
  }
  if (
    state.sessionSelector.open &&
    handleSessionSelectorKey(state, data, tui, runtime, onStateChanged)
  ) {
    return { consume: true };
  }
  if (
    state.commandPaletteOpen &&
    handleCommandPaletteKey(state, data, tui, commandPaletteActions)
  ) {
    return { consume: true };
  }
  if (
    state.extensionManager.open &&
    handleExtensionManagerKey(state, data, tui, runtime, onStateChanged)
  ) {
    return { consume: true };
  }
  if (state.tabJumpOpen && handleTabJumpKey(state, data, tui)) {
    return { consume: true };
  }
  if (state.quitConfirmOpen && handleQuitConfirmKey(state, data, tui, runtime)) {
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+q")) {
    if (active) clearPendingEscape(active, "abort-agent");
    openQuitConfirm(state, tui);
    return { consume: true };
  }
  if (matchesKey(data, "escape") && hasAppOverlay(tui)) {
    closeAppOverlay(tui);
    state.exportChooserOpen = false;
    state.exportChooserIndex = 0;
    state.quitConfirmOpen = false;
    state.extensionManager.open = false;
    closeCommandPalette(state);
    closeTabJump(state);
    state.picker = undefined;
    state.workspaceOverlay.open = false;
    return { consume: true };
  }

  // Double-escape with empty editor opens tree selector (mirrors pi agent behavior)
  if (
    active &&
    state.activeTabId !== "config" &&
    matchesKey(data, "escape") &&
    !hasAnyOverlay(tui) &&
    !state.exportChooserOpen &&
    !state.commandPaletteOpen &&
    !active.previewOpen &&
    !active.pendingDialogs.length &&
    !editorActions?.getText()?.trim()
  ) {
    const now = Date.now();
    if (active.lastEscapeTime && now - active.lastEscapeTime < 500) {
      active.lastEscapeTime = undefined;
      openTreeSelector(state, runtime as unknown as TreeSelectorRuntime, tui, active.sessionId);
      tui.requestRender();
      return { consume: true };
    }
    active.lastEscapeTime = now;
    tui.requestRender();
    return { consume: true };
  }

  if (
    state.exportChooserOpen &&
    handleExportChooserKey(state, data, tui, runtime, exportChooserActions)
  ) {
    if (active) clearPendingEscape(active, "abort-agent");
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    !hasFocusedAppControl(state, active) &&
    runtime?.dispatchExtensionShortcut?.(active.sessionId, data)
  ) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    return { consume: true };
  }
  // Left on empty input returns to MixCode Home (Agent View), including vim mode.
  // Keep this before vim key handling so vim mode does not consume Left first.
  if (
    active &&
    state.activeTabId !== "config" &&
    matchesKey(data, "left") &&
    !hasAnyOverlay(tui) &&
    !isEditorAutocompleteOpen() &&
    !active.previewOpen &&
    !active.pendingDialogs.length &&
    editorActions &&
    editorActions.getText().length === 0
  ) {
    clearPendingEscape(active, "abort-agent");
    const tabIndex = state.tabs.findIndex((tab) => tab.sessionId === active.sessionId);
    if (tabIndex >= 0) state.homeSelectedTabIndex = tabIndex;
    activateTab(state, "config");
    tui.requestRender();
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    handleVimModeTabCycle(state, active, data, tui)
  ) {
    clearPendingEscape(active, "abort-agent");
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    handleVimModeKey(active, data)
  ) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER.matches(data, "app.tools.expand")
  ) {
    clearPendingEscape(active, "abort-agent");
    active.extensionUi.toolsExpanded = !active.extensionUi.toolsExpanded;
    tui.requestRender();
    return { consume: true };
  }
  if (active?.previewOpen && handlePreviewKey(active, data)) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    return { consume: true };
  }
  if (
    (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) &&
    !isEditorAutocompleteOpen() &&
    !hasAppOverlay(tui)
  ) {
    if (active) clearPendingEscape(active, "abort-agent");
    activateTab(state, nextTabId(state, matchesKey(data, "shift+tab") ? -1 : 1));
    tui.requestRender();
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    runtime?.hasExtensionCustomOverlay?.(active.sessionId)
  ) {
    runtime.focusExtensionCustomOverlay?.(active.sessionId);
    return undefined;
  }
  if (matchesKey(data, "ctrl+t")) {
    if (active) clearPendingEscape(active, "abort-agent");
    openTabJump(state);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+p")) {
    if (active) clearPendingEscape(active, "abort-agent");
    const extensionCommands = activeExtensionCommands(state, runtime);
    if (!canOpenCommandPalette(state, active, tui, isEditorAutocompleteOpen, extensionCommands))
      return undefined;
    openCommandPalette(state);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+l")) {
    if (active) clearPendingEscape(active, "abort-agent");
    state.exportChooserOpen = true;
    state.exportChooserIndex = 0;
    showLinesOverlay(tui, (width) => renderExportChooser(state, width));
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    !shouldRouteLineBoundaryKeyToEditor(data, editorActions) &&
    handleChatScrollKey(active, data)
  ) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, "shift+enter") && editorActions) {
    if (active) clearPendingEscape(active, "abort-agent");
    insertEditorText(editorActions, "\n");
    tui.requestRender();
    return { consume: true };
  }
  if (handlePasteNewline(data, editorActions, tui, active)) {
    return { consume: true };
  }
  if (handleBatchedSubmitInput(state, active, data, tui, isEditorAutocompleteOpen, editorActions)) {
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+c") && editorActions) {
    if (active) clearPendingEscape(active, "abort-agent");
    const text = editorActions.getText();
    if (text.trim()) editorActions.addToHistory?.(text);
    editorActions.setText("");
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+j") && editorActions) {
    if (active) clearPendingEscape(active, "abort-agent");
    insertEditorText(editorActions, "\n");
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+r") && editorActions && active && state.activeTabId !== "config") {
    clearPendingEscape(active, "abort-agent");
    editorActions.setText(`/rename ${active.title}`);
    tui.requestRender();
    return { consume: true };
  }
  if ((matchesKey(data, "alt+up") || matchesKey(data, "ctrl+u")) && editorActions && active) {
    clearPendingEscape(active, "abort-agent");
    const text = runtime?.popPendingMessage?.(active.sessionId) ?? active.pendingMessages.pop();
    if (!text) return undefined;
    editorActions.setText(text);
    tui.requestRender();
    return { consume: true };
  }
  return undefined;
}

/**
 * Intercept Enter (\r) during rapid input (paste without bracketed paste markers)
 * and insert a newline instead of letting the editor submit.
 */
function handlePasteNewline(
  data: string,
  editorActions: MixCodeEditorActions | undefined,
  tui: OverlayTui,
  active: MixCodeState["tabs"][number] | undefined,
): boolean {
  if (!editorActions) return false;
  if (!pasteDetector.isLikelyPaste()) return false;
  if (active?.vimMode) return false;
  const text = pasteNewlineText(data);
  if (text === undefined) return false;
  insertEditorText(editorActions, text);
  tui.requestRender();
  return true;
}

function pasteNewlineText(data: string): string | undefined {
  if (data === "\r" || data === "\n") return "\n";
  const text = inlineSubmitText(data);
  if (text === undefined) return undefined;
  return `${text}\n`;
}

function transferVimModeForHomeAttach(
  state: MixCodeState,
  target: MixCodeState["tabs"][number],
): void {
  const source = state.tabs.find((tab) => tab.vimMode);
  if (!source || source.sessionId === target.sessionId) return;
  source.vimMode = false;
  source.vimPendingEscapeAt = undefined;
  source.vimPendingHome = false;
  target.vimMode = true;
  target.vimPendingEscapeAt = undefined;
  target.vimPendingHome = false;
}

function handleVimModeTabCycle(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  data: string,
  tui: OverlayTui,
): boolean {
  if (!active.vimMode) return false;
  if (!matchesKey(data, "tab") && !matchesKey(data, "shift+tab")) return false;
  const currentIndex = state.tabs.findIndex((tab) => tab.sessionId === active.sessionId);
  if (currentIndex < 0 || state.tabs.length === 0) return false;
  const delta = matchesKey(data, "shift+tab") ? -1 : 1;
  const nextIndex = (currentIndex + delta + state.tabs.length) % state.tabs.length;
  const next = state.tabs[nextIndex]!;
  active.vimMode = false;
  active.vimPendingEscapeAt = undefined;
  active.vimPendingHome = false;
  next.vimMode = true;
  next.vimPendingEscapeAt = undefined;
  next.vimPendingHome = false;
  activateTab(state, next.sessionId);
  tui.requestRender();
  return true;
}

function handleBatchedSubmitInput(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  data: string,
  tui: OverlayTui,
  isEditorAutocompleteOpen: () => boolean,
  editorActions?: MixCodeEditorActions,
): boolean {
  const text = inlineSubmitText(data);
  if (text === undefined) return false;
  if (!editorActions?.submitCurrentText) return false;
  if (state.activeTabId === "config") return false;
  if (isEditorAutocompleteOpen() || hasAnyOverlay(tui)) return false;
  if (
    state.picker ||
    state.sessionSelector.open ||
    state.commandPaletteOpen ||
    state.tabJumpOpen ||
    state.quitConfirmOpen ||
    state.exportChooserOpen
  )
    return false;
  if (active?.previewOpen || active?.pendingDialogs.length) return false;
  insertEditorText(editorActions, text);
  editorActions.submitCurrentText();
  tui.requestRender();
  return true;
}

function hasFocusedAppControl(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
): boolean {
  return Boolean(
    state.picker ||
      state.sessionSelector.open ||
      state.commandPaletteOpen ||
      state.tabJumpOpen ||
      state.quitConfirmOpen ||
      state.exportChooserOpen ||
      active?.previewOpen ||
      active?.pendingDialogs.length,
  );
}

function shouldRouteLineBoundaryKeyToEditor(
  data: string,
  editorActions: MixCodeEditorActions | undefined,
): boolean {
  return Boolean(editorActions && (matchesKey(data, "home") || matchesKey(data, "end")));
}

function inlineSubmitText(data: string): string | undefined {
  if (!(data.endsWith("\r") || data.endsWith("\n"))) return undefined;
  const body = data.slice(0, -1);
  if (!body || body.includes("\r") || body.includes("\n") || body.includes("\x1b"))
    return undefined;
  for (const char of body) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return undefined;
  }
  return body;
}
