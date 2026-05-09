import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
  commandPaletteEntriesWithExtensions,
  filterTabJumpEntries,
  previewTitle,
} from "../../core/overlays.js";
import { isPendingEscapeActive } from "../../core/escape.js";
import { filteredPickerItems } from "../../core/pickers.js";
import type { ConfigAction, MixCodeState, MixCodeTabInfo } from "../../core/types.js";
import { themeForId, type MixCodeTheme } from "../themes.js";
import { activeRenderTheme, renderWithTheme } from "./context.js";
import { centerLine } from "./layout.js";
import { box, overlayPanel, padLine, panelBox } from "./primitives.js";

export function renderQuestionOverlay(
  tab: MixCodeTabInfo,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderQuestionOverlayInner(tab, width));
}

function renderQuestionOverlayInner(tab: MixCodeTabInfo, width: number): string[] {
  const request = tab.pendingQuestions[0];
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
  const escapeHint =
    isPendingEscapeActive(tab, "reject-question")
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

export function renderShellOverlay(
  tab: MixCodeTabInfo,
  width: number,
  theme: MixCodeTheme = activeRenderTheme,
): string[] {
  return renderWithTheme(theme, () => renderShellOverlayInner(tab, width));
}

function renderShellOverlayInner(tab: MixCodeTabInfo, width: number): string[] {
  if (!tab.shellOpen) return [];
  const session = tab.shellSession;
  const escapeHint = isPendingEscapeActive(tab, "close-shell")
    ? "Esc again: close shell"
    : "Esc: arm close";
  if (!session)
    return box(
      "Shell",
      [`workdir: ${tab.workdir}`, "Interactive shell overlay", escapeHint],
      width,
    );
  const state =
    session.exitCode === undefined && session.signal === undefined
      ? `pid: ${session.pid ?? "?"}`
      : `exited: ${session.exitCode ?? session.signal ?? "unknown"}`;
  const visibleLines = 16;
  const maxOffset = Math.max(0, session.buffer.length - visibleLines);
  const offset = Math.min(Math.max(tab.shellScrollOffset, 0), maxOffset);
  const lines = [
    `workdir: ${session.cwd}`,
    `${session.command} | ${state}`,
    `scroll: ${offset + 1}/${maxOffset + 1}`,
    escapeHint,
    "",
    ...session.buffer.slice(offset, offset + visibleLines),
    `$ ${session.input}`,
  ];
  return box("Shell", lines, width);
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
): string[] {
  return renderWithTheme(theme, () => renderConfigInner(state, width, rowOffset));
}

function renderConfigInner(state: MixCodeState, width: number, rowOffset: number): string[] {
  const logo = [
    "███╗   ███╗██╗██╗  ██╗ ██████╗ ██████╗ ██████╗ ███████╗",
    "████╗ ████║██║╚██╗██╔╝██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "██╔████╔██║██║ ╚███╔╝ ██║     ██║   ██║██║  ██║█████╗  ",
    "██║╚██╔╝██║██║ ██╔██╗ ██║     ██║   ██║██║  ██║██╔══╝  ",
    "██║ ╚═╝ ██║██║██╔╝ ██╗╚██████╗╚██████╔╝██████╔╝███████╗",
    "╚═╝     ╚═╝╚═╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝",
  ];
  const tabs = state.tabs.length ? state.tabs.map((tab) => tab.title).join(", ") : "none";
  const actionButtons = [
    { action: "new-session" as const, label: "New Session" },
    { action: "theme" as const, label: "Theme" },
    { action: "save-workspace" as const, label: "Save Workspace" },
    { action: "restore-workspace" as const, label: "Restore Workspace" },
    { action: "delete-workspace" as const, label: "Delete Workspace" },
  ];
  const bodyWidth = Math.max(1, width - 6);
  const fieldRows = [
    ...renderConfigField("Workdir", state.workdir, bodyWidth),
    ...renderConfigField("Sessions", tabs, bodyWidth),
  ];
  const updateRows = renderPackageUpdateNotice(state.packageUpdates, bodyWidth);
  state.configActionHitRegions = [];
  const buttonRow = rowOffset + 4 + logo.length + updateRows.length + 1 + fieldRows.length + 1;
  const lines = [
    "",
    ...logo.map((line) => centerLine(activeRenderTheme.accent(line), Math.max(1, width - 2))),
    "",
    ...updateRows.map((line) => `  ${line}`),
    ...fieldRows.map((line) => `  ${line}`),
    "",
    `  ${renderConfigButtonBand(state, actionButtons, bodyWidth, buttonRow)}`,
    "",
    `  ${renderConfigStatusLine(state, bodyWidth)}`,
  ];
  return panelBox("", lines, width);
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
    ...lines.map(
      (line) =>
        `${activeRenderTheme.tool("│")}${activeRenderTheme.surface(padLine(` ${line}`, innerWidth))}${activeRenderTheme.tool("│")}`,
    ),
    `${activeRenderTheme.tool("└")}${activeRenderTheme.tool("─".repeat(innerWidth))}${activeRenderTheme.tool("┘")}`,
    "",
  ];
}

