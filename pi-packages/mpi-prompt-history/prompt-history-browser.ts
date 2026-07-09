// ╔══════════════════════════════════════════════════════════════════════════════╗
// ║                Prompt History Browser: Search + Select UI                    ║
// ╠══════════════════════════════════════════════════════════════════════════════╣
// ║  Overlay Layout:                                                             ║
// ║                                                                              ║
// ║  ────────────────────────────────────────  <- Border                         ║
// ║   Prompt History (12)                      <- Title with count               ║
// ║                                                                              ║
// ║   Search: query_                           <- Search input with cursor       ║
// ║                                                                              ║
// ║   #12  This is the most recent prompt      <- Newest first                   ║
// ║   #11  Another prompt from earlier                                           ║
// ║   #10  Some older prompt text                                                ║
// ║                                                                              ║
// ║  ────────────────────────────────────────  <- Border                         ║
// ║   Enter select · ↑/↓ navigate · Esc close  <- Hint                           ║
// ║                                                                              ║
// ║  Keyboard:                                                                   ║
// ║    up/dn      Navigate items                                                 ║
// ║    Enter      Select -> return prompt text                                   ║
// ║    printable  Append to query (live filter)                                  ║
// ║    Backspace  Delete last query char                                         ║
// ║    Esc        Clear query, or close                                          ║
// ║                                                                              ║
// ╚══════════════════════════════════════════════════════════════════════════════╝

import { DynamicBorder, type Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";

// ─── Types ───────────────────────────────────────────────────────────────────

interface PromptItem {
  index: number; // Sequence number (newest = highest)
  text: string;
  searchText: string; // Lowercase for matching
  timestamp?: string; // ISO timestamp
  timeDisplay: string; // Formatted time string
}

interface BrowserState {
  selectedIndex: number;
  query: string;
}

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

function buildItems(rawItems: Array<{ entryId: string; text: string; timestamp?: string }>): PromptItem[] {
  // Reverse so newest is first, assign sequence numbers
  return rawItems
    .slice()
    .reverse()
    .map((item, idx) => ({
      index: rawItems.length - idx,
      text: item.text,
      searchText: item.text.toLowerCase(),
      timestamp: item.timestamp,
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

const HINT_TEXT = "Enter select · ↑/↓ navigate · Esc close";
const POINTER_ACTIVE = "❯ ";
const POINTER_INACTIVE = "  ";

function renderTitle(count: number, theme: Theme, width: number): string[] {
  const title = ` Prompt History (${count})`;
  return [truncateToWidth(theme.bold(title), width), ""];
}

function renderSearchLine(query: string, theme: Theme, width: number): string {
  const label = theme.fg("muted", " Search: ");
  const cursor = "\x1b[7m \x1b[27m"; // reverse-video space as cursor
  const body = query.length > 0 ? query : "";
  return truncateToWidth(`${label}${body}${cursor}`, width + 16);
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
  for (let i = start; i < end; i++) {
    const item = items[i];
    const selected = i === clampedIndex;
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
  items: Array<{ entryId: string; text: string; timestamp?: string }>;
  done: (result: string | null) => void;
}

export function createPromptHistoryBrowserComponent(config: PromptHistoryBrowserConfig): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { tui, theme, done } = config;
  const allItems = buildItems(config.items);
  const state: BrowserState = { selectedIndex: 0, query: "" };

  const visibleItems = (): PromptItem[] => filterItems(allItems, state.query);

  function selectedPrompt(): string | undefined {
    return visibleItems()[state.selectedIndex]?.text;
  }

  function printableChar(data: string): string | undefined {
    if (data.length === 0) return undefined;
    if (data.charCodeAt(0) < 0x20) return undefined;
    if (data === "\x7f") return undefined;
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
      const prompt = selectedPrompt();
      done(prompt ?? null);
      return;
    }

    if (matchesKey(data, Key.up)) {
      state.selectedIndex = Math.max(0, state.selectedIndex - 1);
      tui.requestRender();
      return;
    }

    if (matchesKey(data, Key.down)) {
      state.selectedIndex = Math.min(visibleItems().length - 1, state.selectedIndex + 1);
      tui.requestRender();
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
      lines.push(...renderTitle(allItems.length, theme, width));
      lines.push(renderSearchLine(state.query, theme, width));
      lines.push("");

      // Body height: cap at 60% of terminal
      const chromeRows = lines.length + 3;
      const byTerminal = Math.max(3, tui.terminal.rows - chromeRows);
      const byRatio = Math.max(3, Math.floor(tui.terminal.rows * 0.6));
      const maxVisible = Math.min(byTerminal, byRatio);

      lines.push(...renderList(visibleItems(), state.selectedIndex, theme, width, maxVisible));
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

export async function openPromptHistoryBrowser(
  items: Array<{ entryId: string; text: string; timestamp?: string }>,
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
    createPromptHistoryBrowserComponent({ tui, theme, items, done }),
  );
}
