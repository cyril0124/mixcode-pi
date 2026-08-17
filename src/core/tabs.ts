import { HOME_TAB_ID, type MixCodeState, type MixCodeTabInfo } from "./types.js";

export { HOME_TAB_ID } from "./types.js";

const activeTabListeners = new Set<(tabId: string) => void>();

/** Subscribe to UI focus changes (`activateTab`). Returns unsubscribe. */
export function onActiveTabChange(listener: (tabId: string) => void): () => void {
  activeTabListeners.add(listener);
  return () => {
    activeTabListeners.delete(listener);
  };
}

/** Returns the active agent, using the Home selection while Home is focused. */
export function getActiveTab(
  state: Pick<MixCodeState, "tabs" | "activeTabId" | "homeSelectedTabIndex">,
): MixCodeTabInfo | undefined {
  if (state.activeTabId === HOME_TAB_ID) return state.tabs[state.homeSelectedTabIndex];
  return state.tabs.find((tab) => tab.sessionId === state.activeTabId);
}

/** Finds the tab identified by activeTabId, without fallback. Returns undefined when not found. */
export function findActiveTab(state: Pick<MixCodeState, "tabs" | "activeTabId">): MixCodeTabInfo | undefined {
  return state.tabs.find((tab) => tab.sessionId === state.activeTabId);
}

export function closeAgentTab(state: MixCodeState, sessionId: string): MixCodeTabInfo {
  const index = state.tabs.findIndex((tab) => tab.sessionId === sessionId);
  if (index < 0) throw new Error(`Unknown tab: ${sessionId}`);
  const [removed] = state.tabs.splice(index, 1);
  state.tabs.forEach((tab, tabIndex) => {
    tab.index = tabIndex + 1;
  });
  forgetRecentAgentTab(state, sessionId);
  if (state.activeTabId === sessionId) {
    activateTab(state, state.tabs[Math.min(index, state.tabs.length - 1)]?.sessionId ?? HOME_TAB_ID);
  }
  // Closing a tab before the Home selection shifts later tabs down — keep the
  // same agent selected by moving the index with them.
  if (index < state.homeSelectedTabIndex) state.homeSelectedTabIndex -= 1;
  clampHomeSelectedTabIndex(state);
  return removed!;
}

const RECENT_AGENT_TAB_LIMIT = 3;

function liveRecentAgentTabIds(state: MixCodeState): string[] {
  const live = new Set(state.tabs.map((tab) => tab.sessionId));
  return (state.recentAgentTabIds ?? []).filter((id) => live.has(id));
}

export function noteRecentAgentTab(state: MixCodeState, sessionId: string): void {
  if (!sessionId || sessionId === HOME_TAB_ID) return;
  const current = liveRecentAgentTabIds(state);
  state.recentAgentTabIds = [sessionId, ...current.filter((id) => id !== sessionId)].slice(
    0,
    RECENT_AGENT_TAB_LIMIT,
  );
}

export function forgetRecentAgentTab(state: MixCodeState, sessionId: string): void {
  state.recentAgentTabIds = liveRecentAgentTabIds(state).filter((id) => id !== sessionId);
}

export function recentAgentTabRank(state: MixCodeState, sessionId: string): number {
  return liveRecentAgentTabIds(state).indexOf(sessionId);
}

export function discardVimTranscriptSearch(tab: MixCodeTabInfo): void {
  const editorText = tab.vimTranscriptSearch?.cancelSnapshot?.editorText;
  if (editorText !== undefined) {
    tab.draftInput = editorText;
    tab.vimSearchDraftRestorePending = true;
  }
  tab.vimTranscriptSearch = undefined;
}

