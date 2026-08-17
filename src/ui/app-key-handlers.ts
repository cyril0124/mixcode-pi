import { matchesKey, type TUI as TuiType } from "@earendil-works/pi-tui";
import type { RuntimeTab } from "../agent/runtime.js";
import {
  applyContextLimit,
  applyContextLimitToSession,
  parseContextLimitValue,
} from "../core/context-limit.js";
import { findModelRef } from "../core/models.js";
import {
  acceptCommandPaletteSelection,
  acceptTabJumpSelection,
  chatEnd,
  chatHome,
  closeCommandPalette,
  closeTabJump,
  commandPaletteEntriesWithExtensions,
  selectableCommandPaletteEntries,
  moveCommandPaletteSelection,
  moveTabJumpSelection,
  scrollChat,
  toggleTabJumpNonIdleOnly,
  updateCommandPaletteQueryWithExtensions,
  updateTabJumpQuery,
} from "../core/overlays.js";
import {
  acceptPickerSelection,
  completeWorkdirPickerSelection,
  movePickerSelection,
  navigatePickerToParent,
  togglePickerHidden,
  updatePickerQuery,
} from "../core/pickers.js";
import { HOME_TAB_ID, type MixCodeState } from "../core/types.js";
import {
  assertConfiguredOpenTabsReadable,
  noteTabsReplaced,
} from "../core/open-tabs-store.js";
import { pushToast } from "../core/toast.js";
import { tabIsWaitingForInput } from "../core/tab-state.js";
import { activateTab, clampHomeSelectedTabIndex, getActiveTab } from "../core/tabs.js";
import { closeExistingAgentTab, deleteAgentTab } from "./agent-tab-actions.js";
import {
  applyModelSelection,
  applyThinkingLevel,
  applyWorkdirSelection,
  armPendingEscape,
  clearPendingEscape,
  hasPendingEscape,
  isPendingEscapeActive,
} from "./app-actions.js";
import {
  closeAppOverlay,
  hasAnyOverlay,
  showErrorOverlay,
  showLinesOverlay,
} from "./app-overlays.js";
import type {
  CommandPaletteActions,
  MixCodeEditorActions,
  MixCodeKeyRuntime,
  OverlayTui,
} from "./app-types.js";
import { getConfiguredQuitOptions, quitMixCode } from "./quit.js";
import { renderCommandPalette, renderPickerOverlay, renderTabJumpOverlay } from "./rendering.js";
import { openTreeSelector, type TreeSelectorRuntime } from "./tree-selector.js";
import { openForkSelector } from "./fork-selector.js";
import { clearVimTranscriptSearch } from "./vim-transcript-search.js";
export { handleVimUserMessageNavigation } from "./vim-user-message-navigation.js";

export {
  handleChatSelectionMouseInput,
  handleChromeMouseInput,
  handleCommandPaletteMouse,
  handleInputSelectionMouseInput,
  handleMouseInput,
  handleTabJumpMouse,
  hitTestCommandPaletteEntry,
  hitTestTabJumpEntry,
} from "./app-mouse.js";
import { handleCommandPaletteMouse, handleTabJumpMouse } from "./app-mouse.js";
export function handleStreamingAbortKey(
  active: MixCodeState["tabs"][number],
  tui: Pick<TuiType, "requestRender">,
  runtime?: MixCodeKeyRuntime,
  editorActions?: MixCodeEditorActions,
): boolean {
  const runtimeTab = runtime?.getTab(active.sessionId);
  const isAgentStreaming = runtimeTab?.agentSession?.isStreaming;
  const streaming =
    isAgentStreaming ?? (active.status === "running" || active.status === "thinking");
  // Also treat tab as "working" if status is running/thinking even when agent is not streaming
  // (e.g., branch summarization in progress, or retry waiting)
  const working = streaming ||
    (isAgentStreaming === false && (active.status === "running" || active.status === "thinking"));
  if (!working) return false;
  if (!hasPendingEscape(active)) {
    armPendingEscape(active);
    pushToast(active, { type: "info", message: "Esc again: stop" });
    tui.requestRender();
    return true;
  }
  if (!runtime) throw new Error("Stopping an active agent requires runtime abort support");
  // On the confirming Esc, prefer retracting the message back to an empty editor
  // when the run produced no visible output. Retract owns the abort internally;
  // a non-empty draft or an ineligible turn falls through to a plain abort.
  if (!editorActions?.getText()?.trim()) {
    clearPendingEscape(active);
    tui.requestRender();
    void retractOrAbort(active, tui, runtime, editorActions);
    return true;
  }
  runtime.abortTab(active.sessionId);
  clearPendingEscape(active);
  tui.requestRender();
  return true;
}