function renderConfigButtonBand(
  state: MixCodeState,
  buttons: Array<{ action: ConfigAction; label: string }>,
  width: number,
  row: number,
): string {
  let cursor = 1;
  const parts = buttons.map((button) => {
    const text = ` ${activeRenderTheme.bold(button.label)} `;
    const startX = 3 + cursor;
    const endX = startX + visibleWidth(` ${button.label} `) - 1;
    state.configActionHitRegions ??= [];
    state.configActionHitRegions.push({ action: button.action, row, startX, endX });
    cursor += visibleWidth(` ${button.label} `) + 1;
    return text;
  });
  const content = parts.join(" ");
  return activeRenderTheme.surface(padLine(content, width));
}

function renderConfigStatusLine(state: MixCodeState, width: number): string {
  const working = state.tabs.filter(
    (tab) => tab.status === "running" || tab.status === "thinking",
  ).length;
  const errored = state.tabs.filter((tab) => tab.status === "error").length;
  const unread = state.tabs.filter((tab) => tab.unreadDone).length;
  const parts = [
    activeRenderTheme.dim("Pi-native ready"),
    `tabs: ${state.tabs.length}`,
    `working: ${working}`,
    `errors: ${errored}`,
    `unread: ${unread}`,
  ];
  return activeRenderTheme.panel(padLine(` ${parts.join("  ·  ")}`, width));
}

function renderConfigField(title: string, value: string, width: number): string[] {
  const innerWidth = Math.max(0, width - 2);
  const safeTitle = truncateToWidth(title, Math.max(1, innerWidth - 2));
  const safeValue = truncateToWidth(value || " ", Math.max(1, innerWidth - 4));
  const top = `${activeRenderTheme.borderDim("▊")}${activeRenderTheme.surface(activeRenderTheme.borderDim("▔".repeat(innerWidth)))}${activeRenderTheme.borderDim("▎")}`;
  const body = `${activeRenderTheme.borderDim("▊")}${activeRenderTheme.surface(padLine(`  ${activeRenderTheme.dim(safeTitle)} ${safeValue}`, innerWidth))}${activeRenderTheme.borderDim("▎")}`;
  const bottom = `${activeRenderTheme.borderDim("▊")}${activeRenderTheme.surface(activeRenderTheme.borderDim("▁".repeat(innerWidth)))}${activeRenderTheme.borderDim("▎")}`;
  return [top, body, bottom];
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
      lines.push(
        `${index === state.tabJumpIndex ? ">" : " "} ${marker} ${entry.label} (${entry.id})`,
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
  lines.push(
    "",
    picker.kind === "workdir"
      ? "type path  ctrl+u: clear  tab: complete  up/down: select  enter: set workdir  esc: cancel"
      : "type: filter  up/down: select  enter: choose  esc: cancel",
  );
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
