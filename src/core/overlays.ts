import { LOCAL_COMMANDS, type LocalCommandPaletteMeta, type PaletteRequirement } from "./commands.js";
import { fuzzyMatchBatch } from "./fuzzy.js";
import { activateTab, findActiveTab } from "./tabs.js";
import type { CommandPaletteEntry, MixCodeState, MixCodeTabInfo } from "./types.js";
import { tabHasPendingUserInteraction } from "./user-interactions.js";

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
  if (tab.chatScrollAnchorEntryId) {
    tab.chatScrollOffset = Math.min(1_000_000, Math.max(-1_000_000, tab.chatScrollOffset + delta));
    return true;
  }
  tab.chatScrollOffset = Math.min(1_000_000, Math.max(0, tab.chatScrollOffset + delta));
  return true;
}

/**
 * Scroll the widget side panel by `delta` rows. Only the lower bound is clamped
 * here (>= 0); the upper bound depends on rendered content height and is
 * clamped at render time in renderExtensionPanel. Returns true so callers can
 * treat it as handled.
 */
export function scrollExtensionPanel(tab: MixCodeTabInfo, delta: number): boolean {
  tab.panelScrollOffset = Math.min(1_000_000, Math.max(0, tab.panelScrollOffset + delta));
  return true;
}

export function chatHome(tab: MixCodeTabInfo): boolean {
  clearChatScrollAnchor(tab);
  tab.chatScrollOffset = 1_000_000;
  return true;
}

export function chatEnd(tab: MixCodeTabInfo): boolean {
  clearChatScrollAnchor(tab);
  tab.chatScrollOffset = 0;
  return true;
}

export function clearChatScrollAnchor(tab: MixCodeTabInfo): void {
  tab.chatScrollAnchorEntryId = undefined;
  tab.chatScrollAnchorIndex = undefined;
  tab.chatScrollAnchorText = undefined;
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

// --- Active-overlay seam ---------------------------------------------------
//
// MixCodeState holds ~9 state-level overlays in heterogeneous shapes (top-level
// booleans, nested .open flags, presence-based picker). The invariant is
// "at most one active at a time". This seam concentrates the discriminant and
// mutual-exclusion that were previously spread across drifting OR-lists in
// app-input.ts / app-key-handlers.ts and an ad-hoc close-list in openQuitConfirm.

/** State-level overlays, in fixed priority order (mirrors app-input routing). */
export type OverlayKind =
  | "workspace"
  | "tree-selector"
  | "picker"
  | "session-selector"
  | "command-palette"
  | "extension-manager"
  | "tab-jump"
  | "session-action-confirm"
  | "quit-confirm"
  | "delete-all-sessions-confirm"
  | "close-all-sessions-confirm";

// Predicate per kind, evaluated in priority order by activeOverlay.
const OVERLAY_PREDICATES: ReadonlyArray<readonly [OverlayKind, (s: MixCodeState) => boolean]> = [
  ["workspace", (s) => s.workspaceOverlay.open],
  ["tree-selector", (s) => s.treeSelector.open],
  ["picker", (s) => s.picker !== undefined],
  ["session-selector", (s) => s.sessionSelector.open],
  ["command-palette", (s) => s.commandPaletteOpen],
  ["extension-manager", (s) => s.extensionManager.open],
  ["tab-jump", (s) => s.tabJumpOpen],
  ["session-action-confirm", (s) => s.sessionActionConfirm !== null],
  ["quit-confirm", (s) => s.quitConfirmOpen],
  ["delete-all-sessions-confirm", (s) => s.deleteAllSessionsConfirmOpen],
  ["close-all-sessions-confirm", (s) => s.closeAllSessionsConfirmOpen],
];

/** The single overlay currently active, or "none". Priority-ordered. */
export function activeOverlay(state: MixCodeState): OverlayKind | "none" {
  for (const [kind, isOpen] of OVERLAY_PREDICATES) {
    if (isOpen(state)) return kind;
  }
  return "none";
}

/** True when any state-level overlay is active. */
export function isOverlayActive(state: MixCodeState): boolean {
  return activeOverlay(state) !== "none";
}

/** Clear whichever overlay is active, leaving the rest untouched. */
export function closeActiveOverlay(state: MixCodeState): void {
  state.workspaceOverlay.open = false;
  state.treeSelector.open = false;
  state.picker = undefined;
  state.sessionSelector.open = false;
  closeCommandPalette(state);
  state.extensionManager.open = false;
  closeTabJump(state);
  state.sessionActionConfirm = null;
  state.quitConfirmOpen = false;
  state.deleteAllSessionsConfirmOpen = false;
  state.closeAllSessionsConfirmOpen = false;
}

// Flag/.open overlays openOverlay can flip on its own. picker is excluded: it
// is presence-based and needs a PickerState payload, so callers assign it
// directly (after closeActiveOverlay) rather than through openOverlay.
const FLAG_OPENERS: Partial<Record<OverlayKind, (s: MixCodeState) => void>> = {
  workspace: (s) => {
    s.workspaceOverlay.open = true;
  },
  "tree-selector": (s) => {
    s.treeSelector.open = true;
  },
  "session-selector": (s) => {
    s.sessionSelector.open = true;
  },
  "command-palette": openCommandPalette,
  "extension-manager": (s) => {
    s.extensionManager.open = true;
  },
  "tab-jump": openTabJump,
  "quit-confirm": (s) => {
    s.quitConfirmOpen = true;
  },
  "delete-all-sessions-confirm": (s) => {
    s.deleteAllSessionsConfirmOpen = true;
  },
  "close-all-sessions-confirm": (s) => {
    s.closeAllSessionsConfirmOpen = true;
  },
};

/**
 * Open a flag/.open overlay with mutual exclusion: any currently-active overlay
 * is closed first. picker is presence-based (needs a payload) and is opened by
 * direct assignment after closeActiveOverlay, not through this entry point.
 */
export type FlagOverlayKind = Exclude<OverlayKind, "picker" | "session-action-confirm">;

export function openOverlay(state: MixCodeState, kind: FlagOverlayKind): void {
  closeActiveOverlay(state);
  const open = FLAG_OPENERS[kind];
  if (!open) throw new Error(`openOverlay: unsupported kind ${kind}`);
  open(state);
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
  return ((index % entries.length) + entries.length) % entries.length;
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
  return entries.filter((_, index) => matched.has(searchKeys[index] ?? ""));
}

function commandPaletteBaseEntries(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }>,
): CommandPaletteEntry[] {
  if (state.activeTabId === "config") return configCommandPaletteEntries(state);
  const active = findActiveTab(state);
  if (!active) return [];
  return [
    ...agentCommandPaletteEntries(state, active),
    ...extensionCommandPaletteEntries(extensionCommands),
  ];
}

