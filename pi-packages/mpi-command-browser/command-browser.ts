// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                command-browser: Grouped Command Browser Overlay              ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║                                                                              ║
// ║  Overlay Layout:                                                             ║
// ║                                                                              ║
// ║  ────────────────────────────────────────  <- DynamicBorder (accent)         ║
// ║   Extensions (3) | [Skills (12)] | Prompts   <- TabBar (with counts)         ║
// ║                                                                              ║
// ║   Search: mini_                              <- query (matches NAME only)    ║
// ║                                                                              ║
// ║   minimal-change  [u] Prefer smallest change <- [tag] = source               ║
// ║                                                                              ║
// ║  ────────────────────────────────────────  <- DynamicBorder (accent)         ║
// ║   Enter select . up/dn nav . Ctrl+H/L tab . Esc close  <- hint               ║
// ║                                                                              ║
// ║  Source tags: u=user  p=project  t=temporary  u:npm:foo=package              ║
// ║  Search matches the command NAME only, never the description.                ║
// ║                                                                              ║
// ║  Keyboard:                                                                   ║
// ║    up/dn      Navigate selectable items (skip headers)                       ║
// ║    Enter      Select -> setEditorText("/<cmd> ")                             ║
// ║    Ctrl+L     Next tab        Ctrl+H  Previous tab                           ║
// ║    printable  Append to query (live filter)                                  ║
// ║    Backspace  Delete last query char                                         ║
// ║    Esc        Clear query, or close                                          ║
// ║                                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CommandInfo {
  name: string;
  description?: string;
  source: "extension" | "prompt" | "skill";
  sourceInfo: { path: string; source: string; scope: string; origin: string; baseDir?: string };
}

interface GroupedItem {
  kind: "header" | "command";
  /** Text shown in the list (skill: prefix stripped for skills). */
  label: string;
  /** Lower-cased name used for search matching (name only, not description). */
  searchText: string;
  /** Short provenance tag, e.g. "u", "p", "u:npm:foo" (commands only). */
  sourceTag?: string;
  /** Underlying command (undefined for headers). */
  command?: CommandInfo;
}

type TabId = "extension" | "skill" | "prompt";

interface Tab {
  id: TabId;
  label: string;
  /** Full item list including group headers (built once at construction). */
  items: GroupedItem[];
}

// ─── Data Preparation ──────────────────────────────────────────────────────────
//
//  pi.getCommands()
//       |
//       |-- source === "extension" --> group by package --> Tab 0 (Extensions)
//       |-- source === "skill"     --> flat list        --> Tab 1 (Skills)
//       +-- source === "prompt"    --> flat list        --> Tab 2 (Prompts)
//

export function buildTabs(commands: CommandInfo[]): Tab[] {
  return [
    {
      id: "extension",
      label: "Extensions",
      items: buildExtensionItems(commands.filter((c) => c.source === "extension")),
    },
    { id: "skill", label: "Skills", items: buildFlatItems(commands.filter((c) => c.source === "skill")) },
    { id: "prompt", label: "Prompts", items: buildFlatItems(commands.filter((c) => c.source === "prompt")) },
  ];
}

/** Extensions tab: group commands by package name (sourceInfo.source / path). */
function buildExtensionItems(commands: CommandInfo[]): GroupedItem[] {
  const groups = new Map<string, CommandInfo[]>();
  for (const cmd of commands) {
    const key = extensionGroupKey(cmd.sourceInfo);
    const list = groups.get(key) ?? [];
    list.push(cmd);
    groups.set(key, list);
  }

  // Stable alphabetical headers so auto-discovered packages are scannable.
  const sortedKeys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  const items: GroupedItem[] = [];
  for (const groupName of sortedKeys) {
    items.push({ kind: "header", label: groupName, searchText: "" });
    for (const cmd of groups.get(groupName) ?? []) items.push(makeCommandItem(cmd));
  }
  return items;
}

/**
 * Package group label for the Extensions tab.
 * Auto-discovered packages report source:"auto" with baseDir=agent root; the
 * package name lives in path (.../extensions/<pkg>/index.ts). Prefer that.
 */