// Try a retract (no-output rewind); if the turn is ineligible, abort normally.
// Refills the editor only when it is still empty, so a draft typed during the
// async hop is never clobbered.
async function retractOrAbort(
  active: MixCodeState["tabs"][number],
  tui: Pick<TuiType, "requestRender">,
  runtime: MixCodeKeyRuntime,
  editorActions?: MixCodeEditorActions,
): Promise<void> {
  const result = await runtime.retractCurrentTurn(active.sessionId);
  if (!result) {
    runtime.abortTab(active.sessionId);
    tui.requestRender();
    return;
  }
  if (result.editorText && !editorActions?.getText()?.trim()) {
    editorActions?.setText(result.editorText);
  }
  tui.requestRender();
}

export function handleQueuedFlushKey(
  state: MixCodeState,
  active: MixCodeState["tabs"][number],
  data: string,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  isEditorAutocompleteOpen: () => boolean,
): boolean {
  if (!matchesKey(data, "escape")) return false;
  if (state.activeTabId === HOME_TAB_ID) return false;
  if (hasAnyOverlay(tui) || isEditorAutocompleteOpen()) return false;
  if (tabIsWaitingForInput(active)) return false;
  const runtimeTab = runtime?.getTab(active.sessionId);
  const runtimeQueuedCount = runtimeQueuedMessageCount(runtimeTab);
  if (active.pendingMessages.length === 0 && runtimeQueuedCount === 0) return false;
  const streaming =
    runtimeTab?.agentSession?.isStreaming ??
    (active.status === "running" || active.status === "thinking");
  if (!runtime) throw new Error("Flushing queued messages requires runtime queue support");
  if (streaming) runtime.abortTab(active.sessionId);
  clearPendingEscape(active);
  void runtime
    .flushPendingMessage(active.sessionId, runtimeQueuedCount || undefined)
    .then(() => {
      tui.requestRender();
    })
    .catch((error: unknown) => {
      showErrorOverlay(tui, error);
    });
  tui.requestRender();
  return true;
}

function runtimeQueuedMessageCount(
  runtimeTab: RuntimeTab | undefined,
): number {
  const queuedPromptCount =
    typeof runtimeTab?.queuedPromptCount === "number" ? runtimeTab.queuedPromptCount : 0;
  const steeringCount = runtimeTab?.agentSession?.getSteeringMessages().length ?? 0;
  return Math.max(queuedPromptCount, steeringCount);
}

export function handleQuitConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
): boolean {
  if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
    state.quitConfirmOpen = false;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (data.toLowerCase() === "y") {
    state.quitConfirmOpen = false;
    closeAppOverlay(tui);
    void quitMixCode(runtime, tui, getConfiguredQuitOptions(tui)).catch((error: unknown) => {
      showErrorOverlay(tui, error);
    });
    tui.requestRender();
    return true;
  }
  return true;
}

// Guards /delete-all-sessions (destructive, closes every tab and deletes every
// session file) behind a Y/N step, mirroring handleQuitConfirmKey. Unlike quit,
// the app keeps running afterward, so the confirmed deletion must also thread
// onStateChanged through to persist the now-empty tab list (see
// workspace-overlay.ts's handleDeleteConfirmKey for the same async+persist shape).
export function handleDeleteAllSessionsConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
    state.deleteAllSessionsConfirmOpen = false;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (data.toLowerCase() === "y") {
    if (!runtime) throw new Error("Deleting all sessions requires runtime support");
    const confirmedRuntime = runtime;
    state.deleteAllSessionsConfirmOpen = false;
    closeAppOverlay(tui);
    void (async () => {
      assertConfiguredOpenTabsReadable();
      // Call through confirmedRuntime.deleteAllTabs() (not a detached function
      // reference) so `this` inside the real MixCodeRuntime method still
      // resolves — deleteAllTabs reads `this.tabs` internally.
      await confirmedRuntime.deleteAllTabs();
      // Same bulk-close publish as /close-all-sessions so peer sync cannot reopen.
      noteTabsReplaced([]);
      state.tabs.length = 0;
      state.recentAgentTabIds = [];
      activateTab(state, HOME_TAB_ID);
      clampHomeSelectedTabIndex(state);
      await onStateChanged?.(state);
      tui.requestRender();
    })().catch((error: unknown) => showErrorOverlay(tui, error));
    return true;
  }
  return true;
}

