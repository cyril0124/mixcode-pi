import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { MIXCODE_EXTENSION_KEYBINDINGS_MANAGER } from "../agent/runtime.js";
import { copyToClipboard } from "@earendil-works/pi-coding-agent";
import { parseSgrMouseInput } from "../core/mouse.js";
import {
  closeActiveOverlay,
  isOverlayActive,
  openCommandPalette,
  openTabJump,
} from "../core/overlays.js";
import { pushToast } from "../core/toast.js";
import { tabIsWaitingForInput } from "../core/tab-state.js";
import { activateTab, dismissExtensionPanel, getActiveTab, nextTabId } from "../core/tabs.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import { clearPendingEscape } from "../core/escape.js";
import { openQuitConfirm } from "./app-actions.js";
import { insertEditorText } from "./app-editor.js";
import { clipboardPasteForEditor } from "../core/pi-private.js";
import { pasteDetector } from "./paste-detect.js";
import {
  canOpenCommandPalette,
  handleChatScrollKey,
  handleChromeMouseInput,
  handleCloseAllSessionsConfirmKey,
  handleCommandPaletteKey,
  handleChatSelectionMouseInput,
  handleDeleteAllSessionsConfirmKey,
  handleInputSelectionMouseInput,
  handleMouseInput,
  handlePickerKey,
  handleQuitConfirmKey,
  handleSessionActionConfirmKey,
  handleTabJumpKey,
  handleVimModeKey,
  handleVimUserMessageNavigation,
  handleEscapeKey,
} from "./app-key-handlers.js";
import {
  closeAppOverlay,
  copyActiveNoticeText,
  hasAnyOverlay,
  hasAppOverlay,
  hasActiveNotice,
  showErrorOverlay,
  showLinesOverlay,
} from "./app-overlays.js";
import { handleSettingsPanelKey } from "./settings-panel.js";
import { activeExtensionCommands } from "./app-runtime.js";
import type {
  CommandPaletteActions,
  MixCodeEditorActions,
  MixCodeKeyRuntime,
  OverlayTui,
  WorkspaceKeyOptions,
} from "./app-types.js";
import { recordSubmittedHistory } from "../core/conversation-history.js";
import { EXTENSION_PANEL_MIN_TERMINAL_WIDTH } from "./rendering/chrome.js";
import { showSystemMessageOrToast } from "./app-actions.js";
import { handleSubmittedInput } from "./app-submit.js";
import { handleExtensionManagerKey } from "./extension-manager.js";
import { errorMessage } from "./app-overlays.js";
import { renderCommandPalette, renderTabJumpOverlay } from "./rendering.js";
import {
  handleVimTranscriptSearchPromptKey,
  handleVimTranscriptSearchRepeat,
  isVimTranscriptSearchOpenKey,
  openVimTranscriptSearch,
} from "./vim-transcript-search.js";
import { handleSessionSelectorKey } from "./session-selector.js";
import { handleForkSelectorKey } from "./fork-selector.js";
import {
  closeTreeSelector,
  handleTreeSelectorKey,
} from "./tree-selector.js";
import { handleWorkspaceOverlayKey } from "./workspace-overlay.js";
import type { MixCodeSubmitRuntime } from "./app-types.js";

type KeyResult = { consume?: boolean; data?: string } | undefined;
type ActiveTab = MixCodeState["tabs"][number];

/**
 * Temporary UI owns the input slot (login dialog, ctx.ui.custom / editor overlay).
 * Permanent setEditorComponent skins are NOT takeovers — they still use MixCode keys.
 */
export function isPendingEditorTakeover(
  active: ActiveTab | undefined,
  editorActions?: MixCodeEditorActions,
): boolean {
  if (editorActions?.hasInputComponent?.()) return true;
  return Boolean(active?.extensionUi.waitingForInputs.length);
}

