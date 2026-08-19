import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import pkg from "../../../package.json" with { type: "json" };
import {
  fuzzyMatchAllPositions,
  fuzzyMatchPositions,
  substringMatchPositions,
} from "../../core/fuzzy.js";
import {
  filterTabJumpEntries,
  selectableCommandPaletteEntries,
  tabJumpEntries,
} from "../../core/overlays.js";
import { filteredPickerItems, workdirBreadcrumb } from "../../core/pickers.js";
import { activeToast } from "../../core/toast.js";
import type { MixCodeState, PreviewMessage } from "../../core/types.js";
import { tabIsWaitingForInput } from "../../core/tab-state.js";
import { type MixCodeTheme, themeForId } from "../themes.js";
import { exactContextUsageText, tabStatusGlyph } from "./chrome.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { highlightRanges } from "./highlight.js";
import { centerLine } from "./layout.js";
import { overlayPanel, padLine, renderBoxTop } from "./primitives.js";
import { applyToastOverlay } from "./toast-overlay.js";
import { halfScreenRows, windowStart } from "./scroll-window.js";

/** Shared match style for dynamic fuzzy-search highlighting across overlays: bold + accent. */
function matchHighlight(text: string): string {
  return activeRenderTheme.bold(activeRenderTheme.accent(text));
}

export function renderHome(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
  rowOffset = 0,
  maxRows?: number,
): string[] {
  return renderWithTheme(theme, () => renderHomeInner(state, width, rowOffset, maxRows));
}

function renderHomeInner(
  state: MixCodeState,
  width: number,
  rowOffset: number,
  maxRows?: number,
): string[] {
  const logo = [
    "███╗   ███╗██╗██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗",
    "████╗ ████║██║╚██╗██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "██╔████╔██║██║ ╚███╔╝ ██║     ██║   ██║██║  ██║█████╗  ",
    "██║╚██╔╝██║██║ ██╔██╗ ██║     ██║   ██║██║  ██║██╔══╝  ",
    "██║ ╚═╝ ██║██║██╔╝ ██╗╚██████╗╚██████╔╝██████╔╝███████╗",
    "╚═╝     ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
  ];
  const bodyWidth = Math.max(1, width - 6);
  const updateRows = renderPackageUpdateNotice(state.packageUpdates, bodyWidth);
  // Hide logo when terminal is too small to fit logo + at least 1 card + preview,
  // or too narrow to show the full banner without width-clipping into garbage.
  const LOGO_ROWS = logo.length + 2; // logo lines + blank before + blank after
  const MIN_ROWS_FOR_LOGO = LOGO_ROWS + AGENT_CARD_HEIGHT + AGENT_CARD_CHROME_ROWS + 3; // + panel chrome
  const MIN_COLS_FOR_LOGO = 54 + 6; // banner width + panel padding/borders
  const showLogo =
    width >= MIN_COLS_FOR_LOGO &&
    (maxRows === undefined || maxRows >= MIN_ROWS_FOR_LOGO + updateRows.length);
  const logoLines = showLogo
    ? ["", ...logo.map((line) => centerLine(activeRenderTheme.accent(line), Math.max(1, width - 2))), ""]
    : [""];
  const staticBodyRows = logoLines.length + updateRows.length;
  // configPanelBox adds a leading spacer, top border, and bottom border around body rows.
  const maxAgentRows =
    maxRows === undefined ? undefined : Math.max(0, maxRows - 3 - staticBodyRows);
  const agentTableRows = renderAgentViewTable(state, bodyWidth, maxAgentRows);
  const lines = [
    ...logoLines,
    ...updateRows.map((line) => `  ${line}`),
    ...agentTableRows.map((line) => `  ${line}`),
  ];
  const framed = fitConfigRows(configPanelBox("", lines, width, [`v${pkg.version}`]), maxRows, width);
  // Home has no agent surface — paint the selected agent tab's toast here so
  // pushToast(getActiveTab()) remains visible while activeTabId is home.
  const selected = state.tabs[state.homeSelectedTabIndex];
  if (!selected) return framed;
  const height = maxRows === undefined ? framed.length : Math.max(framed.length, Math.floor(maxRows));
  return applyToastOverlay(framed, activeToast(selected), width, height, activeRenderTheme);
}

