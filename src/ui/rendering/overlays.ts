import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  commandPaletteEntriesWithExtensions,
  filterTabJumpEntries,
  previewTitle,
} from "../../core/overlays.js";
import { filteredPickerItems, workdirBreadcrumb } from "../../core/pickers.js";
import type { MixCodeState, MixCodeTabInfo } from "../../core/types.js";
import { tabHasPendingUserInteraction } from "../../core/user-interactions.js";
import { type MixCodeTheme, themeForId } from "../themes.js";
import { tabStatusGlyph } from "./chrome.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { centerLine } from "./layout.js";
import { box, overlayPanel, padLine, panelBox, renderBoxTop } from "./primitives.js";

export function renderPreviewOverlay(
  tab: MixCodeTabInfo,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderPreviewOverlayInner(tab, width));
}

function renderPreviewOverlayInner(tab: MixCodeTabInfo, width: number): string[] {
  if (!tab.previewOpen) return [];
  const messages = tab.previewMessages.length
    ? tab.previewMessages
    : [{ role: "empty" as const, text: "No preview messages yet." }];
  const index = Math.min(Math.max(tab.previewIndex, 0), messages.length - 1);
  const message = messages[index]!;
  const contentLines = message.text.split(/\r?\n/);
  const offset = Math.min(
    Math.max(tab.previewScrollOffset, 0),
    Math.max(0, contentLines.length - 1),
  );
  const lines = [
    `session: ${tab.sessionId}`,
    previewTitle(tab),
    `scroll: ${offset + 1}/${Math.max(1, contentLines.length)}`,
    "",
    ...contentLines.slice(offset, offset + 16),
  ];
  return box("Markdown Preview", lines, width);
}

export function renderConfig(
  state: MixCodeState,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
  rowOffset = 0,
  maxRows?: number,
): string[] {
  return renderWithTheme(theme, () => renderConfigInner(state, width, rowOffset, maxRows));
}

function renderConfigInner(
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
  // Hide logo when terminal is too small to fit logo + at least 1 card + preview.
  const LOGO_ROWS = logo.length + 2; // logo lines + blank before + blank after
  const MIN_ROWS_FOR_LOGO = LOGO_ROWS + AGENT_CARD_HEIGHT + AGENT_CARD_CHROME_ROWS + 3; // + panel chrome
  const showLogo = maxRows === undefined || maxRows >= MIN_ROWS_FOR_LOGO + updateRows.length;
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
  return fitConfigRows(configPanelBox("", lines, width), maxRows, width);
}

function fitConfigRows(lines: string[], maxRows: number | undefined, width: number): string[] {
  void width;
  if (maxRows === undefined) return lines;
  return lines.slice(0, Math.max(0, Math.floor(maxRows)));
}

function configPanelBox(title: string, lines: string[], width: number): string[] {
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, [], innerWidth, {
    ...activeRenderTheme,
    border: activeRenderTheme.borderDim,
  }, true);
  const body = lines.map(
    (line) =>
      `${activeRenderTheme.borderDim("│")}${padLine(line, innerWidth)}${activeRenderTheme.borderDim("│")}`,
  );
  const bottom = `${activeRenderTheme.borderDim("╰")}${activeRenderTheme.borderDim("─".repeat(innerWidth))}${activeRenderTheme.borderDim("╯")}`;
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
  const hint = activeRenderTheme.dim("  ↑/↓: select  →/Enter: attach  Tab: cycle tabs");

  // Cards are the anchor of Agent View; preview and hint use the remaining rows.
  const rowsAfterHeader = budget === undefined ? undefined : Math.max(0, budget - lines.length);
  const previewAndHintReserve =
    rowsAfterHeader !== undefined && rowsAfterHeader >= AGENT_CARD_HEIGHT + 3 ? 3 : 0;
  const availableForCards =
    rowsAfterHeader === undefined ? undefined : Math.max(0, rowsAfterHeader - previewAndHintReserve);
  const maxCards = availableForCards === undefined
    ? state.tabs.length
    : Math.max(0, Math.floor(availableForCards / AGENT_CARD_HEIGHT));
  const { start, end } = agentCardWindow(state.tabs.length, selectedIndex, maxCards);
  if (maxCards === 0 && rowsAfterHeader !== undefined && rowsAfterHeader > 0) {
    pushAgentRows(lines, renderAgentCard(state.tabs[selectedIndex]!, width, true, now), budget);
  } else {
    for (let i = start; i < end; i++) {
      if (budget !== undefined && lines.length + AGENT_CARD_HEIGHT > budget) break;
      lines.push(...renderAgentCard(state.tabs[i]!, width, i === selectedIndex, now));
    }
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
  if (remainingRows >= 3) return remainingRows - 1; // keep one row for the navigation hint
  if (remainingRows >= 2) return remainingRows;
  return 0;
}