/** Switch tabs and close Session Tree if it would steal keys on the destination. */
function activateTabClosingTree(
  state: MixCodeState,
  tui: OverlayTui,
  tabId: string,
): void {
  if (state.treeSelector.open && state.activeTabId !== tabId) {
    closeTreeSelector(state, tui);
  }
  activateTab(state, tabId);
}

// Empty-queue Ctrl+U arms enter-vim; confirm with u or second Ctrl+U in this window.
// 1s: releasing Ctrl then pressing u is slower than same-key double-tap.
const VIM_ENTER_ARM_WINDOW_MS = 1_000;

function isVimEnterConfirmKey(data: string): boolean {
  return matchesKey(data, "u") || matchesKey(data, "ctrl+u");
}

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
): KeyResult {
  const active = getActiveTab(state);
  if (isKeyRelease(data)) {
    // Pi input listeners receive raw releases; app controls do not.
    if (
      active &&
      state.activeTabId !== HOME_TAB_ID &&
      !hasAnyOverlay(tui) &&
      !active.extensionUi.waitingForInputs.length
    ) {
      runtime?.dispatchTerminalInput?.(active.sessionId, data);
    }
    return { consume: true };
  }
  pasteDetector.recordInput(data);
  // A non-editor input component (e.g. /login provider selector or login
  // dialog) owns the input area: forward keys to it and bypass all global
  // key handling, mirroring Pi agent's editorContainer takeover.
  if (editorActions?.hasInputComponent?.()) {
    editorActions.forwardToInputComponent?.(data);
    return { consume: true };
  }
  // Vim search temporarily owns the existing editor row. Special keys stay in
  // the global listener; ordinary editing keys fall through to EditorSlot.
  if (active?.vimTranscriptSearch?.promptOpen && editorActions && !parseSgrMouseInput(data)) {
    if (handleVimTranscriptSearchPromptKey(active, data, tui, editorActions)) {
      return { consume: true };
    }
    return undefined;
  }
  // Resolve empty-queue Ctrl+U → (u|Ctrl+U) enter-vim arm before other dispatch.
  if (active && active.vimEnterArmedAt !== undefined) {
    const armedAt = active.vimEnterArmedAt;
    active.vimEnterArmedAt = undefined;
    if (
      isVimEnterConfirmKey(data) &&
      state.activeTabId !== HOME_TAB_ID &&
      !active.vimMode &&
      !hasFocusedAppControl(state, active) &&
      !hasAnyOverlay(tui) &&
      Date.now() - armedAt <= VIM_ENTER_ARM_WINDOW_MS
    ) {
      active.vimMode = true;
      active.vimPendingEscapeAt = undefined;
      active.vimPendingHome = false;
      tui.requestRender();
      return { consume: true };
    }
  }
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
  // Tab while Session Tree is open switches agents (tree is global and would
  // otherwise swallow Tab as a no-op filter/nav key and block the new tab).
  if (
    state.treeSelector.open &&
    (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) &&
    !isEditorAutocompleteOpen()
  ) {
    if (active) clearPendingEscape(active);
    const nextId = nextTabId(state, matchesKey(data, "shift+tab") ? -1 : 1);
    activateTabClosingTree(state, tui, nextId);
    tui.requestRender();
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
    state.activeTabId !== HOME_TAB_ID &&
    !hasAppOverlay(tui) &&
    !hasFocusedAppControl(state, active)
  ) {
    runtime?.focusExtensionCustomOverlay?.(active.sessionId);
  }
  // Agent View table navigation on MixCode Home must run before per-session
  // extension terminal handlers because Home is not an agent input surface.
  const homeResult = handleHomeAgentViewKey(
    state,
    active,
    data,
    tui,
    runtime,
    onStateChanged,
    isEditorAutocompleteOpen,
    editorActions,
    workspaceOptions,
  );
  if (homeResult) return homeResult;
  if (!hasAnyOverlay(tui) && handleInputSelectionMouseInput(state, active, data, tui)) {
    return { consume: true };
  }
  // Modal overlays (pickers/settings/etc.) must swallow chat drag-select so
  // clipboard is not mutated under an open dialog. Notice remains selectable
  // via handleMouseInput's dedicated notice path.
  if (!hasAnyOverlay(tui) && handleChatSelectionMouseInput(state, active, data, tui, runtime)) {
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    !hasFocusedAppControl(state, active) &&
    !isEditorAutocompleteOpen() &&
    !active.extensionUi.waitingForInputs.length &&
    handleVimUserMessageNavigation(active, data, runtime)
  ) {
    clearPendingEscape(active);
    scheduleFloatingPanelExpiryRender(active, tui);
    tui.requestRender();
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    active.vimMode &&
    !hasAnyOverlay(tui) &&
    !hasFocusedAppControl(state, active) &&
    !isEditorAutocompleteOpen() &&
    !active.extensionUi.waitingForInputs.length
  ) {
    if (isVimTranscriptSearchOpenKey(data) && editorActions) {
      clearPendingEscape(active);
      if (openVimTranscriptSearch(active, editorActions)) {
        tui.requestRender();
        return { consume: true };
      }
    }
    if (handleVimTranscriptSearchRepeat(active, data, tui)) {
      clearPendingEscape(active);
      return { consume: true };
    }
  }
  // Route raw input to extension widget input listeners (e.g. pi-subagents'
  // belowEditor fleet list navigation). Suppressed while a modal extension
  // interaction is active: select/confirm/input dialogs replace the editor
  // without registering a tui overlay, so `hasAnyOverlay` is false for them —
  // without the pending-interaction guard a widget listener would steal the
  // dialog's arrow keys (e.g. Up/Down during `/agents`).
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    !active.extensionUi.waitingForInputs.length
  ) {
    const extensionInput = runtime?.dispatchTerminalInput?.(active.sessionId, data);
    if (extensionInput?.consume) return { consume: true };
    if (extensionInput?.data !== undefined) data = extensionInput.data;
    if (data.length === 0) return { consume: true };
  }
  if (handleMouseInput(state, active, data, tui, undefined, runtime)) {
    return { consume: true };
  }
  const overlayResult = handleModalOverlayKeys(
    state,
    active,
    data,
    tui,
    runtime,
    onStateChanged,
    commandPaletteActions,
  );
  if (overlayResult) return overlayResult;
  const agentNavResult = handleAgentSurfaceKeys(
    state,
    active,
    data,
    tui,
    runtime,
    isEditorAutocompleteOpen,
    editorActions,
    onStateChanged,
  );
  if (agentNavResult !== undefined) return agentNavResult;
  return handleEditorControlKeys(
    state,
    active,
    data,
    tui,
    runtime,
    isEditorAutocompleteOpen,
    editorActions,
  );
}

