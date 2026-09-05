import {
  LOCAL_COMMANDS,
  type LocalCommandPaletteMeta,
  type PaletteRequirement,
} from "./commands.js";
import { fuzzyFilter } from "@earendil-works/pi-tui";
import { fuzzyMatch, fuzzyMatchAllPositions } from "./fuzzy.js";
import { activateTab, findActiveTab } from "./tabs.js";
import {
  HOME_TAB_ID,
  type CommandPaletteEntry,
  type MixCodeState,
  type MixCodeTabInfo,
} from "./types.js";
import { tabIsNonIdle, tabIsWaitingForInput } from "./tab-state.js";
import { clearScrollFreeze } from "../ui/rendering/agent-surface-scroll.js";

export function scrollChat(tab: MixCodeTabInfo, delta: number): boolean {
  // Stick-to-bottom (offset 0) must not resurrect a freeze from an earlier turn.
  if (tab.chatScrollOffset === 0 && delta > 0) clearScrollFreeze(tab);
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
  tab.chatJumpToLatestHitRegion = undefined;
  return true;
}

export function clearChatScrollAnchor(tab: MixCodeTabInfo): void {
  tab.chatScrollAnchorEntryId = undefined;
  tab.chatScrollAnchorIndex = undefined;
  tab.chatScrollAnchorText = undefined;
}

export function tabJumpEntries(
  state: MixCodeState,
): Array<{ id: string; label: string; busy: boolean; done: boolean; waitingForInput: boolean }> {
  return [
    { id: HOME_TAB_ID, label: "MixCode Home", busy: false, done: false, waitingForInput: false },
    ...state.tabs.map((tab) => ({
      id: tab.sessionId,
      label: tab.title,
      busy: tab.status === "running" || tab.status === "thinking",
      done: tab.unreadDone,
      waitingForInput: tabIsWaitingForInput(tab),
    })),
  ];
}

export function filterTabJumpEntries(
  state: MixCodeState,
  query: string,
): ReturnType<typeof tabJumpEntries> {
  let entries = tabJumpEntries(state);
  if (state.tabJumpNonIdleOnly) {
    const attentionIds = new Set(state.tabs.filter(tabIsNonIdle).map((tab) => tab.sessionId));
    entries = entries.filter((entry) => attentionIds.has(entry.id));
  }
  if (!query.trim()) return entries;
  return fuzzyFilter(entries, query, (entry) => entry.label);
}

export function openTabJump(state: MixCodeState): void {
  state.tabJumpOpen = true;
  state.tabJumpQuery = "";
  state.tabJumpNonIdleOnly = false;
  state.tabJumpIndex = Math.max(
    0,
    filterTabJumpEntries(state, "").findIndex((entry) => entry.id === state.activeTabId),
  );
}

export function closeTabJump(state: MixCodeState): void {
  state.tabJumpOpen = false;
  state.tabJumpQuery = "";
  state.tabJumpIndex = 0;
  state.tabJumpNonIdleOnly = false;
}