// Same shape as handleDeleteAllSessionsConfirmKey, guarding /close-all-sessions
// (non-destructive: tabs close but session files are kept, unlike delete-all).
export function handleCloseAllSessionsConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
    state.closeAllSessionsConfirmOpen = false;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (data.toLowerCase() === "y") {
    if (!runtime) throw new Error("Closing all sessions requires runtime support");
    const confirmedRuntime = runtime;
    state.closeAllSessionsConfirmOpen = false;
    closeAppOverlay(tui);
    void (async () => {
      assertConfiguredOpenTabsReadable();
      // Call through confirmedRuntime.closeAllTabs() (not a detached function
      // reference) so `this` inside the real MixCodeRuntime method still
      // resolves — closeAllTabs reads `this.tabs` internally.
      await confirmedRuntime.closeAllTabs();
      // Publish the bulk close before local state becomes empty so peer sync cannot reopen it.
      noteTabsReplaced([]);
      state.tabs.length = 0;
      state.recentAgentTabIds = [];
      activateTab(state, HOME_TAB_ID);
      clampHomeSelectedTabIndex(state);
      await onStateChanged?.(state);
      tui.requestRender();
    })().catch((error: unknown) => showErrorOverlay(tui, error));
    return true;
  }
  return true;
}
export function handleSessionActionConfirmKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  runtime?: MixCodeKeyRuntime,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): boolean {
  const confirm = state.sessionActionConfirm;
  if (!confirm) return false;
  if (matchesKey(data, "escape") || data.toLowerCase() === "n") {
    state.sessionActionConfirm = null;
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (data.toLowerCase() === "y") {
    if (!runtime) throw new Error("Session close/delete requires runtime support");
    const confirmedRuntime = runtime;
    const { action, sessionId } = confirm;
    state.sessionActionConfirm = null;
    closeAppOverlay(tui);
    void (async () => {
      if (action === "close") {
        await closeExistingAgentTab(state, confirmedRuntime!, sessionId);
      } else {
        await deleteAgentTab(state, confirmedRuntime!, sessionId);
      }
      await onStateChanged?.(state);
      tui.requestRender();
    })().catch((error: unknown) => showErrorOverlay(tui, error));
    return true;
  }
  return true;
}

export function canOpenCommandPalette(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  tui: OverlayTui,
  isEditorAutocompleteOpen: () => boolean,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): boolean {
  if (isEditorAutocompleteOpen()) return false;
  if (hasAnyOverlay(tui)) return false;
  if (state.picker || state.sessionSelector.open || state.treeSelector.open || state.tabJumpOpen)
    return false;
  if (active && tabIsWaitingForInput(active)) return false;
  return commandPaletteEntriesWithExtensions(state, extensionCommands).length > 0;
}

export function handleCommandPaletteKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  commandPaletteActions?: CommandPaletteActions,
): boolean {
  if (handleCommandPaletteMouse(state, data, tui, commandPaletteActions)) return true;
  const extensionCommands = commandPaletteActions?.extensionCommands?.() ?? [];
  if (matchesKey(data, "escape")) {
    closeCommandPalette(state);
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    moveCommandPaletteSelection(state, matchesKey(data, "shift+tab") ? -1 : 1, extensionCommands);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (matchesKey(data, "enter")) {
    // Peek first so a missing executeCommand can throw without closing the palette.
    const selectable = selectableCommandPaletteEntries(state, extensionCommands);
    const selected =
      selectable[
        Math.min(Math.max(state.commandPalette.selectedIndex, 0), Math.max(0, selectable.length - 1))
      ];
    if (selected && !commandPaletteActions?.executeCommand) {
      throw new Error("Command palette selection requires command execution support");
    }
    // accept indexes the enabled-only list (same rows the palette paints).
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
    return true;
  }
  if (matchesKey(data, "down")) {
    moveCommandPaletteSelection(state, 1, extensionCommands);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (matchesKey(data, "up")) {
    moveCommandPaletteSelection(state, -1, extensionCommands);
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (data === "\u007f") {
    updateCommandPaletteQueryWithExtensions(
      state,
      state.commandPalette.query.slice(0, -1),
      extensionCommands,
    );
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    updateCommandPaletteQueryWithExtensions(
      state,
      state.commandPalette.query + data,
      extensionCommands,
    );
    showLinesOverlay(tui, (width) => renderCommandPalette(state, width, extensionCommands));
    return true;
  }
  // Modal: swallow unbound keys so they cannot scroll chat / open nested overlays.
  return true;
}

export function handleTabJumpKey(state: MixCodeState, data: string, tui: OverlayTui): boolean {
  if (handleTabJumpMouse(state, data, tui)) return true;
  if (matchesKey(data, "escape")) {
    closeTabJump(state);
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "ctrl+f")) {
    toggleTabJumpNonIdleOnly(state);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    moveTabJumpSelection(state, matchesKey(data, "shift+tab") ? -1 : 1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "enter")) {
    acceptTabJumpSelection(state);
    // vim/zen transfer is centralized in activateTab (agent→agent only).
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "down")) {
    moveTabJumpSelection(state, 1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "up")) {
    moveTabJumpSelection(state, -1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (data === "\u007f") {
    updateTabJumpQuery(state, state.tabJumpQuery.slice(0, -1));
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    updateTabJumpQuery(state, state.tabJumpQuery + data);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  // Modal: swallow unbound keys so they cannot fall through.
  return true;
}

export function handleVimModeKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (!active.vimMode) return false;
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) return false;
  if (matchesKey(data, "ctrl+t")) return false;
  if (data === "q") {
    active.vimMode = false;
    clearVimTranscriptSearch(active);
    active.vimPendingEscapeAt = undefined;
    active.vimPendingHome = false;
    return true;
  }
  active.vimPendingEscapeAt = undefined;
  if (data === "g" && active.vimPendingHome) {
    active.vimPendingHome = false;
    return chatHome(active);
  }
  if (data === "g") {
    active.vimPendingHome = true;
    return true;
  }
  active.vimPendingHome = false;
  if (matchesKey(data, "up") || data === "k") return scrollChat(active, 3);
  if (matchesKey(data, "down") || data === "j") return scrollChat(active, -3);
  if (matchesKey(data, "pageUp") || matchesKey(data, "ctrl+u")) return scrollChat(active, 10);
  if (matchesKey(data, "pageDown") || matchesKey(data, "ctrl+d")) return scrollChat(active, -10);
  if (matchesKey(data, "home")) return chatHome(active);
  if (matchesKey(data, "end") || data === "G") return chatEnd(active);
  return true;
}

export function handleChatScrollKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (matchesKey(data, "pageUp")) return scrollChat(active, 10);
  if (matchesKey(data, "pageDown")) return scrollChat(active, -10);
  if (matchesKey(data, "home")) return chatHome(active);
  if (matchesKey(data, "end")) return chatEnd(active);
  return false;
}

/**
 * Unified escape-key dispatch, mirroring SDK's onEscape with MixCode-specific
 * additions. Priority order (first match wins):
 *
 *  1. Extension custom overlay focus (MixCode-only, returns undefined for passthrough)
 *  2. Queued-message flush (MixCode-only, subsumes abort)
 *  3. Streaming/working abort; standalone bash aborts on first Esc
 *  4. Bash-mode editor text (!...) → clear editor
 *  5. Empty editor double-Esc → tree / fork / none (reads doubleEscapeAction)
 *
 * Returns { consume: true } when consumed, undefined for passthrough.
 */
export function handleEscapeKey(
  state: MixCodeState,
  active: MixCodeState["tabs"][number] | undefined,
  tui: OverlayTui,
  runtime: MixCodeKeyRuntime | undefined,
  editorActions: MixCodeEditorActions | undefined,
  isEditorAutocompleteOpen: () => boolean,
  onStateChanged?: (state: MixCodeState) => void | Promise<void>,
): { consume: true } | undefined {
  // 1. Extension custom overlay takes escape before any other dispatch
  //    (passthrough). Focus restoration happens in the shared lazy-refocus
  //    block in handleMixCodeKeyInput, which runs right after this dispatch.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    runtime?.hasExtensionCustomOverlay?.(active.sessionId)
  ) {
    clearPendingEscape(active);
    return undefined;
  }

  // 2. Queued-message flush (subsumes abort if streaming)
  if (
    active &&
    handleQueuedFlushKey(state, active, "\x1b", tui, runtime, isEditorAutocompleteOpen)
  ) {
    return { consume: true };
  }

  // 3. Streaming/working abort: arm then confirm (or retract if no output).
  // Standalone user bash (Pi parity): first Esc aborts immediately — no double-confirm.
  if (active && state.activeTabId !== HOME_TAB_ID && !hasAnyOverlay(tui)) {
    const runtimeTab = runtime?.getTab?.(active.sessionId);
    const isStreaming = runtimeTab?.agentSession?.isStreaming ?? false;
    const isBashRunning = runtimeTab?.agentSession?.isBashRunning ?? false;
    const isWorking = active.status === "running" || active.status === "thinking";

    if (isBashRunning && !isStreaming) {
      clearPendingEscape(active);
      runtime?.abortTab?.(active.sessionId);
      tui.requestRender();
      return { consume: true };
    }

    if (isStreaming || isWorking) {
      if (isPendingEscapeActive(active)) {
        // Confirming Esc: prefer retract when no output and editor is empty
        clearPendingEscape(active);
        if (runtime?.retractCurrentTurn && !editorActions?.getText()?.trim()) {
          // Immediate render while retract awaits stream idle (optimistic setText
          // also runs inside retractCurrentTurn when an editor host is wired).
          tui.requestRender();
          void retractOrAbort(active, tui, runtime, editorActions);
        } else {
          runtime?.abortTab?.(active.sessionId);
          tui.requestRender();
        }
        return { consume: true };
      }
      // First Esc: arm abort (toast, not meta row).
      armPendingEscape(active);
      pushToast(active, { type: "info", message: "Esc again: stop" });
      tui.requestRender();
      return { consume: true };
    }
  }

  // 4. Bash-mode editor text (!...) → clear input (Pi parity; not a running bash).
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !hasAnyOverlay(tui) &&
    editorActions?.getText()?.trimStart().startsWith("!")
  ) {
    clearPendingEscape(active);
    editorActions.setText("");
    tui.requestRender();
    return { consume: true };
  }

  // 5. Empty editor double-Esc → tree / fork / none
  // Vim owns Esc for mode exit; do not arm/open session tree while vim is on.
  if (
    active &&
    state.activeTabId !== HOME_TAB_ID &&
    !active.vimMode &&
    !hasAnyOverlay(tui) &&
    !state.commandPaletteOpen &&
    !tabIsWaitingForInput(active) &&
    !editorActions?.getText()?.trim()
  ) {
    const action = runtime?.getDoubleEscapeAction?.(active.sessionId) ?? "tree";
    if (action !== "none") {
      const now = Date.now();
      if (active.lastEscapeTime && now - active.lastEscapeTime < 500) {
        // Confirming double-Esc
        active.lastEscapeTime = undefined;
        if (action === "tree") {
          openTreeSelector(
            state,
            runtime as unknown as TreeSelectorRuntime,
            tui,
            active.sessionId,
          );
        } else {
          // action === "fork"
          openForkSelector(state, active.sessionId, runtime!, tui);
        }
        tui.requestRender();
        return { consume: true };
      }
      // First Esc: arm double-press (toast, not meta row).
      active.lastEscapeTime = now;
      pushToast(active, {
        type: "info",
        message: action === "fork" ? "Esc again: fork" : "Esc again: tree",
      });
      tui.requestRender();
      return { consume: true };
    }
  }

  return undefined;
}

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
        const runtimeTab = runtime?.getTab?.(active.sessionId);
        if (runtimeTab) {
          applyContextLimitToSession(active, value, {
            model: runtimeTab.agentSession.model,
            settingsManager: runtimeTab.agentSession.settingsManager,
          });
        } else {
          applyContextLimit(active, value);
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
      if (selected.disabled) {
        showErrorOverlay(tui, new Error(`Model is disabled: ${selected.label}`));
        tui.requestRender();
        return true;
      }
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
  } else if (state.picker.kind === "context-limit" && active) {
    // "reset" item or a numeric preset
    const value = selectedId === "reset" ? ("reset" as const) : parseInt(selectedId, 10);
    if (value === "reset" || (typeof value === "number" && value > 0)) {
      const runtimeTab = runtime?.getTab?.(active.sessionId);
      if (runtimeTab) {
        applyContextLimitToSession(active, value, {
          model: runtimeTab.agentSession.model,
          settingsManager: runtimeTab.agentSession.settingsManager,
        });
      } else {
        applyContextLimit(active, value);
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
