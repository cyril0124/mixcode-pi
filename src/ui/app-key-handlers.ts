import { matchesKey, type TUI as TuiType } from "@earendil-works/pi-tui";
import {
  acceptCommandPaletteSelection,
  acceptTabJumpSelection,
  chatEnd,
  chatHome,
  closeCommandPalette,
  closeTabJump,
  commandPaletteEntriesWithExtensions,
  moveCommandPaletteSelection,
  moveTabJumpSelection,
  navigatePreview,
  previewEnd,
  previewHome,
  scrollChat,
  scrollPreview,
  updateCommandPaletteQueryWithExtensions,
  updateTabJumpQuery,
} from "../core/overlays.js";
import type { MixCodeState } from "../core/types.js";
import { pushToast } from "../core/toast.js";
import { activateTab, clampHomeSelectedTabIndex, closeAgentTab, getActiveTab } from "../core/tabs.js";
import { deleteAgentTab } from "./agent-tab-actions.js";
import { armPendingEscape, clearPendingEscape, hasPendingEscape } from "./app-actions.js";
import { isPendingEscapeActive } from "../core/escape.js";
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
import { renderCommandPalette, renderTabJumpOverlay } from "./rendering.js";
import { openTreeSelector, type TreeSelectorRuntime } from "./tree-selector.js";
import { openForkSelector } from "./fork-selector.js";
export { handleVimUserMessageNavigation } from "./vim-user-message-navigation.js";

