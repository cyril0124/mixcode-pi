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
import {
  canOpenCommandPalette,
  handleChatScrollKey,
  handleChromeMouseInput,
  handleCommandPaletteKey,
  handleExportChooserKey,
  handleMouseInput,
  handlePreviewKey,
  handleQuestionKey,
  handleQueuedFlushKey,
  handleQuitConfirmKey,
  handleShellKey,
  handleStreamingAbortKey,
  handleTabJumpKey,
  handleVimModeKey,
} from "./app-key-handlers.js";
import {
  closeAppOverlay,
  editTextWithTuiPaused,
  hasAnyOverlay,
  hasAppOverlay,
  showErrorOverlay,
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
  ShellKeyManager,
} from "./app-types.js";
import { handleExtensionManagerKey } from "./extension-manager.js";
import { renderCommandPalette, renderExportChooser, renderTabJumpOverlay } from "./rendering.js";
import { handleSessionSelectorKey } from "./session-selector.js";
export function handleMixCodeKeyInput(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  shellManager?: ShellKeyManager,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
  isEditorAutocompleteOpen: () => boolean = () => false,
  editorActions?: MixCodeEditorActions,
  commandPaletteActions?: CommandPaletteActions,
  exportChooserActions: ExportChooserActions = {},
): { consume?: boolean; data?: string } | undefined {
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId) ?? state.tabs[0];
  if (handleChromeMouseInput(state, active, data, tui)) {
    return { consume: true };
  }
  if (active && !hasAnyOverlay(tui)) {
    const extensionInput = runtime?.dispatchTerminalInput?.(active.sessionId, data);
    if (extensionInput?.consume) return { consume: true };
    if (extensionInput?.data !== undefined) data = extensionInput.data;
    if (data.length === 0) return { consume: true };
  }
  if (handleMouseInput(state, active, data, tui, shellManager)) {
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
  if (
    active?.pendingQuestions.length &&
    handleQuestionKey(state, active, data, tui, runtime, onStateChanged)
  ) {
    clearPendingEscape(active, "abort-agent");
    return { consume: true };
  }
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
    active &&
    matchesKey(data, "escape") &&
    !hasAnyOverlay(tui) &&
    handleStreamingAbortKey(active, tui, runtime)
  ) {
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
    active?.shellOpen &&
    !hasAnyOverlay(tui) &&
    !matchesKey(data, "ctrl+p") &&
    handleShellKey(active, data, shellManager)
  ) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
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
  if (active?.shellOpen && handleShellKey(active, data, shellManager)) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
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
  if (active?.shellOpen || active?.previewOpen || active?.pendingQuestions.length) return false;
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
      active?.shellOpen ||
      active?.previewOpen ||
      active?.pendingQuestions.length,
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
