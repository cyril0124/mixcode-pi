// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                Prompt history overlay                                        ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║  Layout                                                                      ║
// ║                                                                              ║
// ║  ┌ Prompt History — Session (12) ─────────┐                                  ║
// ║  │                                        │                                  ║
// ║  │ ❯ #12  This is the most recent prompt  │                                  ║
// ║  │   #11  Another prompt from earlier     │                                  ║
// ║  │                                        │                                  ║
// ║  ├────────────────────────────────────────┤                                  ║
// ║  │ j/k move · / search · q close          │                                  ║
// ║  └────────────────────────────────────────┘                                  ║
// ║                                                                              ║
// ║  Keyboard:                                                                   ║
// ║    j/k ↑/↓   next / previous item                                            ║
// ║    Ctrl+D/U  half page down / up                                             ║
// ║    g/G       first / last item                                               ║
// ║    /         open search                                                     ║
// ║    Enter     insert selected prompt                                          ║
// ║    c         copy selected prompt to clipboard                               ║
// ║    Ctrl+G    toggle Session / Global                                         ║
// ║    Esc       cancel search, or close                                         ║
// ║    q         close                                                           ║
// ║                                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PromptItem {
  index: number; // Sequence number (newest = highest)
  text: string;
  searchText: string; // Lowercase for matching
  timeDisplay: string; // Formatted time string
}

type Scope = "session" | "global";

interface BrowserState {
  selectedIndex: number;
  query: string;
  scope: Scope;
  searching: boolean;
}

/**
 * Global items come off disk, so the browser renders a placeholder instead of
 * blocking a frame on a multi-megabyte parse.
 */
type GlobalLoad =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; items: PromptItem[] }
  | { kind: "error"; message: string };

// ─── Data Preparation ────────────────────────────────────────────────────────

function formatTime(timestamp?: string): string {
  if (!timestamp) return "";

  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

  // Relative time
  let relative: string;
  if (diffSecs < 60) {
    relative = `${diffSecs}s ago`;
  } else if (diffMins < 60) {
    relative = `${diffMins}m ago`;
  } else if (diffHours < 24) {
    relative = `${diffHours}h ago`;
  } else {
    relative = `${diffDays}d ago`;
  }

  // Absolute time
  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  const absolute = `${hours}:${mins}`;

  // Same day: only show time, otherwise show date too
  const isToday = date.toDateString() === now.toDateString();
  const absoluteFull = isToday
    ? absolute
    : `${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")} ${absolute}`;

  return `${relative} (${absoluteFull})`;
}

function buildItems(rawItems: Array<{ text: string; timestamp?: string }>): PromptItem[] {
  // Reverse so newest is first, assign sequence numbers
  return rawItems
    .slice()
    .reverse()
    .map((item, idx) => ({
      index: rawItems.length - idx,
      text: item.text,
      searchText: item.text.toLowerCase(),
      timeDisplay: formatTime(item.timestamp),
    }));
}

// ─── Search Filter ───────────────────────────────────────────────────────────