export function activateTab(state: MixCodeState, tabId: string): void {
  // Tab / mouse paths reach Home via activateTab(HOME_TAB_ID) without the Left-key
  // helper that sets homeSelectedTabIndex. Remember the agent we left so Home
  // highlight / Enter / getActiveTab stay on that row.
  if (tabId === HOME_TAB_ID && state.activeTabId !== HOME_TAB_ID) {
    const leaving = state.tabs.findIndex((tab) => tab.sessionId === state.activeTabId);
    if (leaving >= 0) state.homeSelectedTabIndex = leaving;
  }
  // Transfer vim/zen/inline-widgets onto the destination agent. Source is the mode-owning
  // agent (any tab with the flag), not only activeTabId — on Home activeTabId
  // is HOME_TAB_ID while the highlighted agent still holds the mode.
  // Jumping to Home keeps flags on the agent (same as Left → Home).
  if (tabId !== HOME_TAB_ID && tabId !== state.activeTabId) {
    const next = state.tabs.find((tab) => tab.sessionId === tabId);
    if (next) {
      const vimSource = state.tabs.find((tab) => tab.vimMode && tab.sessionId !== next.sessionId);
      if (vimSource) {
        vimSource.vimMode = false;
        discardVimTranscriptSearch(vimSource);
        vimSource.vimPendingEscapeAt = undefined;
        vimSource.vimPendingHome = false;
        next.vimMode = true;
        discardVimTranscriptSearch(next);
        next.vimPendingEscapeAt = undefined;
        next.vimPendingHome = false;
      }
      const zenSource = state.tabs.find((tab) => tab.zenMode && tab.sessionId !== next.sessionId);
      if (zenSource) {
        zenSource.zenMode = false;
        next.zenMode = true;
      }
      const inlineSource = state.tabs.find(
        (tab) => tab.inlineWidgets && tab.sessionId !== next.sessionId,
      );
      if (inlineSource) {
        inlineSource.inlineWidgets = false;
        next.inlineWidgets = true;
      }
    }
  }
  state.activeTabId = tabId;
  if (tabId !== HOME_TAB_ID) noteRecentAgentTab(state, tabId);
  for (const listener of activeTabListeners) listener(tabId);
  const tab = state.tabs.find((item) => item.sessionId === tabId);
  if (!tab) return;
  // /mark-done sets status=done + unreadDone; both drive the "!" glyph. Clear both
  // on focus so the badge matches real agent_end (unread only until viewed).
  tab.unreadDone = false;
  if (tab.status === "done") tab.status = "idle";
}

/**
 * Close the extension widget side panel and drop any in-progress panel text
 * selection. Panel open/close is user-owned (→ toggle); call this only for
 * explicit dismiss paths — not when extension dialogs/custom UIs start.
 * Returns true if the panel was open.
 */
export function dismissExtensionPanel(tab: MixCodeTabInfo): boolean {
  if (!tab.panelOpen) return false;
  tab.panelOpen = false;
  tab.panelSelection = undefined;
  tab.panelScrollOffset = 0;
  return true;
}

export function renameAgentTab(state: MixCodeState, sessionId: string, title: string): void {
  const tab = state.tabs.find((item) => item.sessionId === sessionId);
  if (!tab) throw new Error(`Unknown tab: ${sessionId}`);
  const clean = title.trim();
  if (!clean) throw new Error("Tab title cannot be empty");
  tab.title = clean;
}

export function nextTabId(state: MixCodeState, delta: number): string {
  const ids = [HOME_TAB_ID, ...state.tabs.map((tab) => tab.sessionId)];
  const current = Math.max(0, ids.indexOf(state.activeTabId));
  return ids[(current + delta + ids.length) % ids.length]!;
}

/** Clamp homeSelectedTabIndex to valid range after tab mutations. */
export function clampHomeSelectedTabIndex(state: MixCodeState): void {
  if (state.tabs.length === 0) {
    state.homeSelectedTabIndex = 0;
    return;
  }
  state.homeSelectedTabIndex = Math.max(
    0,
    Math.min(state.homeSelectedTabIndex, state.tabs.length - 1),
  );
}