export function toggleTabJumpNonIdleOnly(state: MixCodeState): void {
  state.tabJumpNonIdleOnly = !state.tabJumpNonIdleOnly;
  state.tabJumpIndex = clampTabJumpIndex(state, state.tabJumpIndex);
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
  | "settings-panel"
  | "extension-manager"
  | "tab-jump"
  | "session-action-confirm"
  | "quit-confirm"
  | "delete-all-sessions-confirm"
  | "close-all-sessions-confirm";

/** Unscoped overlays stay live; owned ones are live only on that tab. */
function overlayOwnerIsActive(state: MixCodeState, ownerSessionId: string | undefined): boolean {
  return !ownerSessionId || ownerSessionId === state.activeTabId;
}

export function pickerIsLive(state: MixCodeState): boolean {
  return state.picker !== undefined && overlayOwnerIsActive(state, state.picker.ownerSessionId);
}

export function sessionSelectorIsLive(state: MixCodeState): boolean {
  return (
    state.sessionSelector.open && overlayOwnerIsActive(state, state.sessionSelector.ownerSessionId)
  );
}

export function sessionActionConfirmIsLive(state: MixCodeState): boolean {
  return (
    state.sessionActionConfirm !== null &&
    overlayOwnerIsActive(state, state.sessionActionConfirm.sessionId)
  );
}

export function settingsPanelIsLive(state: MixCodeState): boolean {
  return (
    state.settingsPanel.open && overlayOwnerIsActive(state, state.settingsPanel.ownerSessionId)
  );
}

/** True when this tab opened a MixCode picker, confirm, or resume selector. */
export function tabOwnsWaitingAppOverlay(state: MixCodeState, sessionId: string): boolean {
  if (state.picker?.ownerSessionId === sessionId) return true;
  if (state.sessionActionConfirm?.sessionId === sessionId) return true;
  if (state.settingsPanel.open && state.settingsPanel.ownerSessionId === sessionId) return true;
  return state.sessionSelector.open && state.sessionSelector.ownerSessionId === sessionId;
}

/** Process-global overlays that are not owned by one tab. */
export function isInstanceOverlayOpen(state: MixCodeState): boolean {
  return (
    state.workspaceOverlay.open ||
    state.treeSelector.open ||
    state.commandPaletteOpen ||
    state.extensionManager.open ||
    state.tabJumpOpen ||
    state.quitConfirmOpen ||
    state.deleteAllSessionsConfirmOpen ||
    state.closeAllSessionsConfirmOpen
  );
}

// Predicate per kind, evaluated in priority order by activeOverlay.
const OVERLAY_PREDICATES: ReadonlyArray<readonly [OverlayKind, (s: MixCodeState) => boolean]> = [
  ["workspace", (s) => s.workspaceOverlay.open],
  ["tree-selector", (s) => s.treeSelector.open],
  ["picker", pickerIsLive],
  ["session-selector", sessionSelectorIsLive],
  ["command-palette", (s) => s.commandPaletteOpen],
  ["settings-panel", settingsPanelIsLive],
  ["extension-manager", (s) => s.extensionManager.open],
  ["tab-jump", (s) => s.tabJumpOpen],
  ["session-action-confirm", sessionActionConfirmIsLive],
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
  state.sessionSelector.dispose?.();
  state.sessionSelector.dispose = undefined;
  state.sessionSelector.open = false;
  closeCommandPalette(state);
  state.settingsPanel.open = false;
  state.extensionManager.open = false;
  closeTabJump(state);
  state.sessionActionConfirm = null;
  state.quitConfirmOpen = false;
  state.deleteAllSessionsConfirmOpen = false;
  state.closeAllSessionsConfirmOpen = false;
}

export type FlagOverlayKind =
  | "quit-confirm"
  | "delete-all-sessions-confirm"
  | "close-all-sessions-confirm";

export function openOverlay(state: MixCodeState, kind: FlagOverlayKind): void {
  closeActiveOverlay(state);
  if (kind === "quit-confirm") state.quitConfirmOpen = true;
  else if (kind === "delete-all-sessions-confirm") state.deleteAllSessionsConfirmOpen = true;
  else state.closeAllSessionsConfirmOpen = true;
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

export function commandPaletteEntriesWithExtensions(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): CommandPaletteEntry[] {
  const entries = commandPaletteBaseEntries(state, extensionCommands);
  const query = state.commandPalette.query.trim();
  if (!query) return entries;
  // Filter with the SAME per-token subsequence matcher the renderer uses to
  // highlight (fuzzyMatchAllPositions on the label and command columns), so a
  // row survives the filter iff at least one of its columns would light up.
  // Then rank by match quality so exact/prefix beats scattered subsequences
  // (e.g. "new" → New Session before Change Workdir).
  return entries
    .filter(
      (entry) =>
        fuzzyMatchAllPositions(query, entry.label).length > 0 ||
        fuzzyMatchAllPositions(query, entry.command).length > 0,
    )
    .sort((a, b) => commandPaletteMatchRank(query, b) - commandPaletteMatchRank(query, a));
}

/** Higher is better: contiguous/prefix hits beat sparse subsequence matches. */
function commandPaletteMatchRank(query: string, entry: CommandPaletteEntry): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const label = entry.label.toLowerCase();
  const command = entry.command.toLowerCase();
  let best = 0;
  for (const text of [label, command]) {
    if (text === q || text === `/${q}`) best = Math.max(best, 1000);
    else if (text.startsWith(q) || text.startsWith(`/${q}`)) best = Math.max(best, 800);
    else if (text.includes(q)) best = Math.max(best, 600);
    else {
      const score = fuzzyMatch(q, text);
      if (score !== undefined) best = Math.max(best, score);
    }
  }
  return best;
}

/** Entries the palette shows and that selection/accept must index into. */
export function selectableCommandPaletteEntries(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): CommandPaletteEntry[] {
  return commandPaletteEntriesWithExtensions(state, extensionCommands).filter(
    (entry) => entry.enabled,
  );
}

function commandPaletteBaseEntries(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }>,
): CommandPaletteEntry[] {
  if (state.activeTabId === HOME_TAB_ID) return homeCommandPaletteEntries(state);
  const active = findActiveTab(state);
  if (!active) return [];
  return [
    ...agentCommandPaletteEntries(state, active),
    ...extensionCommandPaletteEntries(extensionCommands),
  ];
}