function filterItems(items: PromptItem[], rawQuery: string): PromptItem[] {
  const query = rawQuery.trim().toLowerCase();
  if (query === "") return items;
  return items.filter((item) => item.searchText.includes(query));
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const POINTER_ACTIVE = "❯ ";
const POINTER_INACTIVE = "  ";
/** Top border, inner pads, footer rule, hint, bottom border. */
const CHROME_BASE = 6;

function hintText(searching: boolean, width: number): string {
  const parts = searching
    ? ["Enter select", "↑/↓ navigate", "Esc cancel"]
    : [
        "j/k move",
        "Enter select",
        "c copy",
        "Ctrl+D/U page",
        "g/G top/bot",
        "/ search",
        "Ctrl+G scope",
        "q close",
      ];
  const line = () => parts.join(" · ");
  while (parts.length > 2 && visibleWidth(line()) > width) parts.splice(1, 1);
  return line();
}

function panelTitle(scope: Scope, count: string): string {
  const label = scope === "session" ? "Session" : "Global";
  return `Prompt History — ${label} (${count})`;
}

function renderSearchLine(query: string, searching: boolean, theme: Theme, width: number): string {
  const label = theme.fg("muted", " Search: ");
  const cursor = searching ? "\x1b[7m \x1b[27m" : "";
  return truncateToWidth(`${label}${query}${cursor}`, width);
}

function padVisible(text: string, width: number): string {
  const clipped = visibleWidth(text) <= width ? text : truncateToWidth(text, width);
  return clipped + " ".repeat(Math.max(0, width - visibleWidth(clipped)));
}

function renderPanel(
  title: string,
  body: string[],
  footer: string,
  theme: Theme,
  width: number,
): string[] {
  const inner = Math.max(0, width - 2);
  const edge = (text: string) => theme.fg("accent", text);
  const heading = ` ${title} `;
  const clipped = visibleWidth(heading) > inner ? truncateToWidth(heading, inner) : heading;
  const fill = "─".repeat(Math.max(0, inner - visibleWidth(clipped)));
  const row = (text: string) => `${edge("│")}${padVisible(text, inner)}${edge("│")}`;
  return [
    `${edge("┌")}${edge(clipped + fill)}${edge("┐")}`,
    ...body.map(row),
    `${edge("├")}${edge("─".repeat(inner))}${edge("┤")}`,
    row(` ${footer}`),
    `${edge("└")}${edge("─".repeat(inner))}${edge("┘")}`,
  ];
}

function renderList(
  items: PromptItem[],
  selectedIndex: number,
  theme: Theme,
  width: number,
  maxVisible: number,
): string[] {
  if (items.length === 0) {
    return [` ${theme.fg("dim", "No matching prompts.")}`];
  }

  const clampedIndex = Math.max(0, Math.min(selectedIndex, items.length - 1));

  // Window centered on selection
  const half = Math.floor(maxVisible / 2);
  let start = Math.max(0, clampedIndex - half);
  let end = Math.min(items.length, start + maxVisible);
  start = Math.max(0, end - maxVisible);

  const lines: string[] = [];
  for (const [offset, item] of items.slice(start, end).entries()) {
    const selected = start + offset === clampedIndex;
    const num = theme.fg("dim", `#${item.index.toString().padStart(2, " ")}`);
    const pointer = selected ? theme.fg("accent", POINTER_ACTIVE) : POINTER_INACTIVE;

    // Time display
    const time = item.timeDisplay ? theme.fg("muted", ` [${item.timeDisplay}]`) : "";

    // Truncate long prompts to fit time + text
    const displayText = item.text.replace(/\n/g, " ");
    const textStr = selected ? theme.fg("accent", displayText) : displayText;

    lines.push(truncateToWidth(`${pointer}${num}${time}  ${textStr}`, width));
  }

  if (start > 0) lines.unshift(truncateToWidth(` ${theme.fg("dim", "↑ more")}`, width));
  if (end < items.length) lines.push(truncateToWidth(` ${theme.fg("dim", "↓ more")}`, width));

  return lines;
}

// ─── Component ───────────────────────────────────────────────────────────────

export interface PromptHistoryBrowserConfig {
  tui: { terminal: { columns: number; rows: number }; requestRender(): void };
  theme: Theme;
  items: Array<{ text: string; timestamp?: string }>;
  done: (result: string | null) => void;
  /** Copies the selected prompt when `c` is pressed; the browser then closes. */
  copy?: (text: string) => void;
  /**
   * Supplies every recorded prompt for the Global scope. Omit to disable the
   * scope toggle entirely (Ctrl+G then does nothing).
   */
  loadGlobalItems?: () => Promise<Array<{ text: string; timestamp?: string }>>;
}

export function createPromptHistoryBrowserComponent(config: PromptHistoryBrowserConfig): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { tui, theme, done, copy, loadGlobalItems } = config;
  const sessionItems = buildItems(config.items);
  const state: BrowserState = { selectedIndex: 0, query: "", scope: "session", searching: false };
  let globalLoad: GlobalLoad = { kind: "idle" };
  let closed = false;

  function finish(result: string | null): void {
    closed = true;
    done(result);
  }

  function scopeItems(): PromptItem[] {
    if (state.scope === "session") return sessionItems;
    return globalLoad.kind === "ready" ? globalLoad.items : [];
  }

  const visibleItems = (): PromptItem[] => filterItems(scopeItems(), state.query);

  function startGlobalLoad(): void {
    if (!loadGlobalItems) return;
    globalLoad = { kind: "loading" };
    // A load that lands after close must not build items for, or render into, a
    // component the host has already torn down.
    void loadGlobalItems().then(
      (items) => {
        if (closed) return;
        globalLoad = { kind: "ready", items: buildItems(items) };
        tui.requestRender();
      },
      (error: unknown) => {
        if (closed) return;
        globalLoad = {
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        };
        tui.requestRender();
      },
    );
  }

  function selectedPrompt(): string | undefined {
    return visibleItems()[state.selectedIndex]?.text;
  }

  function printableChar(data: string): string | undefined {
    if (data.length === 0) return undefined;
    if (data.charCodeAt(0) < 0x20) return undefined;
    if (data === "\x7f") return undefined;
    return data;
  }

  function maxVisibleRows(): number {
    const searchRow = state.searching || state.query.length > 0 ? 1 : 0;
    const byTerminal = Math.max(3, tui.terminal.rows - CHROME_BASE - searchRow);
    const byRatio = Math.max(3, Math.floor(tui.terminal.rows * 0.6));
    return Math.min(byTerminal, byRatio);
  }

  function moveSelection(delta: number, wrap: boolean): void {
    const count = visibleItems().length;
    if (count === 0) return;
    if (wrap) {
      state.selectedIndex = (state.selectedIndex + delta + count) % count;
    } else {
      state.selectedIndex = Math.max(0, Math.min(count - 1, state.selectedIndex + delta));
    }
    tui.requestRender();
  }

  function handleInput(data: string): void {
    if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (state.searching) {
        state.searching = false;
        state.query = "";
        state.selectedIndex = 0;
        tui.requestRender();
        return;
      }
      finish(null);
      return;
    }

    if (matchesKey(data, Key.enter)) {
      const prompt = selectedPrompt();
      // Empty filter: stay open so the user can refine the query (Esc still closes).
      if (prompt === undefined) return;
      finish(prompt);
      return;
    }

    // Scope toggle keeps the query so a search can be carried across scopes.
    if (matchesKey(data, Key.ctrl("g"))) {
      if (!loadGlobalItems) return;
      state.scope = state.scope === "session" ? "global" : "session";
      state.selectedIndex = 0;
      // Retry on re-entry after a failure, otherwise a single bad read would
      // pin the frozen error until the browser is closed and reopened.
      if (state.scope === "global" && (globalLoad.kind === "idle" || globalLoad.kind === "error")) {
        startGlobalLoad();
      }
      tui.requestRender();
      return;
    }

    const browsing = !state.searching;

    if (browsing && matchesKey(data, "/")) {
      state.searching = true;
      tui.requestRender();
      return;
    }

    if (browsing && matchesKey(data, "q")) {
      finish(null);
      return;
    }

    if (browsing && copy && matchesKey(data, "c")) {
      const prompt = selectedPrompt();
      if (prompt === undefined) return;
      copy(prompt);
      finish(null);
      return;
    }

    if (matchesKey(data, Key.up) || (browsing && matchesKey(data, "k"))) {
      moveSelection(-1, true);
      return;
    }
    if (matchesKey(data, Key.down) || (browsing && matchesKey(data, "j"))) {
      moveSelection(1, true);
      return;
    }

    if (matchesKey(data, "ctrl+d")) {
      moveSelection(Math.max(1, Math.floor(maxVisibleRows() / 2)), false);
      return;
    }
    if (matchesKey(data, "ctrl+u")) {
      moveSelection(-Math.max(1, Math.floor(maxVisibleRows() / 2)), false);
      return;
    }

    if (browsing && matchesKey(data, "g")) {
      state.selectedIndex = 0;
      tui.requestRender();
      return;
    }
    if (browsing && matchesKey(data, "shift+g")) {
      const count = visibleItems().length;
      if (count > 0) state.selectedIndex = count - 1;
      tui.requestRender();
      return;
    }

    if (browsing) return;

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
      const inner = Math.max(0, width - 2);
      const pending = state.scope === "global" && globalLoad.kind !== "ready";
      const body: string[] = [""];
      if (state.searching || state.query.length > 0) {
        body.push(renderSearchLine(state.query, state.searching, theme, inner));
      }

      const maxVisible = maxVisibleRows();
      if (state.scope === "global" && globalLoad.kind === "loading") {
        body.push(truncateToWidth(` ${theme.fg("dim", "Loading global history…")}`, inner));
      } else if (state.scope === "global" && globalLoad.kind === "error") {
        body.push(truncateToWidth(` ${theme.fg("error", globalLoad.message)}`, inner));
      } else {
        body.push(...renderList(visibleItems(), state.selectedIndex, theme, inner, maxVisible));
      }
      body.push("");

      return renderPanel(
        panelTitle(state.scope, pending ? "…" : String(scopeItems().length)),
        body,
        hintText(state.searching, inner - 1),
        theme,
        width,
      );
    },
    invalidate(): void {},
    handleInput,
  };
}
