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
// ║    Ctrl+G    cycle Session / Workdir / Global                                ║
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
  searchText: string; // Original text for regex matching
  timeDisplay: string; // Formatted time string
}

type Scope = "session" | "workdir" | "global";

type LoadableScope = Exclude<Scope, "session">;

interface BrowserState {
  selectedIndex: number;
  query: string;
  scope: Scope;
  searching: boolean;
  queryCursor: number;
}

/**
 * Workdir and Global items come off disk, so the browser renders a placeholder
 * while waiting for the history snapshot.
 */
type ScopeLoad =
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

function filterItems(
  items: PromptItem[],
  rawQuery: string,
): { items: PromptItem[]; error?: string } {
  const query = rawQuery.trim();
  if (query === "") return { items };

  let pattern: RegExp;
  try {
    pattern = new RegExp(query, "i");
  } catch (error: unknown) {
    return { items: [], error: error instanceof Error ? error.message : String(error) };
  }
  return { items: items.filter((item) => pattern.test(item.searchText)) };
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
        "Ctrl+G cycle",
        "q close",
      ];
  const line = () => parts.join(" · ");
  while (parts.length > 2 && visibleWidth(line()) > width) parts.splice(1, 1);
  return line();
}

function panelTitle(scope: Scope, count: string, workdir?: string): string {
  let label: string;
  if (scope === "session") {
    label = "Session";
  } else if (scope === "workdir") {
    label = workdir ? `Workdir: ${workdir}` : "Workdir";
  } else {
    label = "Global";
  }
  return `Prompt History — ${label} (${count})`;
}