function homeCommandPaletteEntries(state: MixCodeState): CommandPaletteEntry[] {
  const flags = {
    hasSession: false,
    hasModels: state.availableModels.length > 0,
    hasTabs: state.tabs.length > 0,
  };
  return LOCAL_COMMANDS.filter(
    (command) =>
      command.palette && (command.palette.scope === "home" || command.palette.scope === "both"),
  ).map((command) =>
    paletteEntryFromCommand(
      HOME_TAB_ID,
      command.name,
      command.description,
      command.palette!,
      flags,
    ),
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
    (command) => command.palette && command.palette.scope !== "home",
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
  view: "agent" | "home",
  name: string,
  commandDescription: string,
  meta: LocalCommandPaletteMeta,
  flags: PaletteFlags,
): CommandPaletteEntry {
  const requires = view === "agent" ? meta.requires : meta.configRequires;
  return commandEntry(
    `${view}.${name}`,
    meta.label,
    `/${name}`,
    meta.description ?? commandDescription,
    resolvePaletteRequirement(requires, flags),
  );
}

/** Resolve an enable-condition key against the current UI flags. */
function resolvePaletteRequirement(
  requires: PaletteRequirement | undefined,
  flags: PaletteFlags,
): boolean {
  switch (requires) {
    case "session":
      return flags.hasSession;
    case "session+models":
      return flags.hasSession && flags.hasModels;
    case "tabs":
      return flags.hasTabs;
    default:
      return true;
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
): CommandPaletteEntry {
  return {
    id,
    label,
    command,
    description,
    enabled,
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
  // Ranking reorders on every keystroke; keep the highlight on the new top hit.
  state.commandPalette.selectedIndex = 0;
}

export function moveCommandPaletteSelection(
  state: MixCodeState,
  delta: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): void {
  // Index against the same enabled-only list the renderer paints.
  const count = selectableCommandPaletteEntries(state, extensionCommands).length;
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
  const entries = selectableCommandPaletteEntries(state, extensionCommands);
  const selected =
    entries[
      clampCommandPaletteIndexWithExtensions(
        state,
        state.commandPalette.selectedIndex,
        extensionCommands,
      )
    ];
  closeCommandPalette(state);
  return selected?.command ?? "";
}

function clampCommandPaletteIndexWithExtensions(
  state: MixCodeState,
  index: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): number {
  const entries = selectableCommandPaletteEntries(state, extensionCommands);
  if (!entries.length) return 0;
  return Math.min(Math.max(index, 0), entries.length - 1);
}
