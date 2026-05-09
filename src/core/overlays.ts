import type { CommandPaletteEntry, MixCodeState, MixCodeTabInfo } from "./types.js";
import { fuzzyMatchBatch } from "./fuzzy.js";
import { activateTab } from "./tabs.js";
import { tabHasPendingUserInteraction } from "./user-interactions.js";

export function toggleShell(tab: MixCodeTabInfo): void {
  tab.shellOpen = !tab.shellOpen;
  tab.pendingEscapeAction = undefined;
  tab.pendingEscapeArmedAt = undefined;
  tab.shellScrollOffset = 0;
}

export function togglePreview(tab: MixCodeTabInfo): void {
  tab.previewOpen = !tab.previewOpen;
  if (tab.previewOpen) {
    tab.previewIndex = clampPreviewIndex(tab);
    tab.previewScrollOffset = 0;
    tab.previewHint = "";
  }
}

export function navigatePreview(tab: MixCodeTabInfo, direction: number): boolean {
  if (!tab.previewOpen || tab.previewMessages.length === 0) return false;
  const next = clampPreviewIndex(tab) + direction;
  if (next < 0) {
    tab.previewHint = "No older message";
    return true;
  }
  if (next >= tab.previewMessages.length) {
    tab.previewHint = "No newer message";
    return true;
  }
  tab.previewIndex = next;
  tab.previewScrollOffset = 0;
  tab.previewHint = "";
  return true;
}

export function scrollPreview(tab: MixCodeTabInfo, delta: number): boolean {
  if (!tab.previewOpen) return false;
  const message = tab.previewMessages[clampPreviewIndex(tab)];
  const maxOffset = Math.max(0, (message?.text.split(/\r?\n/).length ?? 0) - 1);
  tab.previewScrollOffset = Math.min(maxOffset, Math.max(0, tab.previewScrollOffset + delta));
  tab.previewHint = "";
  return true;
}

export function scrollChat(tab: MixCodeTabInfo, delta: number): boolean {
  tab.chatScrollOffset = Math.min(1_000_000, Math.max(0, tab.chatScrollOffset + delta));
  return true;
}

export function chatHome(tab: MixCodeTabInfo): boolean {
  tab.chatScrollOffset = 1_000_000;
  return true;
}

export function chatEnd(tab: MixCodeTabInfo): boolean {
  tab.chatScrollOffset = 0;
  return true;
}

export function previewHome(tab: MixCodeTabInfo): boolean {
  if (!tab.previewOpen) return false;
  tab.previewScrollOffset = 0;
  tab.previewHint = "";
  return true;
}

export function previewEnd(tab: MixCodeTabInfo): boolean {
  if (!tab.previewOpen) return false;
  const message = tab.previewMessages[clampPreviewIndex(tab)];
  tab.previewScrollOffset = Math.max(0, (message?.text.split(/\r?\n/).length ?? 0) - 1);
  tab.previewHint = "";
  return true;
}

export function previewTitle(tab: MixCodeTabInfo): string {
  if (tab.previewHint) return tab.previewHint;
  if (tab.previewMessages.length === 0) return "No message yet";
  const index = clampPreviewIndex(tab);
  const role = tab.previewMessages[index]?.role ?? "empty";
  return `${previewRoleLabel(role)} Message ${index + 1} / ${tab.previewMessages.length}`;
}

export function scrollShell(tab: MixCodeTabInfo, delta: number, visibleLines = 16): boolean {
  if (!tab.shellOpen || !tab.shellSession) return false;
  const maxOffset = Math.max(0, tab.shellSession.buffer.length - visibleLines);
  tab.shellScrollOffset = Math.min(maxOffset, Math.max(0, tab.shellScrollOffset + delta));
  return true;
}

function clampPreviewIndex(tab: MixCodeTabInfo): number {
  if (tab.previewMessages.length === 0) return 0;
  tab.previewIndex = Math.min(Math.max(tab.previewIndex, 0), tab.previewMessages.length - 1);
  return tab.previewIndex;
}

function previewRoleLabel(role: string): string {
  if (role === "user") return "User";
  if (role === "assistant") return "Assistant";
  if (role === "thinking") return "Thinking";
  if (role === "tool") return "Tool";
  if (role === "system") return "System";
  if (role === "shell") return "Shell";
  return "Message";
}

export function tabJumpEntries(
  state: MixCodeState,
): Array<{ id: string; label: string; busy: boolean; done: boolean; question: boolean }> {
  return [
    { id: "config", label: "MixCode Home", busy: false, done: false, question: false },
    ...state.tabs.map((tab) => ({
      id: tab.sessionId,
      label: tab.alias || tab.title,
      busy: tab.status === "running" || tab.status === "thinking",
      done: tab.unreadDone,
      question: tabHasPendingUserInteraction(tab),
    })),
  ];
}