function extensionGroupKey(info: CommandInfo["sourceInfo"]): string {
  const source = info.source?.trim() ?? "";
  if (source && source !== "auto") return formatSourceName(source);
  // Prefer path: baseDir for auto packages is the agent dir (would group as "agent").
  const fromPath = packageNameFromExtensionPath(info.path);
  if (fromPath) return fromPath;
  const fromBase = packageNameFromExtensionPath(info.baseDir);
  if (fromBase) return fromBase;
  return source || "unknown";
}

/** Extract <pkg> from .../extensions/<pkg>/... or .../extensions/<pkg>. */
function packageNameFromExtensionPath(filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const parts = filePath.split(/[\\/]+/).filter(Boolean);
  const extIdx = parts.lastIndexOf("extensions");
  if (extIdx >= 0 && extIdx + 1 < parts.length) {
    const pkg = parts[extIdx + 1]!;
    // Guard against .../extensions/index.ts style noise.
    if (pkg && pkg !== "index.ts" && pkg !== "index.js" && !pkg.endsWith(".ts") && !pkg.endsWith(".js")) {
      return pkg;
    }
  }
  return undefined;
}

/** Skills / Prompts tab: flat list, no group headers. */
function buildFlatItems(commands: CommandInfo[]): GroupedItem[] {
  return commands.map(makeCommandItem);
}

/** Build a command item. Strips the "skill:" prefix from the displayed label. */
function makeCommandItem(cmd: CommandInfo): GroupedItem {
  const label = cmd.name.startsWith("skill:") ? cmd.name.slice("skill:".length) : cmd.name;
  // Search matches the name only (not the description), per product requirement.
  const searchText = label.toLowerCase();
  return { kind: "command", label, searchText, sourceTag: sourceTag(cmd.sourceInfo), command: cmd };
}

/**
 * Short provenance tag combining scope and package source, mirroring the Pi
 * autocomplete convention: "u" (user), "p" (project), "t" (temporary), with an
 * optional ":<package>" suffix for npm-sourced commands.
 */
function sourceTag(info: CommandInfo["sourceInfo"]): string {
  const scope = info.scope === "user" ? "u" : info.scope === "project" ? "p" : "t";
  const source = info.source?.trim();
  if (source?.startsWith("npm:")) return `${scope}:${formatSourceName(source)}`;
  return scope;
}

function formatSourceName(source: string): string {
  if (!source) return "unknown";
  if (source.startsWith("npm:")) {
    const pkg = source.slice("npm:".length);
    // Strip trailing version: @scope/name@1.2.3 -> @scope/name, name@1.2.3 -> name
    if (pkg.startsWith("@")) {
      const versionIdx = pkg.indexOf("@", pkg.indexOf("/") + 1);
      return versionIdx === -1 ? pkg : pkg.slice(0, versionIdx);
    }
    const versionIdx = pkg.lastIndexOf("@");
    return versionIdx <= 0 ? pkg : pkg.slice(0, versionIdx);
  }
  return source;
}

// ─── Search Filter ───────────────────────────────────────────────────────────
//
//  filterItems drops group headers and keeps only command rows whose name
//  (pre-computed searchText, lower-cased) contains the query as a substring.
//  Descriptions are intentionally NOT searched. Group headers are re-derived
//  afterwards so empty groups disappear.
//

export function filterItems(items: GroupedItem[], rawQuery: string): GroupedItem[] {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return items;

  // Keep matching commands, then re-attach headers that still have children.
  const result: GroupedItem[] = [];
  let pendingHeader: GroupedItem | undefined;
  let headerHasChild = false;

  for (const item of items) {
    if (item.kind === "header") {
      pendingHeader = item;
      headerHasChild = false;
      continue;
    }
    if (!item.searchText.includes(query)) continue;
    if (pendingHeader && !headerHasChild) {
      result.push(pendingHeader);
      headerHasChild = true;
    }
    result.push(item);
  }
  return result;
}

/** Extract just the selectable command rows from a (possibly filtered) item list. */
function commandRows(items: GroupedItem[]): GroupedItem[] {
  return items.filter((i) => i.kind === "command");
}

// ─── State ───────────────────────────────────────────────────────────────────

interface BrowserState {
  currentTab: number;
  selectedIndex: number;
  /** The single source of truth for the search query. */
  query: string;
}