function configCommandPaletteEntries(state: MixCodeState): CommandPaletteEntry[] {
  const flags = {
    hasSession: false,
    hasModels: state.availableModels.length > 0,
    hasTabs: state.tabs.length > 0,
  };
  return LOCAL_COMMANDS.filter(
    (command) => command.palette && (command.palette.scope === "config" || command.palette.scope === "both"),
  ).map((command) =>
    paletteEntryFromCommand("config", command.name, command.description, command.palette!, flags),
  );
}

function agentCommandPaletteEntries(
  state: MixCodeState,
  active: MixCodeTabInfo,
): CommandPaletteEntry[] {
  const flags = {
    hasSession: Boolean(active.sessionId),
    hasModels: state.availableModels.length > 0,
    hasTabs: state.tabs.length > 0,
  };
  return LOCAL_COMMANDS.filter(
    (command) => command.palette && command.palette.scope !== "config",
  ).map((command) =>
    paletteEntryFromCommand("agent", command.name, command.description, command.palette!, flags),
  );
}

interface PaletteFlags {
  hasSession: boolean;
  hasModels: boolean;
  hasTabs: boolean;
}

/** Build a palette entry from a LOCAL_COMMANDS definition for the given view. */
function paletteEntryFromCommand(
  view: "agent" | "config",
  name: string,
  commandDescription: string,
  meta: LocalCommandPaletteMeta,
  flags: PaletteFlags,
): CommandPaletteEntry {
  const requires = view === "agent" ? meta.requires : meta.configRequires;
  const { enabled, disabledReason } = resolvePaletteRequirement(requires, flags);
  return commandEntry(
    `${view}.${name}`,
    meta.label,
    `/${name}`,
    meta.description ?? commandDescription,
    enabled,
    disabledReason,
  );
}

/** Resolve an enable-condition key against the current UI flags. */
function resolvePaletteRequirement(
  requires: PaletteRequirement | undefined,
  flags: PaletteFlags,
): { enabled: boolean; disabledReason: string } {
  switch (requires) {
    case "session":
      return { enabled: flags.hasSession, disabledReason: "Current tab has no active session" };
    case "session+models":
      return {
        enabled: flags.hasSession && flags.hasModels,
        disabledReason: !flags.hasSession
          ? "Current tab has no active session"
          : "No models loaded",
      };
    case "tabs":
      return { enabled: flags.hasTabs, disabledReason: "No open Agent Tabs" };
    default:
      return { enabled: true, disabledReason: "" };
  }
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
  // Derived from the single source of truth so extension commands can never
  // shadow a local command in the palette.
  return LOCAL_COMMANDS.map((command) => command.name);
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