function pushAgentRows(lines: string[], rows: string[], budget: number | undefined): void {
  const remaining = budget === undefined ? rows.length : Math.max(0, budget - lines.length);
  lines.push(...rows.slice(0, remaining));
}

function fitAgentRows(lines: string[], budget: number | undefined): string[] {
  if (budget === undefined) return lines;
  return lines.slice(0, budget);
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
  const border = selected ? activeRenderTheme.accent : activeRenderTheme.borderDim;
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
  const meta = truncateToWidth(
    ` Project ${projectName(tab)}   Updated ${formatTabUpdated(tab)}`,
    innerWidth,
    "...",
  );
  const preview = truncateToWidth(` ⎿ ${latestAssistantPreview(tab)}`, innerWidth, "...");
  return [
    top,
    `${border("│")}${padLine(meta, innerWidth)}${border("│")}`,
    `${border("│")}${activeRenderTheme.dim(padLine(preview, innerWidth))}${border("│")}`,
    `${border("└")}${border("─".repeat(innerWidth))}${border("┘")}`,
  ];
}

function renderPreviewPanel(
  tab: MixCodeState["tabs"][number],
  width: number,
  maxRows: number,
): string[] {
  if (maxRows <= 0) return [];
  const innerWidth = Math.max(0, width - 2);
  const divider = `${activeRenderTheme.borderDim("─".repeat(width))}`;
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
  if (tab.status === "error") return activeRenderTheme.danger(text);
  if (tabHasPendingUserInteraction(tab)) return activeRenderTheme.tool(text);
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
  const text = `[${tab.status}]`;
  switch (tab.status) {
    case "running":
    case "thinking":
      return activeRenderTheme.accent(text);
    case "error":
      return activeRenderTheme.danger(text);
    case "done":
      return activeRenderTheme.tool(text);
    default:
      return activeRenderTheme.dim(text);
  }
}

function projectName(tab: MixCodeState["tabs"][number]): string {
  return tab.workdir.split("/").filter(Boolean).pop() ?? tab.workdir;
}

function formatTabUpdated(tab: MixCodeState["tabs"][number]): string {
  if (tab.lastWorkedDurationSeconds !== undefined && tab.lastWorkedDurationSeconds > 0) {
    const secs = tab.lastWorkedDurationSeconds;
    if (secs < 60) return `${secs}s ago`;
    return `${Math.floor(secs / 60)}m ago`;
  }
  if (tab.status === "running" || tab.status === "thinking") return "now";
  return "—";
}

function latestAssistantPreview(tab: MixCodeState["tabs"][number]): string {
  const latest = [...tab.previewMessages].reverse().find((message) => message.role === "assistant");
  return singleLinePreview(latest?.text) || "No output yet";
}