export function filterTabJumpEntries(
  state: MixCodeState,
  query: string,
): ReturnType<typeof tabJumpEntries> {
  const entries = tabJumpEntries(state);
  if (!query.trim()) return entries;
  const labels = entries.map((entry) => entry.label);
  const matched = new Set(fuzzyMatchBatch(query, labels, entries.length).map(([, label]) => label));
  return entries.filter((entry) => matched.has(entry.label));
}

export function openTabJump(state: MixCodeState): void {
  state.tabJumpOpen = true;
  state.tabJumpQuery = "";
  state.tabJumpIndex = Math.max(
    0,
    tabJumpEntries(state).findIndex((entry) => entry.id === state.activeTabId),
  );
}

export function closeTabJump(state: MixCodeState): void {
  state.tabJumpOpen = false;
  state.tabJumpQuery = "";
  state.tabJumpIndex = 0;
}

export function updateTabJumpQuery(state: MixCodeState, query: string): void {
  state.tabJumpQuery = query;
  state.tabJumpIndex = clampTabJumpIndex(state, state.tabJumpIndex);
}

export function moveTabJumpSelection(state: MixCodeState, delta: number): void {
  state.tabJumpIndex = clampTabJumpIndex(state, state.tabJumpIndex + delta);
}

export function acceptTabJumpSelection(state: MixCodeState): string {
  const entries = filterTabJumpEntries(state, state.tabJumpQuery);
  if (!entries.length) {
    closeTabJump(state);
    return "";
  }
  const entry = entries[clampTabJumpIndex(state, state.tabJumpIndex)];
  activateTab(state, entry?.id ?? state.activeTabId);
  closeTabJump(state);
  return entry?.id ?? "";
}

function clampTabJumpIndex(state: MixCodeState, index: number): number {
  const entries = filterTabJumpEntries(state, state.tabJumpQuery);
  if (!entries.length) return 0;
  return Math.min(Math.max(index, 0), entries.length - 1);
}

export function commandPaletteEntries(state: MixCodeState): CommandPaletteEntry[] {
  return commandPaletteEntriesWithExtensions(state);
}

export function commandPaletteEntriesWithExtensions(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): CommandPaletteEntry[] {
  const entries = commandPaletteBaseEntries(state, extensionCommands);
  const query = state.commandPalette.query.trim();
  if (!query) return entries;
  const searchKeys = entries.map((entry) => `${entry.label} ${entry.command}`);
  const matched = new Set(fuzzyMatchBatch(query, searchKeys, entries.length).map(([, key]) => key));
  return entries.filter((entry, index) => matched.has(searchKeys[index] ?? ""));
}

function commandPaletteBaseEntries(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }>,
): CommandPaletteEntry[] {
  if (state.activeTabId === "config") return configCommandPaletteEntries(state);
  const active = state.tabs.find((tab) => tab.sessionId === state.activeTabId);
  if (!active) return [];
  return [
    ...agentCommandPaletteEntries(state, active),
    ...extensionCommandPaletteEntries(extensionCommands),
  ];
}

function configCommandPaletteEntries(state: MixCodeState): CommandPaletteEntry[] {
  const hasTabs = state.tabs.length > 0;
  return [
    commandEntry("config.theme", "Choose Theme", "/theme", "Choose the app UI theme"),
    commandEntry(
      "config.tui-state",
      "Open TUI State",
      "/tui-state",
      "Show the current TUI state JSON",
    ),
    commandEntry(
      "config.extension-manager",
      "Extension Manager",
      "/extension-manager",
      "Manage Pi extensions for this workdir",
      hasTabs,
      "No open Agent Tabs",
    ),
    commandEntry(
      "config.new-session",
      "New Session",
      "/new-session",
      "Create a new pi agent session",
    ),
    commandEntry(
      "config.save-workspace",
      "Save Workspace",
      "/save-workspace",
      "Save the current open agent tabs as a workspace",
      hasTabs,
      "No open Agent Tabs to save as a workspace",
    ),
    commandEntry(
      "config.restore-workspace",
      "Restore Workspace",
      "/restore-workspace",
      "Restore a saved workspace",
    ),
    commandEntry(
      "config.delete-workspace",
      "Delete Workspace",
      "/delete-workspace",
      "Delete a saved workspace",
    ),
    commandEntry(
      "config.delete-all-sessions",
      "Delete All Sessions",
      "/delete-all-sessions",
      "Delete all sessions and close all agent tabs",
      hasTabs,
      "No open Agent Tabs",
    ),
  ];
}

