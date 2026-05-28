import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { isPendingEscapeActive } from "../../core/escape.js";
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

export function renderQuestionOverlay(
  tab: MixCodeTabInfo,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderQuestionOverlayInner(tab, width));
}

function renderQuestionOverlayInner(tab: MixCodeTabInfo, width: number): string[] {
  const request = tab.pendingDialogs[0];
  if (!request) return [];
  const innerWidth = Math.max(1, width - 2);
  const question = request.questions[request.currentQuestionIndex];
  if (!question) return renderQuestionPanel(["No pending question details"], width);
  const highlighted = request.highlightedOptionIndices[request.currentQuestionIndex] ?? 0;
  const selected = new Set(request.selectedAnswers[request.currentQuestionIndex] ?? []);
  const options = question.options.length
    ? question.options.map((option, index) => {
        const marker = index === highlighted ? ">" : " ";
        const checkbox = selected.has(option.label) ? "x" : " ";
        const body = `${marker} [${checkbox}] ${option.label}${option.description ? `  ${activeRenderTheme.dim(option.description)}` : ""}`;
        return index === highlighted
          ? activeRenderTheme.selection(padLine(body, innerWidth))
          : body;
      })
    : [activeRenderTheme.dim("  No options")];
  const customSelected = question.custom && highlighted === question.options.length;
  const customEditing = request.editingCustomIndex === request.currentQuestionIndex;
  const customPrefix = customSelected ? ">" : " ";
  const customValue = request.customAnswers[request.currentQuestionIndex] || "(empty)";
  const customLine = `${customPrefix} [${customEditing ? "*" : " "}] Custom: ${customValue}`;
  const custom = question.custom
    ? [customSelected ? activeRenderTheme.selection(padLine(customLine, innerWidth)) : customLine]
    : [];
  const escapeHint = isPendingEscapeActive(tab, "reject-question")
    ? "Esc again: reject question"
    : "Esc: arm reject";
  const hints = [
    activeRenderTheme.dim(
      "h/l: question  up/down: option/custom  space/enter: toggle/edit  y: send  n: reject",
    ),
    activeRenderTheme.dim(escapeHint),
  ];
  const title = `${question.header}  ${request.currentQuestionIndex + 1}/${request.questions.length}`;
  return renderQuestionPanel(
    [activeRenderTheme.accent(title), question.question, "", ...options, ...custom, "", ...hints],
    width,
  );
}

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
  return configPanelBox("", lines, width);
}

function configPanelBox(title: string, lines: string[], width: number): string[] {
  const innerWidth = Math.max(0, width - 2);
  const top = renderBoxTop(title, [], innerWidth, {
    ...activeRenderTheme,
    border: activeRenderTheme.borderDim,
  });
  const body = lines.map(
    (line) =>
      `${activeRenderTheme.borderDim("│")}${padLine(line, innerWidth)}${activeRenderTheme.borderDim("│")}`,
  );
  const bottom = `${activeRenderTheme.borderDim("└")}${activeRenderTheme.borderDim("─".repeat(innerWidth))}${activeRenderTheme.borderDim("┘")}`;
  return [padLine("", width), top, ...body, bottom];
}

const AGENT_CARD_HEIGHT = 4;
const AGENT_CARD_CHROME_ROWS = 3;
const AGENT_VIEW_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const AGENT_VIEW_SPINNER_INTERVAL_MS = 80;