function singleLinePreview(text: string | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function renderPackageUpdateNotice(packages: string[], width: number): string[] {
  if (!packages.length) return [];
  const innerWidth = Math.max(0, width - 2);
  const title = activeRenderTheme.bold(activeRenderTheme.tool("Package Updates Available"));
  const action = activeRenderTheme.accent("pi update --extensions");
  const lines = [
    title,
    `${activeRenderTheme.dim("Package updates are available. Run ")}${action}`,
    activeRenderTheme.dim("Packages:"),
    ...packages.map((pkg) => `- ${pkg}`),
  ];
  return [
    `${activeRenderTheme.tool("┌")}${activeRenderTheme.tool("─".repeat(innerWidth))}${activeRenderTheme.tool("┐")}`,
    ...lines.map((line) => {
      const body = truncateToWidth(` ${line}`, innerWidth, "...");
      return `${activeRenderTheme.tool("│")}${padLine(body, innerWidth)}${activeRenderTheme.tool("│")}`;
    }),
    `${activeRenderTheme.tool("└")}${activeRenderTheme.tool("─".repeat(innerWidth))}${activeRenderTheme.tool("┘")}`,
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

function renderCommandPaletteInner(
  state: MixCodeState,
  width: number,
  extensionCommands: Array<{ name: string; description?: string }> = [],
): string[] {
  if (!state.commandPaletteOpen) return [];
  const allEntries = commandPaletteEntriesWithExtensions(state, extensionCommands);
  const entries = allEntries.filter((entry) => entry.enabled);
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

  if (!entries.length) {
    lines.push(activeRenderTheme.dim("  No matching commands"));
  } else {
    entries.forEach((entry, index) => {
      const isSelected = index === state.commandPalette.selectedIndex;
      const marker = isSelected ? "› " : "  ";
      const label = truncateToWidth(entry.label, labelCol, "…");
      const cmd = truncateToWidth(entry.command, cmdCol, "…");
      const desc = truncateToWidth(entry.description, descCol, "…");

      const labelPadded = label + " ".repeat(Math.max(0, labelCol - visibleWidth(label)));
      const cmdPadded = cmd + " ".repeat(Math.max(0, cmdCol - visibleWidth(cmd)));

      const coloredLabel = labelPadded;
      const coloredCmd = activeRenderTheme.accent(cmdPadded);
      const coloredDesc = activeRenderTheme.dim(desc);

      const row = `${marker}${coloredLabel}  ${coloredCmd}  ${coloredDesc}`;

      if (isSelected) {
        lines.push(activeRenderTheme.selection(padLine(row, innerWidth)));
      } else {
        lines.push(row);
      }
    });
  }

  lines.push("", activeRenderTheme.dim("  ↑↓ select  ⏎ run  esc close"));
  return overlayPanel("Command Palette", lines, width);
}

export function renderTabJumpOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderTabJumpOverlayInner(state, width));
}

function renderTabJumpOverlayInner(state: MixCodeState, width: number): string[] {
  if (!state.tabJumpOpen) return [];
  const entries = filterTabJumpEntries(state, state.tabJumpQuery);
  const totalTabs = filterTabJumpEntries(state, "").length;
  const innerWidth = Math.max(1, width - 2);
  const searchText = state.tabJumpQuery || "";
  const countText = `${entries.length}/${totalTabs} tabs`;
  const searchPrefix = activeRenderTheme.dim("Search");
  const searchLeft = ` ${searchPrefix}  ${activeRenderTheme.accent(searchText)}`;
  const searchGap = Math.max(1, innerWidth - visibleWidth(searchLeft) - visibleWidth(countText));
  const lines = [`${searchLeft}${" ".repeat(searchGap)}${activeRenderTheme.dim(countText)}`, ""];
  if (!entries.length) {
    lines.push(activeRenderTheme.dim("No matching tabs"));
  } else {
    entries.forEach((entry, index) => {
      const line = renderTabJumpRow(entry, index === state.tabJumpIndex, innerWidth);
      lines.push(
        index === state.tabJumpIndex ? activeRenderTheme.selection(padLine(line, innerWidth)) : line,
      );
    });
  }
  lines.push(
    "",
    activeRenderTheme.dim("type filter · ↑↓/tab select · enter jump · esc cancel"),
  );
  return overlayPanel("Tab Jump", lines, width);
}

function renderTabJumpRow(
  entry: ReturnType<typeof filterTabJumpEntries>[number],
  selected: boolean,
  width: number,
): string {
  const cursor = selected ? activeRenderTheme.accent("›") : " ";
  const status = formatTabJumpStatus(entry);
  const leftWidth = visibleWidth(cursor) + 1 + visibleWidth(status) + 2;
  const displayId = formatTabJumpId(entry.id, entry.label, width - leftWidth - 2);
  const id = activeRenderTheme.dim(displayId);
  const idWidth = visibleWidth(displayId);
  const titleWidth = Math.max(1, width - leftWidth - idWidth - 2);
  const title = formatTabJumpTitle(entry, truncateToWidth(entry.label, titleWidth, "..."));
  const left = `${cursor} ${status}  ${title}`;
  const gap = Math.max(1, width - visibleWidth(left) - idWidth);
  return `${left}${" ".repeat(gap)}${id}`;
}

function formatTabJumpStatus(entry: ReturnType<typeof filterTabJumpEntries>[number]): string {
  if (entry.question) return activeRenderTheme.warning("?");
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

function formatTabJumpTitle(
  entry: ReturnType<typeof filterTabJumpEntries>[number],
  title: string,
): string {
  if (entry.question) return activeRenderTheme.tool(title);
  if (entry.busy) return activeRenderTheme.accent(title);
  if (entry.done) return activeRenderTheme.done(title);
  return title;
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
    items.forEach((item, index) => {
      const line = `${index === picker.selectedIndex ? ">" : " "} ${item.label}  ${item.description}`;
      lines.push(
        index === picker.selectedIndex
          ? activeRenderTheme.selection(padLine(line, Math.max(1, width - 2)))
          : line,
      );
    });
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
    items.forEach((item, index) => {
      const icon = item.completeValue ? "\u{1F4C1}" : "\u{1F4C4}";
      const line = `${index === picker.selectedIndex ? ">" : " "} ${icon} ${item.label}  ${activeRenderTheme.dim(item.description)}`;
      lines.push(
        index === picker.selectedIndex
          ? activeRenderTheme.selection(padLine(line, innerWidth))
          : line,
      );
    });
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
    lines.push(activeRenderTheme.danger(`\u2716 ${picker.customInputError}`));
  }
  lines.push("", activeRenderTheme.dim("enter: confirm  esc: back"));
  return overlayPanel(picker.title, lines, width);
}
