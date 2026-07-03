import { Key, matchesKey } from "@earendil-works/pi-tui";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../agent/runtime.js";
import {
  closeActiveOverlay,
  isOverlayActive,
  openCommandPalette,
  openTabJump,
  scrollChat,
} from "../core/overlays.js";
import { buildModelPrompt } from "../core/prompt-build.js";
import { pushToast } from "../core/toast.js";
import { getKnownSkillsFromTab, getPromptTemplatesFromTab } from "./app-submit.js";
import { activateTab, getActiveTab, nextTabId } from "../core/tabs.js";
import type { MixCodeState } from "../core/types.js";
import { clearPendingEscape, openQuitConfirm } from "./app-actions.js";
import { insertEditorText } from "./app-editor.js";
import { pasteDetector } from "./paste-detect.js";
import {
  canOpenCommandPalette,
  handleChatScrollKey,
  handleChromeMouseInput,
  handleCommandPaletteKey,
  handleChatSelectionMouseInput,
  handleInputSelectionMouseInput,
  handleMouseInput,
  handlePreviewKey,
  handleQuitConfirmKey,
  handleTabJumpKey,
  handleVimModeKey,
  handleEscapeKey,
} from "./app-key-handlers.js";
import {
  closeAppOverlay,
  hasAnyOverlay,
  hasAppOverlay,
  showErrorOverlay,
  showLinesOverlay,
} from "./app-overlays.js";
import { handlePickerKey } from "./app-picker-keys.js";
import { activeExtensionCommands } from "./app-runtime.js";
import type {
  CommandPaletteActions,
  MixCodeEditorActions,
  MixCodeKeyRuntime,
  OverlayTui,
  WorkspaceKeyOptions,
} from "./app-types.js";
import { handleExtensionManagerKey } from "./extension-manager.js";
import { renderCommandPalette, renderTabJumpOverlay } from "./rendering.js";
import { handleSessionSelectorKey } from "./session-selector.js";
import { handleForkSelectorKey } from "./fork-selector.js";
import { handleTreeSelectorKey, type TreeSelectorRuntime } from "./tree-selector.js";
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
  workspaceOptions: WorkspaceKeyOptions = {},
): { consume?: boolean; data?: string } | undefined {
  pasteDetector.recordInput(data);
  const active = getActiveTab(state);
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
  if (state.forkSelector.open) {
    if (handleForkSelectorKey(state, data, tui, runtime)) {
      return { consume: true };
    }
  }
  // Unified escape-key dispatch (extension overlay, queued flush, abort, double-Esc tree/fork)
  if (matchesKey(data, "escape")) {
    const result = handleEscapeKey(state, active, tui, runtime, editorActions, isEditorAutocompleteOpen, onStateChanged);
    if (result) return result;
  }
  // An extension custom overlay shown while its tab was inactive never
  // captured focus: pi-tui's showOverlay only focuses overlays visible at
  // show time, and MixCode scopes overlay visibility to the owning tab.
  // Restore focus lazily before dispatch so this same key already reaches
  // the overlay after switching back. Guarded so app overlays and modal
  // app controls (palette, pickers, quit confirm, ...) keep focus priority;
  // focusExtensionCustomOverlay itself no-ops when there is no overlay or
  // it is already focused.
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAppOverlay(tui) &&
    !hasFocusedAppControl(state, active)
  ) {
    runtime?.focusExtensionCustomOverlay?.(active.sessionId);
  }
  // Agent View table navigation on MixCode Home must run before per-session
  // extension terminal handlers because Home is not an agent input surface.
  if (
    state.activeTabId === "config" &&
    !hasAnyOverlay(tui) &&
    !isEditorAutocompleteOpen() &&
    state.tabs.length > 0
  ) {
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
        // If editor has text, send message to selected agent; otherwise attach.
        if (matchesKey(data, "enter") && editorActions && editorActions.getText().length > 0) {
          const text = editorActions.getText().trim();
          editorActions.setText("");
          if (text && runtime?.prompt) {
            const knownSkills = getKnownSkillsFromTab(runtime, target.sessionId);
            const promptTemplates = getPromptTemplatesFromTab(runtime, target.sessionId);
            void buildModelPrompt(text, target.workdir, { knownSkills, promptTemplates })
              .then((built) => runtime.prompt!(target.sessionId, built))
              .catch((error: unknown) => {
                editorActions.setText(text);
                showErrorOverlay(tui, error);
                tui.requestRender();
              });
          }
          tui.requestRender();
          return { consume: true };
        }
        transferVimModeForHomeAttach(state, target);
        activateTab(state, target.sessionId);
        tui.requestRender();
        return { consume: true };
      }
    }
  }
  if (!hasAnyOverlay(tui) && handleInputSelectionMouseInput(state, active, data, tui)) {
    return { consume: true };
  }
  if (handleChatSelectionMouseInput(state, active, data, tui, runtime)) {
    return { consume: true };
  }
  // Route raw input to extension widget input listeners (e.g. pi-subagents'
  // belowEditor fleet list navigation). Suppressed while a modal extension
  // interaction is active: select/confirm/input dialogs replace the editor
  // without registering a tui overlay, so `hasAnyOverlay` is false for them —
  // without the pending-interaction guard a widget listener would steal the
  // dialog's arrow keys (e.g. Up/Down during `/agents`).
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    !active.extensionUi.pendingUserInteractions.length
  ) {
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
  // Fallback: Esc dismisses app overlays that have no dedicated key handler
  // (error/text overlays, which render an "Esc to close" hint). Must stay
  // after the specific overlay handlers above (palette, tab-jump, quit-confirm,
  // selectors) so their own Esc semantics win first; handleEscapeKey skips
  // this case via its hasAnyOverlay guards.
  if (matchesKey(data, "escape") && hasAppOverlay(tui)) {
    closeAppOverlay(tui);
    closeActiveOverlay(state);
    return { consume: true };
  }

  // Right on empty input toggles the extension widget side panel. Mirrors the
  // Left-returns-Home guard so it never steals the editor's cursor-right when
  // there is text. Kept before extension/vim handling so it remains a built-in
  // empty-input shortcut.
  if (
    active &&
    state.activeTabId !== "config" &&
    matchesKey(data, "right") &&
    !hasAnyOverlay(tui) &&
    !isEditorAutocompleteOpen() &&
    !active.previewOpen &&
    !active.pendingDialogs.length &&
    !active.extensionUi.pendingUserInteractions.length &&
    editorActions &&
    editorActions.getText().length === 0
  ) {
    clearPendingEscape(active, "abort-agent");
    toggleExtensionPanel(active, tui);
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
    !active.vimMode &&
    !hasAnyOverlay(tui) &&
    !hasFocusedAppControl(state, active) &&
    !isEditorAutocompleteOpen() &&
    editorActions?.browsePromptHistory?.(data)
  ) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    return { consume: true };
  }
  // Left on empty input returns to MixCode Home (Agent View).
  // Keep this before vim key handling so vim mode does not consume Left first.
  if (
    active &&
    state.activeTabId !== "config" &&
    matchesKey(data, "left") &&
    !hasAnyOverlay(tui) &&
    !isEditorAutocompleteOpen() &&
    !active.previewOpen &&
    !active.pendingDialogs.length &&
    !active.extensionUi.pendingUserInteractions.length &&
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
    active.extensionUi.pendingUserInteractions.length > 0 &&
    handleExtensionInteractionChatScrollKey(active, data)
  ) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    return { consume: true };
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
  if (isOverlayActive(state)) return false;
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
    isOverlayActive(state) || active?.previewOpen || active?.pendingDialogs.length,
  );
}