/** Home (Agent View) table nav + attach/submit. Returns undefined to fall through. */
function handleHomeAgentViewKey(
  state: MixCodeState,
  active: ActiveTab | undefined,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  isEditorAutocompleteOpen: () => boolean,
  editorActions: MixCodeEditorActions | undefined,
  workspaceOptions: WorkspaceKeyOptions,
): KeyResult {
  if (
    state.activeTabId !== HOME_TAB_ID ||
    hasAnyOverlay(tui) ||
    isEditorAutocompleteOpen() ||
    state.tabs.length === 0
  ) {
    return undefined;
  }
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
  // Ctrl+J is \n, which also matchesKey("enter") — do not treat it as Home submit.
  const isHomeEnter = matchesKey(data, "enter") && !matchesKey(data, "ctrl+j");
  if (!(matchesKey(data, "right") || isHomeEnter)) return undefined;
  const target = state.tabs[state.homeSelectedTabIndex];
  if (!target) return undefined;
  // Match Pi Editor / agent-tab submit: expand paste markers before send.
  const text =
    (editorActions?.getExpandedText?.() ?? editorActions?.getText() ?? "").trim();
  const hasText = text.length > 0;
  // Enter: send when non-empty after trim; never attach (Right is the only attach key).
  // Whitespace-only is a no-op (do not clear the buffer).
  if (isHomeEnter) {
    if (hasText && editorActions && runtime) {
      editorActions.setText("");
      // Match agent-tab onSubmit: in-memory Up-history + optional disk history.
      editorActions.addToHistory?.(text, target.sessionId);
      if (workspaceOptions.rootStateDir) {
        void recordSubmittedHistory({
          rootStateDir: workspaceOptions.rootStateDir,
          sessionId: target.sessionId,
          text,
        }).catch((error: unknown) => {
          // Same visibility as agent-tab history failures (system line or notice).
          showSystemMessageOrToast(
            state,
            runtime,
            tui,
            `History warning: ${errorMessage(error)}`,
          );
          tui.requestRender();
        });
      }
      // Do not change activeTabId: that swaps the main surface to the agent.
      // Pass workspaceFile + selected tab so Home matches agent-tab submit plumbing.
      void handleSubmittedInput(
        state,
        runtime as MixCodeSubmitRuntime,
        text,
        tui,
        onStateChanged,
        editorActions.setInputComponent && editorActions.clearInputComponent
          ? {
              setInputComponent: editorActions.setInputComponent,
              clearInputComponent: editorActions.clearInputComponent,
              requestRender: () => tui.requestRender(),
            }
          : undefined,
        workspaceOptions.workspaceFile,
        target,
        workspaceOptions.settingsDeps,
        { setText: (value) => editorActions.setText(value) },
      ).catch((error: unknown) => {
        editorActions.setText(text);
        showErrorOverlay(tui, error);
        tui.requestRender();
      });
    }
    tui.requestRender();
    return { consume: true };
  }
  // Right with text falls through so the editor can move the cursor.
  // Right with empty input attaches to the selected agent.
  if (!hasText) {
    activateTabClosingTree(state, tui, target.sessionId);
    tui.requestRender();
    return { consume: true };
  }
  return undefined;
}