function renderAgentViewTable(state: MixCodeState, width: number, maxRows?: number): string[] {
  if (state.tabs.length === 0) {
    return [
      "",
      activeRenderTheme.bold(" Agents"),
      activeRenderTheme.dim("  No agent sessions. Use the command palette to start one."),
    ];
  }
  const lines: string[] = ["", activeRenderTheme.bold(" Agents")];
  const selectedIndex = Math.min(state.homeSelectedTabIndex, state.tabs.length - 1);
  const now = Date.now();
  // Card list gets priority; preview panel uses remaining space.
  const PREVIEW_PANEL_MIN_ROWS = 2; // divider(1) + at least 1 message
  const availableForCards = maxRows === undefined
    ? undefined
    : Math.max(0, maxRows - AGENT_CARD_CHROME_ROWS - PREVIEW_PANEL_MIN_ROWS);
  const maxCards = availableForCards === undefined
    ? state.tabs.length
    : Math.max(1, Math.floor(availableForCards / AGENT_CARD_HEIGHT));
  const { start, end } = agentCardWindow(state.tabs.length, selectedIndex, maxCards);
  for (let i = start; i < end; i++) {
    lines.push(...renderAgentCard(state.tabs[i]!, width, i === selectedIndex, now));
  }
  // Preview panel uses remaining rows after cards.
  const cardRows = (end - start) * AGENT_CARD_HEIGHT;
  const previewMaxRows = maxRows === undefined
    ? 5
    : Math.max(1, maxRows - AGENT_CARD_CHROME_ROWS - cardRows);
  const selectedTab = state.tabs[selectedIndex];
  if (selectedTab && previewMaxRows > 0) {
    lines.push(...renderPreviewPanel(selectedTab, width, previewMaxRows));
  }
  lines.push(activeRenderTheme.dim("  ↑/↓: select  →/Enter: attach  Tab: cycle tabs"));
  return lines;
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
  maxLines: number,
): string[] {
  const innerWidth = Math.max(0, width - 2);
  const divider = `${activeRenderTheme.borderDim("─".repeat(width))}`;
  const messages = tab.previewMessages.filter(
    (msg) => msg.role === "user" || msg.role === "assistant",
  );
  if (messages.length === 0) {
    return [divider, activeRenderTheme.dim("  No messages yet")];
  }
  const recent = messages.slice(-maxLines);
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
  const action = activeRenderTheme.accent("pi update");
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
  const entries = commandPaletteEntriesWithExtensions(state, extensionCommands);
  const lines = [
    activeRenderTheme.dim("Search commands"),
    `  ${state.commandPalette.query || " "}`,
    "",
  ];
  if (!entries.length) {
    lines.push("No matching commands");
  } else {
    entries.forEach((entry, index) => {
      const status = entry.enabled ? entry.description : `disabled: ${entry.disabledReason}`;
      const line = `${index === state.commandPalette.selectedIndex ? ">" : " "} ${entry.label.padEnd(22)} ${entry.command.padEnd(22)} ${status}`;
      lines.push(
        index === state.commandPalette.selectedIndex
          ? activeRenderTheme.selection(padLine(line, Math.max(1, width - 2)))
          : line,
      );
    });
  }
  lines.push("", "type: filter  up/down: select  enter: execute command  esc: cancel");
  return overlayPanel("Command Palette", lines, width);
}

export function renderExportChooser(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderExportChooserInner(state, width));
}

function renderExportChooserInner(state: MixCodeState, width: number): string[] {
  const options = exportChooserItems();
  const lines = [
    "Which content would you like to view?",
    "",
    ...options.map((item, index) => {
      const marker = index === state.exportChooserIndex ? ">" : " ";
      const line = `${marker} [${item.key}] ${item.label}`;
      return index === state.exportChooserIndex
        ? activeRenderTheme.selection(padLine(line, Math.max(1, width - 2)))
        : line;
    }),
    "",
    "up/down/tab: select  enter: open  esc: cancel",
  ];
  return overlayPanel("Export", lines, width);
}

export function renderTabJumpOverlay(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderTabJumpOverlayInner(state, width));
}

function renderTabJumpOverlayInner(state: MixCodeState, width: number): string[] {
  if (!state.tabJumpOpen) return [];
  const entries = filterTabJumpEntries(state, state.tabJumpQuery);
  const lines = [`filter: ${state.tabJumpQuery}`, ""];
  if (!entries.length) {
    lines.push("No matching tabs");
  } else {
    entries.forEach((entry, index) => {
      const marker = entry.question ? "?" : entry.busy ? "*" : entry.done ? "!" : " ";
      const line = `${index === state.tabJumpIndex ? ">" : " "} ${marker} ${entry.label} (${entry.id})`;
      lines.push(
        index === state.tabJumpIndex
          ? activeRenderTheme.selection(padLine(line, Math.max(1, width - 2)))
          : line,
      );
    });
  }
  lines.push("", "type: filter  up/down: select  enter: jump  esc: cancel");
  return overlayPanel("Tab Jump", lines, width);
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

function renderQuestionPanel(lines: string[], width: number): string[] {
  const rule = activeRenderTheme.accent("─".repeat(Math.max(1, width)));
  return [rule, ...lines.map((line) => padLine(` ${line}`, width)), rule];
}

function exportChooserItems(): Array<{ key: string; label: string }> {
  return [
    { key: "T", label: "Thinking" },
    { key: "C", label: "Chat" },
    { key: "A", label: "Latest Agent Reply" },
    { key: "U", label: "Latest User Message" },
    { key: "S", label: "System Info" },
  ];
}