function fitConfigRows(lines: string[], maxRows: number | undefined, width: number): string[] {
  void width;
  if (maxRows === undefined) return lines;
  return lines.slice(0, Math.max(0, Math.floor(maxRows)));
}

function configPanelBox(title: string, lines: string[], width: number, meta: string[] = []): string[] {
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, meta, innerWidth, {
    ...activeRenderTheme,
    border: activeRenderTheme.borderMuted,
  }, true);
  const body = lines.map(
    (line) =>
      `${activeRenderTheme.borderMuted("│")}${padLine(line, innerWidth)}${activeRenderTheme.borderMuted("│")}`,
  );
  const bottom = `${activeRenderTheme.borderMuted("╰")}${activeRenderTheme.borderMuted("─".repeat(innerWidth))}${activeRenderTheme.borderMuted("╯")}`;
  return [padLine("", width), top, ...body, bottom];
}

const AGENT_CARD_HEIGHT = 4;
const AGENT_CARD_CHROME_ROWS = 3;
const AGENT_VIEW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const AGENT_VIEW_SPINNER_INTERVAL_MS = 80;

function renderAgentViewTable(state: MixCodeState, width: number, maxRows?: number): string[] {
  const budget = maxRows === undefined ? undefined : Math.max(0, Math.floor(maxRows));
  if (state.tabs.length === 0) {
    return fitAgentRows(
      [
        "",
        activeRenderTheme.bold(" Agents"),
        activeRenderTheme.dim("  No agent sessions. Use the command palette to start one."),
      ],
      budget,
    );
  }

  const lines: string[] = [];
  pushAgentRows(lines, ["", activeRenderTheme.bold(" Agents")], budget);
  const selectedIndex = Math.min(state.homeSelectedTabIndex, state.tabs.length - 1);
  const now = Date.now();
  const hint = activeRenderTheme.dim("  ↑/↓: select  →: attach  Enter: send  Tab: cycle tabs");

  // Cards are the anchor of Agent View; preview and hint use the remaining rows.
  // Always prefer keeping the navigation hint over eating the last row with a
  // partial card or preview panel (short terminals must keep onboarding keys).
  const rowsAfterHeader = budget === undefined ? undefined : Math.max(0, budget - lines.length);
  const previewAndHintReserve =
    rowsAfterHeader !== undefined && rowsAfterHeader >= AGENT_CARD_HEIGHT + 3 ? 3 : 0;
  const availableForCards =
    rowsAfterHeader === undefined ? undefined : Math.max(0, rowsAfterHeader - previewAndHintReserve);
  const totalCards = state.tabs.length;
  const fitsAllCards =
    availableForCards === undefined || totalCards * AGENT_CARD_HEIGHT <= availableForCards;
  const markerReserve =
    !fitsAllCards && availableForCards !== undefined && availableForCards >= AGENT_CARD_HEIGHT
      ? 2
      : 0;
  const maxCards =
    availableForCards === undefined
      ? totalCards
      : Math.max(0, Math.floor((availableForCards - markerReserve) / AGENT_CARD_HEIGHT));
  // Leave one row for the hint whenever any space remains after the header.
  const cardBudget =
    budget === undefined
      ? undefined
      : Math.max(lines.length, budget - (budget > lines.length ? 1 : 0));
  const { start, end } = agentCardWindow(totalCards, selectedIndex, maxCards);
  const showAbove = maxCards > 0 && start > 0;
  const showBelow = maxCards > 0 && end < totalCards;
  const listBudget =
    cardBudget === undefined ? undefined : Math.max(0, cardBudget - (showAbove ? 1 : 0) - (showBelow ? 1 : 0));
  if (showAbove) {
    pushAgentRows(lines, [agentWindowMarker("↑ older above", width)], budget);
  }
  if (maxCards === 0 && rowsAfterHeader !== undefined && rowsAfterHeader > 0) {
    pushAgentRows(lines, renderAgentCard(state.tabs[selectedIndex]!, width, true, now), cardBudget);
  } else {
    for (let i = start; i < end; i++) {
      const card = renderAgentCard(state.tabs[i]!, width, i === selectedIndex, now);
      if (listBudget !== undefined && lines.length + card.length > listBudget) break;
      lines.push(...card);
    }
  }
  if (showBelow) {
    pushAgentRows(lines, [agentWindowMarker("↓ newer below", width)], budget);
  }

  const selectedTab = state.tabs[selectedIndex];
  const remainingRows = budget === undefined ? undefined : Math.max(0, budget - lines.length);
  const previewRows = remainingPreviewRows(remainingRows);
  if (selectedTab && previewRows > 0) {
    pushAgentRows(lines, renderPreviewPanel(selectedTab, width, previewRows), budget);
  }
  pushAgentRows(lines, [hint], budget);
  return lines;
}