// ─── Rendering ─────────────────────────────────────────────────────────────────

const HINT_TEXT = "Enter select · ↑/↓ navigate · Ctrl+H/L switch tab · Esc close";
const POINTER_ACTIVE = "❯ ";
const POINTER_INACTIVE = "  ";

function renderTabBar(tabs: Tab[], currentTab: number, theme: Theme, width: number): string[] {
  const parts: string[] = [];
  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];
    const count = commandRows(tab.items).length;
    const text = ` ${tab.label} (${count}) `;
    parts.push(i === currentTab ? theme.bg("selectedBg", theme.bold(text)) : theme.fg("dim", text));
    if (i < tabs.length - 1) parts.push(theme.fg("dim", "│"));
  }
  return [truncateToWidth(` ${parts.join("")}`, width), ""];
}

/** Render the self-managed search line with a fake block cursor at the end. */
function renderSearchLine(query: string, theme: Theme, width: number): string {
  const label = theme.fg("muted", " Search: ");
  const cursor = "\x1b[7m \x1b[27m"; // reverse-video space as cursor
  const body = query.length > 0 ? query : "";
  return truncateToWidth(`${label}${body}${cursor}`, width + 16); // +16 for ansi slack
}

function renderGroupedList(
  items: GroupedItem[],
  selectedIndex: number,
  theme: Theme,
  width: number,
  maxVisible: number,
): string[] {
  const selectable = commandRows(items);
  if (selectable.length === 0) {
    return [` ${theme.fg("dim", "No matching commands.")}`];
  }

  const clampedIndex = Math.max(0, Math.min(selectedIndex, selectable.length - 1));
  const selectedPos = positionOfNthCommand(items, clampedIndex);

  // Window centered on the selected row, clamped to bounds.
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, selectedPos - half);
  let end = Math.min(items.length, start + maxVisible);
  start = Math.max(0, end - maxVisible);

  const labelWidth = Math.min(
    28,
    Math.max(1, ...selectable.map((i) => visibleWidth(i.label))),
  );

  const lines: string[] = [];
  let cmdIdx = countCommandsBefore(items, start);
  for (let i = start; i < end; i++) {
    const item = items[i];
    if (item.kind === "header") {
      lines.push(truncateToWidth(` ${theme.fg("dim", `── ${item.label} ──`)}`, width));
      continue;
    }
    const selected = cmdIdx === clampedIndex;
    const name = item.label.padEnd(labelWidth);
    const pointer = selected ? theme.fg("accent", POINTER_ACTIVE) : POINTER_INACTIVE;
    const nameStr = selected ? theme.fg("accent", name) : name;
    const tagStr = item.sourceTag ? theme.fg("dim", `[${item.sourceTag}] `) : "";
    const descStr = theme.fg("muted", item.command?.description ?? "");
    lines.push(truncateToWidth(`${pointer}${nameStr}  ${tagStr}${descStr}`, width));
    cmdIdx++;
  }

  if (start > 0) lines.unshift(truncateToWidth(` ${theme.fg("dim", "↑ more")}`, width));
  if (end < items.length) lines.push(truncateToWidth(` ${theme.fg("dim", "↓ more")}`, width));
  return lines;
}

/** Index in `items` of the Nth command row (0-based n). */
function positionOfNthCommand(items: GroupedItem[], n: number): number {
  let count = 0;
  for (let i = 0; i < items.length; i++) {
    if (items[i].kind === "command") {
      if (count === n) return i;
      count++;
    }
  }
  return 0;
}

/** Number of command rows before index `pos`. */
function countCommandsBefore(items: GroupedItem[], pos: number): number {
  let count = 0;
  for (let i = 0; i < pos; i++) if (items[i].kind === "command") count++;
  return count;
}

// ─── Component ───────────────────────────────────────────────────────────────
//
//  Key routing (priority order). The query string is updated directly here,
//  so render() always reflects the latest keystroke — no dual state, no sync.
//
//  handleInput(data)
//       |
//       |-- Esc        --> clear query, or done(null) when query empty
//       |-- Enter      --> done(selected command name)
//       |-- up/dn      --> move selection
//       |-- Ctrl+L/H   --> next/prev tab (resets query + selection)
//       |-- Backspace  --> drop last query char
//       +-- printable  --> append to query, reset selection
//