/** Modal overlays, Ctrl+Q, Esc fallback, Notice copy keys. */
function handleModalOverlayKeys(
  state: MixCodeState,
  active: ActiveTab | undefined,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  onStateChanged: ((state: MixCodeState) => void | Promise<void>) | undefined,
  commandPaletteActions: CommandPaletteActions | undefined,
): KeyResult {
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
  if (state.settingsPanel.open && handleSettingsPanelKey(state, data, tui)) {
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
  if (state.sessionActionConfirm && handleSessionActionConfirmKey(state, data, tui, runtime, onStateChanged)) {
    return { consume: true };
  }
  if (state.quitConfirmOpen && handleQuitConfirmKey(state, data, tui, runtime)) {
    return { consume: true };
  }
  if (
    state.deleteAllSessionsConfirmOpen &&
    handleDeleteAllSessionsConfirmKey(state, data, tui, runtime, onStateChanged)
  ) {
    return { consume: true };
  }
  if (
    state.closeAllSessionsConfirmOpen &&
    handleCloseAllSessionsConfirmKey(state, data, tui, runtime, onStateChanged)
  ) {
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+q")) {
    if (active) clearPendingEscape(active);
    openQuitConfirm(state, tui);
    return { consume: true };
  }
  // Fallback: Esc dismisses app overlays that have no dedicated key handler
  // (error/text overlays, which render a close hint). Must stay
  // after the specific overlay handlers above (palette, tab-jump, quit-confirm,
  // selectors) so their own Esc semantics win first; handleEscapeKey skips
  // this case via its hasAnyOverlay guards.
  if (matchesKey(data, "escape") && hasAppOverlay(tui)) {
    closeAppOverlay(tui);
    closeActiveOverlay(state);
    return { consume: true };
  }
  // Notice is nonCapturing: copy keys must be handled here so they do not
  // fall through into the editor while a diagnostic panel is open.
  if (hasActiveNotice() && (data === "c" || data === "C" || data === "y" || data === "Y")) {
    void copyActiveNoticeText(copyToClipboard).then((result) => {
      if (!active) {
        tui.requestRender();
        return;
      }
      if ("error" in result) {
        pushToast(active, { type: "error", message: `Copy failed: ${result.error}` });
      } else {
        pushToast(active, { type: "success", message: `Copied ${result.chars} chars.` });
      }
      tui.requestRender();
    });
    return { consume: true };
  }
  return undefined;
}

/**
 * Agent-tab surface keys: empty Left/Right, shortcuts, history, zen/vim/tab, palette.
 * Returns undefined to fall through; returns explicit undefined from zen when Tab
 * must reach an extension-owned editor (caller must not continue dispatch).
 */
function handleAgentSurfaceKeys(
  state: MixCodeState,
  active: ActiveTab | undefined,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  isEditorAutocompleteOpen: () => boolean,
  editorActions: MixCodeEditorActions | undefined,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): KeyResult {
  // Right on empty input toggles the extension widget side panel. Mirrors the
  // Left-returns-Home guard so it never steals the editor's cursor-right when
  // there is text. Vim mode handles Right earlier as user-message navigation,
  // so this remains the non-Vim empty-input shortcut.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    matchesKey(data, "right") &&
    !hasAnyOverlay(tui) &&
    !isEditorAutocompleteOpen() &&
    !active.extensionUi.waitingForInputs.length &&
    editorActions &&
    editorActions.getText().length === 0
  ) {
    clearPendingEscape(active);
    toggleExtensionPanel(active, tui);
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    !hasFocusedAppControl(state, active) &&
    runtime?.dispatchExtensionShortcut?.(active.sessionId, data)
  ) {
    clearPendingEscape(active);
    tui.requestRender();
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !active.vimMode &&
    !hasAnyOverlay(tui) &&
    !hasFocusedAppControl(state, active) &&
    !isEditorAutocompleteOpen() &&
    !isPendingEditorTakeover(active, editorActions) &&
    editorActions?.browsePromptHistory?.(data)
  ) {
    clearPendingEscape(active);
    tui.requestRender();
    return { consume: true };
  }
  // Left on empty input returns to MixCode Home (Agent View).
  // Keep this before vim key handling so vim mode does not consume Left first.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    matchesKey(data, "left") &&
    !hasAnyOverlay(tui) &&
    !isEditorAutocompleteOpen() &&
    !active.extensionUi.waitingForInputs.length &&
    editorActions &&
    editorActions.getText().length === 0
  ) {
    clearPendingEscape(active);
    const tabIndex = state.tabs.findIndex((tab) => tab.sessionId === active.sessionId);
    if (tabIndex >= 0) state.homeSelectedTabIndex = tabIndex;
    activateTabClosingTree(state, tui, HOME_TAB_ID);
    tui.requestRender();
    return { consume: true };
  }
  // Zen blocks Tab/Shift+Tab agent switching (only Ctrl+T can change tabs).
  // Runs before vim tab-cycle: zen owns Tab even when vim coexists.
  // When an extension owns the editor, pass Tab through instead of swallowing.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    active.zenMode &&
    !isEditorAutocompleteOpen() &&
    !hasAppOverlay(tui) &&
    (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))
  ) {
    clearPendingEscape(active);
    if (isPendingEditorTakeover(active, editorActions)) {
      // Fall through to temporary extension UI — permanent skins still swallow Tab.
      return undefined;
    }
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    handleVimModeTabCycle(state, active, data, tui)
  ) {
    clearPendingEscape(active);
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    !isPendingEditorTakeover(active, editorActions) &&
    handleVimModeKey(active, data)
  ) {
    clearPendingEscape(active);
    tui.requestRender();
    return { consume: true };
  }
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER.matches(data, "app.tools.expand")
  ) {
    clearPendingEscape(active);
    active.extensionUi.toolsExpanded = !active.extensionUi.toolsExpanded;
    tui.requestRender();
    return { consume: true };
  }
  if (
    (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) &&
    !isEditorAutocompleteOpen() &&
    !hasAppOverlay(tui)
  ) {
    if (active) clearPendingEscape(active);
    activateTabClosingTree(state, tui, nextTabId(state, matchesKey(data, "shift+tab") ? -1 : 1));
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+t")) {
    if (active) clearPendingEscape(active);
    // Navigate installs a tree editor that falls through Ctrl+T; close it first
    // so Tab Jump is the only layer and Esc dismisses it (not the tree under it).
    if (state.treeSelector.open) closeTreeSelector(state, tui);
    openTabJump(state);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+p")) {
    if (active) clearPendingEscape(active);
    const extensionCommands = activeExtensionCommands(state, runtime);
    if (!canOpenCommandPalette(state, active, tui, isEditorAutocompleteOpen, extensionCommands))
      return undefined;
    openCommandPalette(state);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return { consume: true };
  }
  return undefined;
}