function renderSearchLine(
  query: string,
  cursorPosition: number,
  searching: boolean,
  theme: Theme,
  width: number,
): string {
  const before = query.slice(0, cursorPosition);
  const atCursor = query[cursorPosition] ?? " ";
  const after = query.slice(cursorPosition + (cursorPosition < query.length ? 1 : 0));
  return truncateToWidth(
    `${theme.fg("muted", " Search: ")}${before}${searching ? `\x1b[7m${atCursor}\x1b[27m` : ""}${after}`,
    width,
  );
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
  /** Current working directory used by the Workdir scope. */
  workdir?: string;
  /** Supplies prompts recorded by sessions in the current workdir. */
  loadWorkdirItems?: () => Promise<Array<{ text: string; timestamp?: string }>>;
  /**
   * Supplies every recorded prompt for the Global scope. Omit both scope
   * loaders to disable the scope toggle entirely (Ctrl+G then does nothing).
   */
  loadGlobalItems?: () => Promise<Array<{ text: string; timestamp?: string }>>;
}

export function createPromptHistoryBrowserComponent(config: PromptHistoryBrowserConfig): {
  render(width: number): string[];
  invalidate(): void;
  handleInput(data: string): void;
} {
  const { tui, theme, done, copy, loadWorkdirItems, loadGlobalItems } = config;
  const sessionItems = buildItems(config.items);
  const state: BrowserState = {
    selectedIndex: 0,
    query: "",
    scope: "session",
    searching: false,
    queryCursor: 0,
  };
  const scopeLoads: Record<LoadableScope, ScopeLoad> = {
    workdir: { kind: "idle" },
    global: { kind: "idle" },
  };
  const scopeLoaders: Partial<
    Record<LoadableScope, () => Promise<Array<{ text: string; timestamp?: string }>>>
  > = {
    ...(loadWorkdirItems ? { workdir: loadWorkdirItems } : {}),
    ...(loadGlobalItems ? { global: loadGlobalItems } : {}),
  };
  let closed = false;
  let filterCache:
    | { items: PromptItem[]; query: string; result: { items: PromptItem[]; error?: string } }
    | undefined;

  function finish(result: string | null): void {
    closed = true;
    done(result);
  }

  function scopeItems(): PromptItem[] {
    if (state.scope === "session") return sessionItems;
    const load = scopeLoads[state.scope];
    return load.kind === "ready" ? load.items : [];
  }

  function availableScopes(): Scope[] {
    return [
      "session",
      ...(scopeLoaders.workdir ? ["workdir" as const] : []),
      ...(scopeLoaders.global ? ["global" as const] : []),
    ];
  }

  const filteredItems = (): { items: PromptItem[]; error?: string } => {
    const items = scopeItems();
    if (filterCache?.items === items && filterCache.query === state.query)
      return filterCache.result;
    const result = filterItems(items, state.query);
    filterCache = { items, query: state.query, result };
    return result;
  };

  const visibleItems = (): PromptItem[] => filteredItems().items;
  const searchError = (): string | undefined => filteredItems().error;

  function startScopeLoad(scope: LoadableScope): void {
    const loader = scopeLoaders[scope];
    if (!loader) return;
    scopeLoads[scope] = { kind: "loading" };
    // A load that lands after close must not build items for, or render into, a
    // component the host has already torn down.
    void loader().then(
      (items) => {
        if (closed) return;
        scopeLoads[scope] = { kind: "ready", items: buildItems(items) };
        tui.requestRender();
      },
      (error: unknown) => {
        if (closed) return;
        scopeLoads[scope] = {
          kind: "error",
          message: `Error: ${error instanceof Error ? error.message : String(error)}`,
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

    // Scope switching keeps the query so a search can be carried across scopes.
    if (matchesKey(data, Key.ctrl("g"))) {
      const scopes = availableScopes();
      if (scopes.length < 2) return;
      const currentIndex = scopes.indexOf(state.scope);
      const nextScope = scopes[(currentIndex + 1) % scopes.length]!;
      state.scope = nextScope;
      state.selectedIndex = 0;
      if (
        state.scope !== "session" &&
        (scopeLoads[state.scope].kind === "idle" || scopeLoads[state.scope].kind === "error")
      ) {
        startScopeLoad(state.scope);
      }
      tui.requestRender();
      return;
    }

    if (state.searching && matchesKey(data, Key.left)) {
      state.queryCursor = Math.max(0, state.queryCursor - 1);
      tui.requestRender();
      return;
    }
    if (state.searching && matchesKey(data, Key.right)) {
      state.queryCursor = Math.min(state.query.length, state.queryCursor + 1);
      tui.requestRender();
      return;
    }
    if (state.searching && matchesKey(data, Key.home)) {
      state.queryCursor = 0;
      tui.requestRender();
      return;
    }
    if (state.searching && matchesKey(data, Key.end)) {
      state.queryCursor = state.query.length;
      tui.requestRender();
      return;
    }

    const browsing = !state.searching;

    if (browsing && matchesKey(data, "/")) {
      state.searching = true;
      state.queryCursor = state.query.length;
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
        state.query =
          state.query.slice(0, state.queryCursor - 1) + state.query.slice(state.queryCursor);
        state.queryCursor -= 1;
        state.selectedIndex = 0;
        tui.requestRender();
      }
      return;
    }

    const ch = printableChar(data);
    if (ch !== undefined) {
      state.query =
        state.query.slice(0, state.queryCursor) + ch + state.query.slice(state.queryCursor);
      state.queryCursor += ch.length;
      state.selectedIndex = 0;
      tui.requestRender();
    }
  }

  return {
    render(width: number): string[] {
      const inner = Math.max(0, width - 2);
      const currentLoad = state.scope === "session" ? undefined : scopeLoads[state.scope];
      const pending = currentLoad !== undefined && currentLoad.kind !== "ready";
      const body: string[] = [""];
      if (state.searching || state.query.length > 0) {
        body.push(renderSearchLine(state.query, state.queryCursor, state.searching, theme, inner));
      }

      const maxVisible = maxVisibleRows();
      if (currentLoad?.kind === "loading") {
        const scopeLabel = state.scope === "workdir" ? "workdir" : "global";
        body.push(truncateToWidth(` ${theme.fg("dim", `Loading ${scopeLabel} history…`)}`, inner));
      } else if (currentLoad?.kind === "error") {
        body.push(truncateToWidth(` ${theme.fg("error", currentLoad.message)}`, inner));
      } else {
        const error = searchError();
        if (error) {
          body.push(truncateToWidth(` ${theme.fg("error", `Invalid regex: ${error}`)}`, inner));
        } else {
          body.push(...renderList(visibleItems(), state.selectedIndex, theme, inner, maxVisible));
        }
      }
      body.push("");

      return renderPanel(
        panelTitle(state.scope, pending ? "…" : String(scopeItems().length), config.workdir),
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