function remainingPreviewRows(remainingRows: number | undefined): number {
  if (remainingRows === undefined) return 6; // divider + 5 recent messages
  // Prefer the navigation hint over preview whenever any room remains.
  if (remainingRows <= 1) return 0;
  return remainingRows - 1;
}

function pushAgentRows(lines: string[], rows: string[], budget: number | undefined): void {
  const remaining = budget === undefined ? rows.length : Math.max(0, budget - lines.length);
  lines.push(...rows.slice(0, remaining));
}

function fitAgentRows(lines: string[], budget: number | undefined): string[] {
  if (budget === undefined) return lines;
  return lines.slice(0, budget);
}

function agentWindowMarker(label: string, width: number): string {
  return activeRenderTheme.dim(padLine(`  ${label}`, width));
}

function agentCardWindow(
  total: number,
  selectedIndex: number,
  visibleCount: number,
): { start: number; end: number } {
  if (visibleCount <= 0) return { start: selectedIndex, end: selectedIndex };
  const count = Math.min(total, visibleCount);
  const half = Math.floor(count / 2);
  const start = Math.min(Math.max(0, selectedIndex - half), Math.max(0, total - count));
  return { start, end: start + count };
}

function renderAgentCard(
  tab: MixCodeState["tabs"][number],
  width: number,
  selected: boolean,
  now: number,
): string[] {
  const border = selected ? activeRenderTheme.accent : activeRenderTheme.borderMuted;
  const innerWidth = Math.max(0, width - 2);
  const marker = selected ? "› " : "";
  const status = formatTabStatusChip(tab);
  const spinner = formatAgentSpinner(tab, now);
  const statusGroup = spinner ? `${spinner} ${status}` : status;
  const titleBudget = Math.max(
    1,
    innerWidth - visibleWidth(marker) - 2 - visibleWidth(statusGroup) - 3,
  );
  const titleSegment = formatAgentCardTitleSegment(
    tab,
    `${tabStatusGlyph(tab)} ${truncateToWidth(tab.title, titleBudget, "...")}`,
  );
  const title = `${marker}${titleSegment}`;
  const titleFill = Math.max(0, innerWidth - visibleWidth(title) - visibleWidth(statusGroup) - 2);
  const top = `${border("┌")}${title} ${border("─".repeat(titleFill))} ${statusGroup}${border("┐")}`;
  const meta = truncateToWidth(` ${formatAgentCardMeta(tab)}`, innerWidth, "...");
  const preview = truncateToWidth(` ⎿ ${latestAssistantPreview(tab)}`, innerWidth, "...");
  const lines = [
    top,
    `${border("│")}${padLine(meta, innerWidth)}${border("│")}`,
    `${border("│")}${activeRenderTheme.dim(padLine(preview, innerWidth))}${border("│")}`,
    `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
  ];
  return selected ? lines.map((line) => activeRenderTheme.selectedBg(padLine(line, width))) : lines;
}

function renderPreviewPanel(
  tab: MixCodeState["tabs"][number],
  width: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0) return [];
  const innerWidth = Math.max(0, width - 2);
  const divider = `${activeRenderTheme.borderMuted("─".repeat(width))}`;
  if (maxRows === 1) return [divider];
  const messages = tab.previewMessages.filter(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );
  if (messages.length === 0) {
    return [divider, activeRenderTheme.dim("  No messages yet")].slice(0, maxRows);
  }
  const recent = messages.slice(-(maxRows - 1));
  const lines = recent.map((msg) => {
    const role = msg.role === "assistant" ? "assistant" : "user";
    const prefix = ` ${activeRenderTheme.dim(`${role}:`)} `;
    const prefixWidth = visibleWidth(prefix);
    const textBudget = Math.max(1, innerWidth - prefixWidth);
    const text = truncateToWidth(singleLinePreview(msg.text), textBudget, "...");
    return `${prefix}${text}`;
  });
  return [divider, ...lines];
}

function formatAgentCardTitleSegment(tab: MixCodeState["tabs"][number], text: string): string {
  if (tab.status === "error") return activeRenderTheme.error(text);
  if (tabIsWaitingForInput(tab)) return activeRenderTheme.toolTitle(text);
  if (tab.status === "running" || tab.status === "thinking") return activeRenderTheme.accent(text);
  if (tab.status === "done" || tab.unreadDone) return activeRenderTheme.done(text);
  return text;
}

function formatAgentSpinner(tab: MixCodeState["tabs"][number], now: number): string {
  if (tab.status !== "running" && tab.status !== "thinking") return "";
  const start = tab.workingStartedAt ? Date.parse(tab.workingStartedAt) : NaN;
  // If startedAt is unavailable, use wall-clock time so the spinner still animates.
  const elapsed = Number.isFinite(start) ? Math.max(0, now - start) : now;
  const frame =
    AGENT_VIEW_SPINNER_FRAMES[
      Math.floor(elapsed / AGENT_VIEW_SPINNER_INTERVAL_MS) % AGENT_VIEW_SPINNER_FRAMES.length
    ];
  return activeRenderTheme.accent(frame ?? AGENT_VIEW_SPINNER_FRAMES[0]!);
}

function formatTabStatusChip(tab: MixCodeState["tabs"][number]): string {
  // Prefer unread-done over bare idle so Home cards match the tab-bar `!` glyph.
  if (tab.unreadDone && (tab.status === "idle" || tab.status === "done")) {
    return activeRenderTheme.toolTitle("[done]");
  }
  // Only the live tab status owns the error chip. Do not infer error from
  // historical system messages — recovered sessions stay idle/done.
  if (tab.status === "error") {
    return activeRenderTheme.error("[error]");
  }
  const text = `[${tab.status}]`;
  switch (tab.status) {
    case "running":
    case "thinking":
      return activeRenderTheme.accent(text);
    case "done":
      return activeRenderTheme.toolTitle(text);
    default:
      return activeRenderTheme.dim(text);
  }
}

function formatAgentCardMeta(tab: MixCodeState["tabs"][number], now = new Date()): string {
  const model = tab.model.modelId.split("/").pop() || tab.model.modelId;
  const tokens = exactContextUsageText(tab);
  const updated = formatTabUpdated(tab, now);
  return updated ? `${model} · ${tokens} · ${updated}` : `${model} · ${tokens}`;
}

/** Relative recency for Home cards from lastWorkedAt — not run duration. */
function formatTabUpdated(tab: MixCodeState["tabs"][number], now = new Date()): string {
  if (tab.status === "running" || tab.status === "thinking") return "now";
  if (!tab.lastWorkedAt) return "";
  const at = Date.parse(tab.lastWorkedAt);
  if (!Number.isFinite(at)) return "";
  const secs = Math.max(0, Math.floor((now.getTime() - at) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function latestAssistantPreview(tab: MixCodeState["tabs"][number]): string {
  // Prefer assistant, then fall back to shell/system so Home cards don't stay
  // stuck on "No output yet" after bash or error-only turns.
  const roles: Array<PreviewMessage["role"]> = ["assistant", "shell", "system", "user"];
  for (const role of roles) {
    const latest = [...tab.previewMessages].reverse().find((message) => message.role === role);
    const text = singleLinePreview(latest?.text);
    if (text) return text;
  }
  return "No output yet";
}

function singleLinePreview(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function renderPackageUpdateNotice(packages: string[], width: number): string[] {
  if (!packages.length) return [];
  const innerWidth = Math.max(0, width - 2);
  const title = activeRenderTheme.bold(activeRenderTheme.toolTitle("Package Updates Available"));
  const action = activeRenderTheme.accent("pi update --extensions");
  const lines = [
    title,
    `${activeRenderTheme.dim("Package updates are available. Run ")}${action}`,
    activeRenderTheme.dim("Packages:"),
    ...packages.map((pkg) => `- ${pkg}`),
  ];
  return [
    `${activeRenderTheme.toolTitle("┌")}${activeRenderTheme.toolTitle("─".repeat(innerWidth))}${activeRenderTheme.toolTitle("┐")}`,
    ...lines.map((line) => {
      const body = truncateToWidth(` ${line}`, innerWidth, "...");
      return `${activeRenderTheme.toolTitle("│")}${padLine(body, innerWidth)}${activeRenderTheme.toolTitle("│")}`;
    }),
    `${activeRenderTheme.toolTitle("└")}${activeRenderTheme.toolTitle("─".repeat(innerWidth))}${activeRenderTheme.toolTitle("┘")}`,
    "",
  ];
}

export function renderCommandPalette(
  state: MixCodeState,
  width: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderCommandPaletteInner(state, width, extensionCommands),
  );
}

/** Body-line plan for Command Palette list rows; shared by render + mouse hit-testing. */
export function planCommandPaletteList(
  state: MixCodeState,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): {
  entries: ReturnType<typeof selectableCommandPaletteEntries>;
  startIndex: number;
  endIndex: number;
  showMoreAbove: boolean;
  showMoreBelow: boolean;
  empty: boolean;
  /** 0-based body line (inside the box, under the top border) → entry index. */
  entryBodyLines: Array<{ bodyLine: number; entryIndex: number }>;
  bodyLineCount: number;
} {
  const entries = selectableCommandPaletteEntries(state, extensionCommands);
  if (!entries.length) {
    // search, separator, "No matching commands", blank, help
    return {
      entries,
      startIndex: 0,
      endIndex: 0,
      showMoreAbove: false,
      showMoreBelow: false,
      empty: true,
      entryBodyLines: [],
      bodyLineCount: 5,
    };
  }
  const maxVisible = halfScreenRows();
  const startIndex = windowStart(state.commandPalette.selectedIndex, entries.length, maxVisible);
  const endIndex = Math.min(startIndex + maxVisible, entries.length);
  const showMoreAbove = startIndex > 0;
  const showMoreBelow = endIndex < entries.length;
  // search + separator, optional more-above, entries, optional more-below, blank + help
  let bodyLine = 2;
  if (showMoreAbove) bodyLine += 1;
  const entryBodyLines: Array<{ bodyLine: number; entryIndex: number }> = [];
  for (let entryIndex = startIndex; entryIndex < endIndex; entryIndex++) {
    entryBodyLines.push({ bodyLine, entryIndex });
    bodyLine += 1;
  }
  if (showMoreBelow) bodyLine += 1;
  bodyLine += 2;
  return {
    entries,
    startIndex,
    endIndex,
    showMoreAbove,
    showMoreBelow,
    empty: false,
    entryBodyLines,
    bodyLineCount: bodyLine,
  };
}

function renderCommandPaletteInner(
  state: MixCodeState,
  width: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): string[] {
  if (!state.commandPaletteOpen) return [];
  const plan = planCommandPaletteList(state, extensionCommands);
  const innerWidth = Math.max(1, width - 2);

  // Search row with ">" prefix
  const searchPrefix = activeRenderTheme.accent(">");
  const queryText = state.commandPalette.query || " ";
  const searchLine = ` ${searchPrefix} ${queryText}`;

  // Separator between search and list
  const separator = activeRenderTheme.border("─".repeat(innerWidth));

  // Column width allocation: marker(2) + label(40%) + gap(2) + cmd(25%) + gap(2) + desc(35%)
  const markerWidth = 2;
  const gapTotal = 4;
  const remaining = Math.max(0, innerWidth - markerWidth - gapTotal);
  const labelCol = Math.max(6, Math.floor(remaining * 0.4));
  const cmdCol = Math.max(6, Math.floor(remaining * 0.25));
  const descCol = Math.max(4, remaining - labelCol - cmdCol);

  const lines: string[] = [searchLine, separator];

  if (plan.empty) {
    lines.push(activeRenderTheme.dim("  No matching commands"));
  } else {
    // Highlight only the searchable columns. Description stays dim because it
    // does not participate in command palette filtering.
    const paletteQuery = state.commandPalette.query.trim();
    if (plan.showMoreAbove) {
      lines.push(activeRenderTheme.dim(`  ... (${plan.startIndex} more above)`));
    }
    for (let index = plan.startIndex; index < plan.endIndex; index++) {
      const entry = plan.entries[index]!;
      const isSelected = index === state.commandPalette.selectedIndex;
      const marker = isSelected ? "› " : "  ";
      const label = truncateToWidth(entry.label, labelCol, "…");
      const cmd = truncateToWidth(entry.command, cmdCol, "…");
      const desc = truncateToWidth(entry.description, descCol, "…");

      const coloredLabel = highlightRanges(
        label,
        fuzzyMatchAllPositions(paletteQuery, label),
        matchHighlight,
      );
      const coloredCmd = highlightRanges(
        cmd,
        fuzzyMatchAllPositions(paletteQuery, cmd),
        matchHighlight,
        activeRenderTheme.accent,
      );
      // Description is not part of the palette filter (see
      // commandPaletteEntriesWithExtensions), so it must render as static dim
      // text without query highlighting — otherwise matched chars would light
      // up in a column that never participated in the match decision.
      const coloredDesc = activeRenderTheme.dim(desc);

      const labelPadded = coloredLabel + " ".repeat(Math.max(0, labelCol - visibleWidth(label)));
      const cmdPadded = coloredCmd + " ".repeat(Math.max(0, cmdCol - visibleWidth(cmd)));

      const row = `${marker}${labelPadded}  ${cmdPadded}  ${coloredDesc}`;

      if (isSelected) {
        lines.push(activeRenderTheme.selectedBg(padLine(row, innerWidth)));
      } else {
        lines.push(row);
      }
    }
    if (plan.showMoreBelow) {
      lines.push(activeRenderTheme.dim(`  ... (${plan.entries.length - plan.endIndex} more below)`));
    }
  }

  lines.push("", activeRenderTheme.dim("  ↑↓ select  ⏎ run  esc close"));
  return overlayPanel("Command Palette", lines, width);
}

export function renderTabJumpOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderTabJumpOverlayInner(state, width));
}

/** Body-line plan for Tab Jump list rows; shared by render + mouse hit-testing. */
export function planTabJumpList(state: MixCodeState): {
  entries: ReturnType<typeof filterTabJumpEntries>;
  startIndex: number;
  endIndex: number;
  showMoreAbove: boolean;
  showMoreBelow: boolean;
  empty: boolean;
  /** 0-based body line (inside the box, under the top border) → entry index. */
  entryBodyLines: Array<{ bodyLine: number; entryIndex: number }>;
  /** Total body lines before the box border is applied. */
  bodyLineCount: number;
} {
  const entries = filterTabJumpEntries(state, state.tabJumpQuery);
  if (!entries.length) {
    // search, blank, "No matching tabs", blank, help
    return {
      entries,
      startIndex: 0,
      endIndex: 0,
      showMoreAbove: false,
      showMoreBelow: false,
      empty: true,
      entryBodyLines: [],
      bodyLineCount: 5,
    };
  }
  const maxVisible = halfScreenRows();
  const startIndex = windowStart(state.tabJumpIndex, entries.length, maxVisible);
  const endIndex = Math.min(startIndex + maxVisible, entries.length);
  const showMoreAbove = startIndex > 0;
  const showMoreBelow = endIndex < entries.length;
  // search + blank, optional more-above, entries, optional more-below, blank + help
  let bodyLine = 2;
  if (showMoreAbove) bodyLine += 1;
  const entryBodyLines: Array<{ bodyLine: number; entryIndex: number }> = [];
  for (let entryIndex = startIndex; entryIndex < endIndex; entryIndex++) {
    entryBodyLines.push({ bodyLine, entryIndex });
    bodyLine += 1;
  }
  if (showMoreBelow) bodyLine += 1;
  bodyLine += 2;
  return {
    entries,
    startIndex,
    endIndex,
    showMoreAbove,
    showMoreBelow,
    empty: false,
    entryBodyLines,
    bodyLineCount: bodyLine,
  };
}

function renderTabJumpOverlayInner(state: MixCodeState, width: number): string[] {
  if (!state.tabJumpOpen) return [];
  const plan = planTabJumpList(state);
  // Denominator is unfiltered total so 2/5 still means "2 of 5 tabs match".
  const totalTabs = tabJumpEntries(state).length;
  const innerWidth = Math.max(1, width - 2);
  const searchText = state.tabJumpQuery || "";
  const modeTag = state.tabJumpNonIdleOnly ? " non-idle" : "";
  const countText = `${plan.entries.length}/${totalTabs} tabs${modeTag}`;
  const searchPrefix = activeRenderTheme.dim("Search");
  const searchLeft = ` ${searchPrefix}  ${activeRenderTheme.accent(searchText)}`;
  const searchGap = Math.max(1, innerWidth - visibleWidth(searchLeft) - visibleWidth(countText));
  const lines = [`${searchLeft}${" ".repeat(searchGap)}${activeRenderTheme.dim(countText)}`, ""];
  if (plan.empty) {
    lines.push(activeRenderTheme.dim("No matching tabs"));
  } else {
    if (plan.showMoreAbove) {
      lines.push(activeRenderTheme.dim(`... (${plan.startIndex} more above)`));
    }
    for (let index = plan.startIndex; index < plan.endIndex; index++) {
      const entry = plan.entries[index]!;
      const line = renderTabJumpRow(entry, index === state.tabJumpIndex, innerWidth, state.tabJumpQuery);
      lines.push(
        index === state.tabJumpIndex ? activeRenderTheme.selectedBg(padLine(line, innerWidth)) : line,
      );
    }
    if (plan.showMoreBelow) {
      lines.push(activeRenderTheme.dim(`... (${plan.entries.length - plan.endIndex} more below)`));
    }
  }
  lines.push(
    "",
    activeRenderTheme.dim(
      "type filter · ↑↓/tab select · ctrl+f non-idle · enter jump · esc cancel",
    ),
  );
  return overlayPanel("Tab Jump", lines, width);
}

function renderTabJumpRow(
  entry: ReturnType<typeof filterTabJumpEntries>[number],
  selected: boolean,
  width: number,
  query: string,
): string {
  const cursor = selected ? activeRenderTheme.accent("›") : " ";
  const status = formatTabJumpStatus(entry);
  const leftWidth = visibleWidth(cursor) + 1 + visibleWidth(status) + 2;
  const displayId = formatTabJumpId(entry.id, entry.label, width - leftWidth - 2);
  const id = activeRenderTheme.dim(displayId);
  const idWidth = visibleWidth(displayId);
  const titleWidth = Math.max(1, width - leftWidth - idWidth - 2);
  const truncatedTitle = truncateToWidth(entry.label, titleWidth, "...");
  const title = highlightRanges(
    truncatedTitle,
    fuzzyMatchAllPositions(query, truncatedTitle),
    matchHighlight,
    tabJumpBaseStyle(entry),
  );
  const left = `${cursor} ${status}  ${title}`;
  const gap = Math.max(1, width - visibleWidth(left) - idWidth);
  return `${left}${" ".repeat(gap)}${id}`;
}

function formatTabJumpStatus(entry: ReturnType<typeof filterTabJumpEntries>[number]): string {
  if (entry.waitingForInput) return activeRenderTheme.warning("?");
  if (entry.busy) return activeRenderTheme.accent("*");
  if (entry.done) return activeRenderTheme.done("!");
  return " ";
}

function formatTabJumpId(id: string, label: string, availableWidth: number): string {
  if (id.length <= 12) return id;
  const fullIdWidth = visibleWidth(id);
  const labelWidth = visibleWidth(label);
  if (labelWidth + 1 + fullIdWidth <= availableWidth) return id;
  return id.slice(0, 8);
}

function tabJumpBaseStyle(
  entry: ReturnType<typeof filterTabJumpEntries>[number],
): (text: string) => string {
  if (entry.waitingForInput) return activeRenderTheme.toolTitle;
  if (entry.busy) return activeRenderTheme.accent;
  if (entry.done) return activeRenderTheme.done;
  return (text: string) => text;
}

export function renderPickerOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderPickerOverlayInner(state, width));
}

function renderPickerOverlayInner(state: MixCodeState, width: number): string[] {
  const picker = state.picker;
  if (!picker) return [];
  const items = filteredPickerItems(picker);

  // Workdir picker has a custom layout with breadcrumb and icons
  if (picker.kind === "workdir") {
    return renderWorkdirPickerOverlay(picker, items, width);
  }

  // Context-limit picker: custom input mode
  if (picker.kind === "context-limit" && picker.customInputMode) {
    return renderContextLimitCustomInput(picker, width);
  }

  const lines = [`filter: ${picker.query}`, ""];
  if (!items.length) {
    lines.push("No matching items");
  } else {
    const pickerQuery = picker.query.trim();
    const maxVisible = halfScreenRows();
    const startIndex = windowStart(picker.selectedIndex, items.length, maxVisible);
    const endIndex = Math.min(startIndex + maxVisible, items.length);
    if (startIndex > 0) {
      lines.push(activeRenderTheme.dim(`  ... (${startIndex} more above)`));
    }
    for (let index = startIndex; index < endIndex; index++) {
      const item = items[index]!;
      const label = highlightRanges(
        item.label,
        fuzzyMatchPositions(pickerQuery, item.label),
        matchHighlight,
      );
      const description = highlightRanges(
        item.description,
        fuzzyMatchPositions(pickerQuery, item.description),
        matchHighlight,
      );
      const line = `${index === picker.selectedIndex ? ">" : " "} ${label}  ${description}`;
      const rendered = item.disabled ? activeRenderTheme.dim(line) : line;
      lines.push(
        index === picker.selectedIndex
          ? activeRenderTheme.selectedBg(padLine(rendered, Math.max(1, width - 2)))
          : rendered,
      );
    }
    if (endIndex < items.length) {
      lines.push(activeRenderTheme.dim(`  ... (${items.length - endIndex} more below)`));
    }
  }
  lines.push("", "type: filter  up/down: select  enter: choose  esc: cancel");
  return overlayPanel(picker.title, lines, width);
}

function renderWorkdirPickerOverlay(
  picker: NonNullable<MixCodeState["picker"]>,
  items: ReturnType<typeof filteredPickerItems>,
  width: number,
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const breadcrumb = workdirBreadcrumb(picker);
  const breadcrumbLine = breadcrumb
    .map((seg, i) =>
      i === breadcrumb.length - 1 ? activeRenderTheme.warning(seg) : activeRenderTheme.accent(seg),
    )
    .join(activeRenderTheme.dim(" / "));

  const filterLine = picker.query
    ? `${activeRenderTheme.dim("filter:")} ${picker.query}`
    : activeRenderTheme.dim("type to filter");

  const lines: string[] = [breadcrumbLine, filterLine, ""];

  if (!items.length) {
    lines.push(activeRenderTheme.dim("  (empty directory)"));
  } else {
    // Workdir entries are filtered by plain substring `.includes()`, not fuzzy
    // subsequence matching, so highlight the same way for accurate feedback.
    const dirQuery = picker.query.trim();
    const maxVisible = halfScreenRows();
    const startIndex = windowStart(picker.selectedIndex, items.length, maxVisible);
    const endIndex = Math.min(startIndex + maxVisible, items.length);
    if (startIndex > 0) {
      lines.push(activeRenderTheme.dim(`  ... (${startIndex} more above)`));
    }
    for (let index = startIndex; index < endIndex; index++) {
      const item = items[index]!;
      const icon = item.completeValue ? "\u{1F4C1}" : "\u{1F4C4}";
      const label = highlightRanges(
        item.label,
        substringMatchPositions(dirQuery, item.label),
        matchHighlight,
      );
      const line = `${index === picker.selectedIndex ? ">" : " "} ${icon} ${label}  ${activeRenderTheme.dim(item.description)}`;
      lines.push(
        index === picker.selectedIndex
          ? activeRenderTheme.selectedBg(padLine(line, innerWidth))
          : line,
      );
    }
    if (endIndex < items.length) {
      lines.push(activeRenderTheme.dim(`  ... (${items.length - endIndex} more below)`));
    }
  }

  const hiddenIndicator = picker.showHidden ? "on" : "off";
  const itemCount = items.length;
  lines.push(
    "",
    activeRenderTheme.dim(
      `${itemCount} dirs \u00b7 \u2190: parent  tab: enter dir  enter: set workdir  ctrl+h: hidden(${hiddenIndicator})  esc: cancel`,
    ),
  );
  return overlayPanel(picker.title, lines, width);
}

function renderContextLimitCustomInput(
  picker: NonNullable<MixCodeState["picker"]>,
  width: number,
): string[] {
  const lines: string[] = [
    "Enter context limit (e.g. 32k, 40000)",
    "",
    `> ${picker.query}_`,
  ];
  if (picker.customInputError) {
    lines.push(activeRenderTheme.error(`\u2716 ${picker.customInputError}`));
  }
  lines.push("", activeRenderTheme.dim("enter: confirm  esc: back"));
  return overlayPanel(picker.title, lines, width);
}
