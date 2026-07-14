import { createTab } from "./defaults.js";
import type { MixCodeState, MixCodeTabInfo } from "./types.js";

/** Returns the active agent, using the Home selection while the config tab is active. */
export function getActiveTab(
  state: Pick<MixCodeState, "tabs" | "activeTabId" | "homeSelectedTabIndex">,
): MixCodeTabInfo | undefined {
  if (state.activeTabId === "config") return state.tabs[state.homeSelectedTabIndex];
  return state.tabs.find((tab) => tab.sessionId === state.activeTabId);
}

/** Finds the tab identified by activeTabId, without fallback. Returns undefined when not found. */
export function findActiveTab(state: Pick<MixCodeState, "tabs" | "activeTabId">): MixCodeTabInfo | undefined {
  return state.tabs.find((tab) => tab.sessionId === state.activeTabId);
}

export function addAgentTab(
  state: MixCodeState,
  sessionId: string,
  workdir = state.workdir,
): MixCodeTabInfo {
  if (state.tabs.some((tab) => tab.sessionId === sessionId)) {
    throw new Error(`Tab already exists: ${sessionId}`);
  }
  const tab = createTab(state.tabs.length + 1, sessionId, workdir);
  state.tabs.push(tab);
  activateTab(state, sessionId);
  return tab;
}

export function closeAgentTab(state: MixCodeState, sessionId: string): MixCodeTabInfo {
  const index = state.tabs.findIndex((tab) => tab.sessionId === sessionId);
  if (index < 0) throw new Error(`Unknown tab: ${sessionId}`);
  const [removed] = state.tabs.splice(index, 1);
  state.tabs.forEach((tab, tabIndex) => {
    tab.index = tabIndex + 1;
  });
  if (state.activeTabId === sessionId) {
    activateTab(state, state.tabs[Math.min(index, state.tabs.length - 1)]?.sessionId ?? "config");
  }
  clampHomeSelectedTabIndex(state);
  return removed!;
}

export function activateTab(state: MixCodeState, tabId: string): void {
  // Tab / mouse paths reach Home via activateTab("config") without the Left-key
  // helper that sets homeSelectedTabIndex. Remember the agent we left so Home
  // highlight / Enter / getActiveTab stay on that row.
  if (tabId === "config" && state.activeTabId !== "config") {
    const leaving = state.tabs.findIndex((tab) => tab.sessionId === state.activeTabId);
    if (leaving >= 0) state.homeSelectedTabIndex = leaving;
  }
  state.activeTabId = tabId;
  const tab = state.tabs.find((item) => item.sessionId === tabId);
  if (!tab) return;
  // /mark-done sets status=done + unreadDone; both drive the "!" glyph. Clear both
  // on focus so the badge matches real agent_end (unread only until viewed).
  tab.unreadDone = false;
  if (tab.status === "done") tab.status = "idle";
}

/**
 * Close the extension widget side panel and drop any in-progress panel text
 * selection. Used when a modal interaction takes over (dialog/custom overlay)
 * or the session is cleared, so the panel never fights for focus or screen
 * space with a modal surface. Returns true if the panel was open.
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
  const ids = ["config", ...state.tabs.map((tab) => tab.sessionId)];
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