export interface CommandBrowserConfig {
  tui: { terminal: { columns: number; rows: number }; requestRender(): void };
  theme: Theme;
  commands: CommandInfo[];
  done: (result: string | null) => void;
}

export function createCommandBrowserComponent(config: CommandBrowserConfig): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { tui, theme, commands, done } = config;
  const tabs = buildTabs(commands);
  const state: BrowserState = { currentTab: 0, selectedIndex: 0, query: "" };

  const visibleItems = (): GroupedItem[] => filterItems(tabs[state.currentTab]?.items ?? [], state.query);
  const selectableCount = (): number => commandRows(visibleItems()).length;

  function selectedCommand(): CommandInfo | undefined {
    return commandRows(visibleItems())[state.selectedIndex]?.command;
  }

  function switchTab(delta: number): void {
    state.currentTab = (state.currentTab + delta + tabs.length) % tabs.length;
    state.selectedIndex = 0;
    state.query = "";
    tui.requestRender();
  }

  /** Recognize a single printable character (ASCII + common UTF-8) for the query. */
  function printableChar(data: string): string | undefined {
    if (data.length === 0) return undefined;
    // Reject control sequences (escape codes start with ESC = 0x1b).
    if (data.charCodeAt(0) < 0x20) return undefined;
    if (data === "\x7f") return undefined; // DEL/backspace
    // Multi-byte escape sequences contain a leading ESC handled above; a lone
    // printable grapheme is accepted as-is (supports pasted text too).
    return data;
  }

  function handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (state.query.length > 0) {
        state.query = "";
        state.selectedIndex = 0;
        tui.requestRender();
      } else {
        done(null);
      }
      return;
    }
    if (matchesKey(data, Key.enter)) {
      const cmd = selectedCommand();
      done(cmd ? cmd.name : null);
      return;
    }
    if (matchesKey(data, Key.up)) {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.down)) {
      state.selectedIndex = Math.min(selectableCount() - 1, state.selectedIndex + 1);
      tui.requestRender();
      return;
    }
    if (matchesKey(data, Key.ctrl("l"))) {
      switchTab(1);
      return;
    }
    if (matchesKey(data, Key.ctrl("h"))) {
      switchTab(-1);
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      if (state.query.length > 0) {
        state.query = state.query.slice(0, -1);
        state.selectedIndex = 0;
        tui.requestRender();
      }
      return;
    }
    const ch = printableChar(data);
    if (ch !== undefined) {
      state.query += ch;
      state.selectedIndex = 0;
      tui.requestRender();
    }
  }

  return {
    render(width: number): string[] {
      const border = new DynamicBorder((s: string) => theme.fg("accent", s));
      const lines: string[] = [];
      lines.push(...border.render(width));
      lines.push(...renderTabBar(tabs, state.currentTab, theme, width));
      lines.push(renderSearchLine(state.query, theme, width));
      lines.push("");

      // Body height: cap at 60% of terminal, leave room for chrome.
      const chromeRows = lines.length + 3; // spacer + bottom border + hint
      const byTerminal = Math.max(3, tui.terminal.rows - chromeRows);
      const byRatio = Math.max(3, Math.floor(tui.terminal.rows * 0.6));
      const maxVisible = Math.min(byTerminal, byRatio);

      lines.push(...renderGroupedList(visibleItems(), state.selectedIndex, theme, width, maxVisible));
      lines.push("");
      lines.push(...border.render(width));
      lines.push(` ${theme.fg("dim", truncateToWidth(HINT_TEXT, width - 2))}`);
      return lines;
    },
    invalidate(): void {},
    handleInput,
  };
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function openCommandBrowser(
  commands: CommandInfo[],
  ctx: {
    ui: {
      custom<T>(
        factory: (
          tui: { terminal: { columns: number; rows: number }; requestRender(): void },
          theme: Theme,
          keybindings: unknown,
          done: (result: T) => void,
        ) => { render(width: number): string[]; invalidate(): void; handleInput(data: string): void },
        options?: { overlay?: boolean },
      ): Promise<T>;
    };
  },
): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, _kb, done) =>
    createCommandBrowserComponent({ tui, theme, commands, done }),
  );
}