function handleExtensionInteractionChatScrollKey(
  active: MixCodeState["tabs"][number],
  data: string,
): boolean {
  if (matchesKey(data, Key.shift("up"))) return scrollChat(active, 3);
  if (matchesKey(data, Key.shift("down"))) return scrollChat(active, -3);
  return false;
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

// Minimum terminal width before the side panel may open. Below this a split
// would crush the chat column, so we toast instead. Mirrors the
// extension-manager two-pane threshold for consistency.
export const EXTENSION_PANEL_MIN_TERMINAL_WIDTH = 80;

/**
 * Toggle the extension widget side panel for the active tab. Opening is gated
 * on having at least one aboveEditor/belowEditor widget (no empty panel) and a
 * wide-enough terminal (otherwise a toast explains why nothing happened).
 * Closing always succeeds.
 */
function toggleExtensionPanel(active: MixCodeState["tabs"][number], tui: OverlayTui): void {
  if (active.panelOpen) {
    active.panelOpen = false;
    active.panelSelection = undefined;
    active.panelScrollOffset = 0;
    tui.requestRender();
    return;
  }
  const hasWidgets = active.extensionUi.widgets.some(
    (widget) => widget.placement === "aboveEditor" || widget.placement === "belowEditor",
  );
  if (!hasWidgets) {
    pushToast(active, { type: "info", message: "No extension widgets to show." });
    tui.requestRender();
    return;
  }
  const columns = process.stdout.columns || 0;
  if (columns > 0 && columns < EXTENSION_PANEL_MIN_TERMINAL_WIDTH) {
    pushToast(active, {
      type: "warning",
      message: `Terminal too narrow for the widget panel (need ${EXTENSION_PANEL_MIN_TERMINAL_WIDTH} cols).`,
    });
    tui.requestRender();
    return;
  }
  active.panelOpen = true;
  active.panelScrollOffset = 0;
  tui.requestRender();
}