function agentCommandPaletteEntries(
  state: MixCodeState,
  active: MixCodeTabInfo,
): CommandPaletteEntry[] {
  const hasSession = Boolean(active.sessionId);
  const hasModels = state.availableModels.length > 0;
  const hasTabs = state.tabs.length > 0;
  const noSessionReason = "Current tab has no active session";
  return [
    commandEntry(
      "agent.models",
      "Choose Model",
      "/models",
      "Choose the current tab model",
      hasSession && hasModels,
      !hasSession ? noSessionReason : "No models loaded",
    ),
    commandEntry(
      "agent.thinking",
      "Choose Thinking Tier",
      "/thinking",
      "Choose the current tab thinking tier",
      hasSession,
      noSessionReason,
    ),
    commandEntry("agent.theme", "Choose Theme", "/theme", "Choose the app UI theme"),
    commandEntry(
      "agent.tui-state",
      "Open TUI State",
      "/tui-state",
      "Show the current TUI state JSON",
    ),
    commandEntry(
      "agent.system-tools",
      "Open System Tools",
      "/system-tools",
      "Show the active agent tools",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.system-prompt",
      "Open System Prompt",
      "/system-prompt",
      "Show the active agent system prompt",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.extension-manager",
      "Extension Manager",
      "/extension-manager",
      "Manage Pi extensions for this workdir",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.rename",
      "Rename",
      "/rename",
      "Rename the current tab",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.workdir",
      "Change Workdir",
      "/workdir",
      "Change the current tab working directory",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.import",
      "Import Session",
      "/import",
      "Import a Pi session JSONL file into the current tab",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.mark-done",
      "Mark Done",
      "/mark-done",
      "Mark the current tab done",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.vim",
      "Vim Mode",
      "/vim",
      "Enter Vim mode for chat scrolling",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.new-session",
      "New Session",
      "/new-session",
      "Create a new pi agent session",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.close-session",
      "Close Session",
      "/close-session",
      "Close the current tab but keep its session",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.delete-session",
      "Delete Session",
      "/delete-session",
      "Delete the session bound to the current tab",
      hasSession,
      noSessionReason,
    ),
    commandEntry(
      "agent.delete-all-sessions",
      "Delete All Sessions",
      "/delete-all-sessions",
      "Delete all sessions and close all agent tabs",
      hasTabs,
      "No open Agent Tabs",
    ),
  ];
}

function extensionCommandPaletteEntries(
  commands: Array<{ name: string; description?: string }>,
): CommandPaletteEntry[] {
  const localCommands = new Set(commandPaletteLocalCommands());
  return commands
    .filter((command) => command.name && !localCommands.has(command.name))
    .map((command) =>
      commandEntry(
        `extension.${command.name}`,
        command.name,
        `/${command.name}`,
        command.description ?? "Extension command",
      ),
    );
}

function commandPaletteLocalCommands(): string[] {
  return [
    "models",
    "thinking",
    "theme",
    "tui-state",
    "system-tools",
    "system-prompt",
    "extension-manager",
    "rename",
    "workdir",
    "import",
    "mark-done",
    "vim",
    "new-session",
    "close-session",
    "delete-session",
    "delete-all-sessions",
  ];
}

function commandEntry(
  id: string,
  label: string,
  command: string,
  description: string,
  enabled = true,
  disabledReason = "",
): CommandPaletteEntry {
  return {
    id,
    label,
    command,
    description,
    enabled,
    disabledReason: enabled ? "" : disabledReason,
  };
}

export function openCommandPalette(state: MixCodeState): void {
  state.commandPaletteOpen = true;
  state.commandPalette = { query: "", selectedIndex: 0 };
}

export function closeCommandPalette(state: MixCodeState): void {
  state.commandPaletteOpen = false;
  state.commandPalette = { query: "", selectedIndex: 0 };
}

export function updateCommandPaletteQuery(state: MixCodeState, query: string): void {
  state.commandPalette.query = query;
  state.commandPalette.selectedIndex = clampCommandPaletteIndex(
    state,
    state.commandPalette.selectedIndex,
  );
}

export function updateCommandPaletteQueryWithExtensions(
  state: MixCodeState,
  query: string,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): void {
  state.commandPalette.query = query;
  state.commandPalette.selectedIndex = clampCommandPaletteIndexWithExtensions(
    state,
    state.commandPalette.selectedIndex,
    extensionCommands,
  );
}

export function moveCommandPaletteSelection(
  state: MixCodeState,
  delta: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): void {
  const count = commandPaletteEntriesWithExtensions(state, extensionCommands).length;
  if (count === 0) {
    state.commandPalette.selectedIndex = 0;
    return;
  }
  state.commandPalette.selectedIndex = (state.commandPalette.selectedIndex + delta + count) % count;
}

export function acceptCommandPaletteSelection(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): string {
  const entries = commandPaletteEntriesWithExtensions(state, extensionCommands);
  const selected =
    entries[
      clampCommandPaletteIndexWithExtensions(
        state,
        state.commandPalette.selectedIndex,
        extensionCommands,
      )
    ];
  closeCommandPalette(state);
  return selected?.enabled === false ? "" : (selected?.command ?? "");
}

function clampCommandPaletteIndex(state: MixCodeState, index: number): number {
  return clampCommandPaletteIndexWithExtensions(state, index);
}

function clampCommandPaletteIndexWithExtensions(
  state: MixCodeState,
  index: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): number {
  const entries = commandPaletteEntriesWithExtensions(state, extensionCommands);
  if (!entries.length) return 0;
  return Math.min(Math.max(index, 0), entries.length - 1);
}
