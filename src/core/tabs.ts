import { createTab } from "./defaults.js";
import type { MixCodeState, MixCodeTabInfo } from "./types.js";

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
  state.activeTabId = tabId;
  const tab = state.tabs.find((item) => item.sessionId === tabId);
  if (tab) tab.unreadDone = false;
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