export {
  handleChatSelectionMouseInput,
  handleChromeMouseInput,
  handleInputSelectionMouseInput,
  handleMouseInput,
} from "./app-mouse.js";
export function handleStreamingAbortKey(
  active: MixCodeState["tabs"][number],
  tui: Pick<TuiType, "requestRender">,
  runtime?: MixCodeKeyRuntime,
  editorActions?: MixCodeEditorActions,
): boolean {
  const runtimeTab = runtime?.getTab?.(active.sessionId);
  const isAgentStreaming = runtimeTab?.agentSession?.isStreaming;
  const streaming =
    isAgentStreaming ?? (active.status === "running" || active.status === "thinking");
  // Also treat tab as "working" if status is running/thinking even when agent is not streaming
  // (e.g., branch summarization in progress, or retry waiting)
  const working = streaming ||
    (isAgentStreaming === false && (active.status === "running" || active.status === "thinking"));
  if (!working) return false;
  if (!hasPendingEscape(active, "abort-agent")) {
    armPendingEscape(active, "abort-agent");
    tui.requestRender();
    return true;
  }
  if (!runtime?.abortTab)
    throw new Error("Stopping an active agent requires runtime abort support");
  // On the confirming Esc, prefer retracting the message back to an empty editor
  // when the run produced no visible output. Retract owns the abort internally;
  // a non-empty draft or an ineligible turn falls through to a plain abort.
  if (runtime.retractCurrentTurn && !editorActions?.getText()?.trim()) {
    clearPendingEscape(active, "abort-agent");
    tui.requestRender();
    void retractOrAbort(active, tui, runtime, editorActions);
    return true;
  }
  runtime.abortTab(active.sessionId);
  clearPendingEscape(active, "abort-agent");
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
  const result = await runtime.retractCurrentTurn!(active.sessionId);
  if (!result) {
    runtime.abortTab?.(active.sessionId);
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
  if (state.activeTabId === "config") return false;
  if (hasAnyOverlay(tui) || isEditorAutocompleteOpen()) return false;
  if (active.previewOpen || active.pendingDialogs.length > 0) return false;
  const runtimeTab = runtime?.getTab?.(active.sessionId);
  const runtimeQueuedCount = runtimeQueuedMessageCount(runtimeTab);
  if (active.pendingMessages.length === 0 && runtimeQueuedCount === 0) return false;
  const streaming =
    runtimeTab?.agentSession?.isStreaming ??
    (active.status === "running" || active.status === "thinking");
  if (!runtime?.flushPendingMessage)
    throw new Error("Flushing queued messages requires runtime queue support");
  if (streaming) {
    if (!runtime.abortTab)
      throw new Error(
        "Flushing queued messages from an active agent requires runtime abort support",
      );
    runtime.abortTab(active.sessionId);
  }
  clearPendingEscape(active, "abort-agent");
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
  runtimeTab: ReturnType<NonNullable<MixCodeKeyRuntime["getTab"]>> | undefined,
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
    if (!runtime?.deleteAllTabs) throw new Error("Deleting all sessions requires runtime support");
    const confirmedRuntime = runtime;
    state.deleteAllSessionsConfirmOpen = false;
    closeAppOverlay(tui);
    void (async () => {
      // Call through confirmedRuntime.deleteAllTabs() (not a detached function
      // reference) so `this` inside the real MixCodeRuntime method still
      // resolves — deleteAllTabs reads `this.tabs` internally.
      await confirmedRuntime.deleteAllTabs!();
      state.tabs.length = 0;
      activateTab(state, "config");
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
    if (!runtime?.closeAllTabs) throw new Error("Closing all sessions requires runtime support");
    const confirmedRuntime = runtime;
    state.closeAllSessionsConfirmOpen = false;
    closeAppOverlay(tui);
    void (async () => {
      // Call through confirmedRuntime.closeAllTabs() (not a detached function
      // reference) so `this` inside the real MixCodeRuntime method still
      // resolves — closeAllTabs reads `this.tabs` internally.
      await confirmedRuntime.closeAllTabs!();
      state.tabs.length = 0;
      activateTab(state, "config");
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
    if (confirm.action === "close" && !runtime?.closeTab) throw new Error("Closing a session requires runtime support");
    if (confirm.action === "delete" && !runtime?.deleteTab) throw new Error("Deleting a session requires runtime support");
    const confirmedRuntime = runtime;
    const { action, sessionId } = confirm;
    state.sessionActionConfirm = null;
    closeAppOverlay(tui);
    void (async () => {
      if (action === "close") {
        await confirmedRuntime!.closeTab!(sessionId);
        closeAgentTab(state, sessionId);
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
  if (active?.previewOpen || active?.pendingDialogs.length) return false;
  return commandPaletteEntriesWithExtensions(state, extensionCommands).length > 0;
}

export function handleCommandPaletteKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  commandPaletteActions?: CommandPaletteActions,
): boolean {
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
    const entries = commandPaletteEntriesWithExtensions(state, extensionCommands);
    const selected =
      entries[
        Math.min(Math.max(state.commandPalette.selectedIndex, 0), Math.max(0, entries.length - 1))
      ];
    if (selected && !selected.enabled) {
      closeCommandPalette(state);
      closeAppOverlay(tui);
      const active = getActiveTab(state);
      if (active)
        pushToast(active, {
          type: "warning",
          message: selected.disabledReason || "Command unavailable",
        });
      tui.requestRender();
      return true;
    }
    if (selected && !commandPaletteActions?.executeCommand) {
      throw new Error("Command palette selection requires command execution support");
    }
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
  return false;
}

export function handleTabJumpKey(state: MixCodeState, data: string, tui: OverlayTui): boolean {
  if (matchesKey(data, "escape")) {
    closeTabJump(state);
    closeAppOverlay(tui);
    tui.requestRender();
    return true;
  }
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
    moveTabJumpSelection(state, matchesKey(data, "shift+tab") ? -1 : 1);
    showLinesOverlay(tui, (width) => renderTabJumpOverlay(state, width));
    return true;
  }
  if (matchesKey(data, "enter")) {
    const prev = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
    const targetId = acceptTabJumpSelection(state);
    // Transfer vim only when the target is another agent tab. Jumping to MixCode
    // Home (config) must leave vimMode on prev — same as Left → Home.
    if (prev?.vimMode && targetId && targetId !== prev.sessionId) {
      const next = state.tabs.find((tab) => tab.sessionId === targetId);
      if (next) {
        prev.vimMode = false;
        prev.vimPendingEscapeAt = undefined;
        prev.vimPendingHome = false;
        next.vimMode = true;
        next.vimPendingEscapeAt = undefined;
        next.vimPendingHome = false;
      }
    }
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
  return false;
}

export function handlePreviewKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (matchesKey(data, "escape")) {
    active.previewPendingHome = false;
    active.previewOpen = false;
    return true;
  }
  if (matchesKey(data, "left") || data === "h") {
    active.previewPendingHome = false;
    return navigatePreview(active, -1);
  }
  if (matchesKey(data, "right") || data === "l") {
    active.previewPendingHome = false;
    return navigatePreview(active, 1);
  }
  if (matchesKey(data, "down") || data === "j") {
    active.previewPendingHome = false;
    return scrollPreview(active, 3);
  }
  if (matchesKey(data, "up") || data === "k") {
    active.previewPendingHome = false;
    return scrollPreview(active, -3);
  }
  if (matchesKey(data, "end") || data === "G") {
    active.previewPendingHome = false;
    return previewEnd(active);
  }
  if (matchesKey(data, "home") || (data === "g" && active.previewPendingHome)) {
    active.previewPendingHome = false;
    return previewHome(active);
  }
  if (data === "g") {
    active.previewPendingHome = true;
    return true;
  }
  return false;
}

export function handleVimModeKey(active: MixCodeState["tabs"][number], data: string): boolean {
  if (!active.vimMode) return false;
  if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) return false;
  if (matchesKey(data, "ctrl+t")) return false;
  if (data === "q") {
    active.vimMode = false;
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
    state.activeTabId !== "config" &&
    runtime?.hasExtensionCustomOverlay?.(active.sessionId)
  ) {
    clearPendingEscape(active, "abort-agent");
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
  if (active && state.activeTabId !== "config" && !hasAnyOverlay(tui)) {
    const runtimeTab = runtime?.getTab?.(active.sessionId);
    const isStreaming = runtimeTab?.agentSession?.isStreaming ?? false;
    const isBashRunning = runtimeTab?.agentSession?.isBashRunning ?? false;
    const isWorking = active.status === "running" || active.status === "thinking";

    if (isBashRunning && !isStreaming) {
      active.pendingEscapeAction = undefined;
      active.pendingEscapeArmedAt = undefined;
      runtime?.abortTab?.(active.sessionId);
      tui.requestRender();
      return { consume: true };
    }

    if (isStreaming || isWorking) {
      if (active.pendingEscapeAction === "abort-agent" && isPendingEscapeActive(active, "abort-agent")) {
        // Confirming Esc: prefer retract when no output and editor is empty
        active.pendingEscapeAction = undefined;
        if (runtime?.retractCurrentTurn && !editorActions?.getText()?.trim()) {
          void retractOrAbort(active, tui, runtime, editorActions);
        } else {
          runtime?.abortTab?.(active.sessionId);
          tui.requestRender();
        }
        return { consume: true };
      }
      // First Esc: arm abort
      active.pendingEscapeAction = "abort-agent";
      active.pendingEscapeArmedAt = Date.now();
      tui.requestRender();
      return { consume: true };
    }
  }

  // 4. Bash-mode editor text (!...) → clear input (Pi parity; not a running bash).
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    editorActions?.getText()?.trimStart().startsWith("!")
  ) {
    clearPendingEscape(active, "abort-agent");
    editorActions.setText("");
    tui.requestRender();
    return { consume: true };
  }

  // 5. Empty editor double-Esc → tree / fork / none
  if (
    active &&
    state.activeTabId !== "config" &&
    !hasAnyOverlay(tui) &&
    !state.commandPaletteOpen &&
    !active.previewOpen &&
    !active.pendingDialogs.length &&
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
      // First Esc: arm the double-press timer
      active.lastEscapeTime = now;
      tui.requestRender();
      return { consume: true };
    }
  }

  return undefined;
}