/** Chat scroll + editor shortcuts (newline, paste, clear, rename, dequeue). */
function handleEditorControlKeys(
  state: MixCodeState,
  active: ActiveTab | undefined,
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  isEditorAutocompleteOpen: () => boolean,
  editorActions: MixCodeEditorActions | undefined,
): KeyResult {
  // Pending extension interactions (e.g. /btw) may bind PgUp/PgDn for their own
  // history. Permanent setEditorComponent skins still scroll the main chat.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    active.extensionUi.waitingForInputs.length === 0 &&
    !shouldRouteLineBoundaryKeyToEditor(data, editorActions) &&
    handleChatScrollKey(active, data)
  ) {
    clearPendingEscape(active);
    tui.requestRender();
    return { consume: true };
  }
  // Temporary takeovers own newline keys (wrapper often no-ops setText).
  // Permanent skins still get MixCode newline insertion.
  if (matchesKey(data, "shift+enter") && editorActions && !isPendingEditorTakeover(active, editorActions)) {
    if (active) clearPendingEscape(active);
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
  // Pi CustomEditor: app.clipboard.pasteImage → temp image path (or text fallback).
  // Intercept before the editor so Ctrl+V is not a no-op on terminals without OS paste.
  if (
    MIXCODE_EXTENSION_KEYBINDINGS_MANAGER.matches(data, "app.clipboard.pasteImage") &&
    editorActions &&
    !isPendingEditorTakeover(active, editorActions)
  ) {
    if (active) clearPendingEscape(active);
    void clipboardPasteForEditor()
      .then((result) => {
        if (!result) return;
        if (result.kind === "image") {
          if (editorActions.insertTextAtCursor) editorActions.insertTextAtCursor(result.path);
          else editorActions.setText(`${editorActions.getText()}${result.path}`);
        } else if (editorActions.insertTextAtCursor) {
          editorActions.insertTextAtCursor(result.text);
        } else {
          editorActions.setText(`${editorActions.getText()}${result.text}`);
        }
        tui.requestRender();
      })
      .catch(() => {
        // Pi silently ignores clipboard errors (permissions, empty, etc.).
      });
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+c") && editorActions) {
    if (isPendingEditorTakeover(active, editorActions)) return undefined;
    if (active) clearPendingEscape(active);
    const text = editorActions.getText();
    // On Home (activeTabId=home) this is a no-op: addToHistory needs a real tab.
    // Intentional — Ctrl+C only clears; agent-tab history is per-session only.
    if (text.trim()) editorActions.addToHistory?.(text);
    editorActions.setText("");
    tui.requestRender();
    return { consume: true };
  }
  if (matchesKey(data, "ctrl+j") && editorActions && !isPendingEditorTakeover(active, editorActions)) {
    if (active) clearPendingEscape(active);
    insertEditorText(editorActions, "\n");
    tui.requestRender();
    return { consume: true };
  }
  // Pending interactions (e.g. /btw) may bind Ctrl+R as bring-to-main.
  // Permanent setEditorComponent skins still get MixCode /rename prefill.
  if (
    matchesKey(data, "ctrl+r") &&
    editorActions &&
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !isPendingEditorTakeover(active, editorActions)
  ) {
    clearPendingEscape(active);
    editorActions.setText(`/rename ${active.title}`);
    tui.requestRender();
    return { consume: true };
  }
  if ((matchesKey(data, "alt+up") || matchesKey(data, "ctrl+u")) && editorActions && active) {
    // Temporary takeovers own Ctrl+U; permanent skins still dequeue / enter-vim.
    if (state.activeTabId !== HOME_TAB_ID && isPendingEditorTakeover(active, editorActions)) {
      return undefined;
    }
    clearPendingEscape(active);
    // On Home, getActiveTab() is the selected agent — never dequeue that agent's queue here.
    if (state.activeTabId !== HOME_TAB_ID) {
      const text =
        runtime?.popPendingMessage?.(active.sessionId) ??
        active.pendingFollowUps.pop() ??
        active.pendingMessages.pop();
      if (text) {
        // Re-queue the in-progress draft so Ctrl+U (edit queued) does not discard it.
        // unshift keeps it ahead of the runtime-steering tail (see pendingMessages sync).
        // Draft re-queues into steer (local prefix), never into follow-up.
        const draft = editorActions.getText();
        if (draft.trim() && draft !== text) active.pendingMessages.unshift(draft);
        editorActions.setText(text);
        tui.requestRender();
      } else if (matchesKey(data, "ctrl+u") && !active.vimMode) {
        // Empty queue: arm Ctrl+U → u enter-vim (Alt+Up does not arm).
        active.vimEnterArmedAt = Date.now();
        // Toast, not meta row — avoids an orphan hint line under custom footers.
        // First Ctrl+U already consumed; confirm within the arm window.
        pushToast(active, { type: "info", message: "Again: u or Ctrl+U → vim" });
        tui.requestRender();
      }
    }
    // Always consume: empty queue / Home must not fall through to editor deleteToLineStart.
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
  // Temporary takeovers use Enter as confirm; paste protection must not steal it.
  // Permanent skins still get the default-editor paste-newline heuristic.
  if (isPendingEditorTakeover(active, editorActions)) return false;
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

function scheduleFloatingPanelExpiryRender(
  active: MixCodeState["tabs"][number],
  tui: OverlayTui,
): void {
  const expiresAt = active.floatingPanel?.expiresAt;
  if (!expiresAt) return;
  setTimeout(() => tui.requestRender(), Math.max(0, expiresAt - Date.now()) + 16);
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
  // vim transfer is centralized in activateTab.
  activateTabClosingTree(state, tui, next.sessionId);
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
  if (state.activeTabId === HOME_TAB_ID) return false;
  if (isEditorAutocompleteOpen() || hasAnyOverlay(tui)) return false;
  if (isOverlayActive(state)) return false;
  if (active && tabIsWaitingForInput(active)) return false;
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
    isOverlayActive(state) || (active !== undefined && tabIsWaitingForInput(active)),
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

/**
 * Toggle the extension widget side panel for the active tab. Opening is gated
 * on having at least one aboveEditor/belowEditor widget (no empty panel) and a
 * wide-enough terminal (otherwise a toast explains why nothing happened).
 * Closing always succeeds.
 */
function toggleExtensionPanel(active: MixCodeState["tabs"][number], tui: OverlayTui): void {
  if (active.panelOpen) {
    dismissExtensionPanel(active);
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
