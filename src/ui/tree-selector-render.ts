import { truncateToWidth } from "@earendil-works/pi-tui";

import {
  extractContent,
  formatToolCall,
  isFoldable,
  type SessionTreeNode,
  SUMMARIZE_OPTIONS,
  type TreeSelectorState,
} from "../core/tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { padLine } from "./rendering/primitives.js";
import { halfScreenRows, windowStart } from "./rendering/scroll-window.js";
import { themeForId } from "./themes.js";

function getMaxVisible(maxRows?: number): number {
  if (maxRows !== undefined) return Math.max(1, Math.floor(maxRows));
  return halfScreenRows();
}

export function renderTreeSelector(
  state: MixCodeState,
  width: number,
  maxRows?: number,
): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderTreeSelectorInner(state.treeSelector, width, maxRows),
  );
}

function renderTreeSelectorInner(
  selector: TreeSelectorState,
  width: number,
  maxRows?: number,
): string[] {
  const panelWidth = Math.max(1, width);
  const bodyWidth = panelWidth;

  if (selector.summarizePrompt !== null) {
    return renderSummarizePrompt(selector, bodyWidth);
  }

  const lines: string[] = ["", renderDynamicBorder(bodyWidth), activeRenderTheme.bold("  Session Tree")];
  lines.push(renderTreeHintLine(selector, bodyWidth));
  lines.push(renderSearchLine(selector, bodyWidth));
  lines.push(renderDynamicBorder(bodyWidth));
  lines.push("");

  if (selector.labelEditEntryId !== null) {
    lines.push(...renderLabelInput(selector, bodyWidth));
  } else {
    const footerRows = 2;
    const maxListRows = maxRows === undefined ? undefined : maxRows - lines.length - footerRows;
    lines.push(...renderTreeList(selector, bodyWidth, maxListRows));
  }

  lines.push("", renderDynamicBorder(bodyWidth));
  return lines.map((line) => truncateToWidth(line, bodyWidth));
}

function renderSummarizePrompt(selector: TreeSelectorState, width: number): string[] {
  const prompt = selector.summarizePrompt;
  if (prompt === null) return [];

  const lines: string[] = ["", renderDynamicBorder(width), activeRenderTheme.bold("  Summarize Branch")];
  lines.push(renderDynamicBorder(width), "");

  if (prompt.customMode) {
    lines.push(
      `  ${activeRenderTheme.bold("Custom summarization instructions")}`,
      "",
      `  Instructions: ${prompt.customInput}`,
      "",
      activeRenderTheme.dim("  Enter: confirm  Esc: back  Ctrl+U: clear"),
    );
  } else {
    lines.push(
      `  ${activeRenderTheme.bold("Summarize branch?")}`,
      "",
      ...SUMMARIZE_OPTIONS.map((option, i) => {
        const cursor = i === prompt.selectedIndex ? activeRenderTheme.accent("› ") : "  ";
        const text = i === prompt.selectedIndex ? activeRenderTheme.bold(option) : option;
        return `  ${cursor}${text}`;
      }),
      "",
      activeRenderTheme.dim("  ↑/↓: select  Enter: confirm  Esc: back to tree"),
    );
  }

  lines.push("", renderDynamicBorder(width));
  return lines.map((line) => truncateToWidth(line, width));
}

function renderLabelInput(selector: TreeSelectorState, width: number): string[] {
  return [
    activeRenderTheme.dim("  Label (empty to remove):"),
    `  ${selector.labelEditInput}`,
    activeRenderTheme.dim("  Enter: save  Esc: cancel  Ctrl+U: clear"),
  ].map((line) => truncateToWidth(line, width));
}

function renderTreeHintLine(selector: TreeSelectorState, width: number): string {
  const text = selector.mode === "navigate"
    ? "  ↑/↓ or j/k: move+scroll. Esc: close. Other keys pass through."
    : "  ↑/↓: move. ←/→: page. ^←/^→ or Alt+←/Alt+→: fold/branch. shift+l: label. ctrl+d/ctrl+t/ctrl+u/ctrl+l/ctrl+a: filters (ctrl+o/shift+ctrl+o cycle). shift+t: label time";
  return truncateToWidth(activeRenderTheme.dim(text), width);
}

function renderSearchLine(selector: TreeSelectorState, width: number): string {
  // Typing does not filter in navigate mode (keys pass through to chat scroll).
  if (selector.mode === "navigate") return "";
  const line = selector.searchQuery
    ? `  ${activeRenderTheme.dim("Type to search:")} ${activeRenderTheme.accent(selector.searchQuery)}`
    : `  ${activeRenderTheme.dim("Type to search:")}`;
  return truncateToWidth(line, width);
}

function renderDynamicBorder(width: number): string {
  return activeRenderTheme.border("─".repeat(Math.max(1, width)));
}

function renderTreeList(
  selector: TreeSelectorState,
  bodyWidth: number,
  maxListRows?: number,
): string[] {
  const lines: string[] = [];
  if (selector.filteredNodes.length === 0) {
    lines.push(activeRenderTheme.dim("  No entries found"));
    lines.push(activeRenderTheme.dim(`  (0/0)${formatStatusLabels(selector)}`));
    return lines.map((line) => truncateToWidth(line, bodyWidth));
  }

  const isNavigate = selector.mode === "navigate";
  // Navigate mode appends one virtual <NEWEST> row that jumps to the latest position.
  const totalRows = selector.filteredNodes.length + (isNavigate ? 1 : 0);
  const numWidth = String(selector.filteredNodes.length).length;
  const maxVisible = maxListRows !== undefined && maxListRows <= 1
    ? 0
    : getMaxVisible(maxListRows === undefined ? undefined : maxListRows - 1);
  const startIndex = windowStart(selector.selectedIndex, totalRows, maxVisible);
  const endIndex = Math.min(startIndex + maxVisible, totalRows);

  for (let i = startIndex; i < endIndex; i++) {
    const isSelected = i === selector.selectedIndex;

    if (i >= selector.filteredNodes.length) {
      // Virtual <NEWEST> row (navigate mode only): jump to the latest chat position.
      const text = isSelected ? activeRenderTheme.bold("<NEWEST>") : "<NEWEST>";
      let line = (isSelected ? activeRenderTheme.accent("› ") : "  ") + activeRenderTheme.accent(text);
      if (isSelected) line = activeRenderTheme.selection(padLine(line, bodyWidth));
      lines.push(truncateToWidth(line, bodyWidth));
      continue;
    }

    const flatNode = selector.filteredNodes[i];
    const entry = flatNode.node.entry;

    const cursor = isSelected ? activeRenderTheme.accent("› ") : "  ";
    const displayIndent = selector.multipleRoots
      ? Math.max(0, flatNode.indent - 1)
      : flatNode.indent;

    const connector =
      flatNode.showConnector && !flatNode.isVirtualRootChild
        ? flatNode.isLast
          ? "└─ "
          : "├─ "
        : "";
    const connectorPosition = connector ? displayIndent - 1 : -1;

    const totalChars = displayIndent * 3;
    const prefixChars: string[] = [];
    const isFoldedNode = selector.foldedNodes.has(entry.id);
    for (let ci = 0; ci < totalChars; ci++) {
      const level = Math.floor(ci / 3);
      const posInLevel = ci % 3;

      const gutter = flatNode.gutters.find((g) => g.position === level);
      if (gutter) {
        prefixChars.push(posInLevel === 0 ? (gutter.show ? "│" : " ") : " ");
      } else if (connector && level === connectorPosition) {
        if (posInLevel === 0) {
          prefixChars.push(flatNode.isLast ? "└" : "├");
        } else if (posInLevel === 1) {
          const foldable = isFoldable(selector, entry.id);
          prefixChars.push(isFoldedNode ? "⊞" : foldable ? "⊟" : "─");
        } else {
          prefixChars.push(" ");
        }
      } else {
        prefixChars.push(" ");
      }
    }
    const prefix = prefixChars.join("");

    const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
    const foldMarker =
      isFoldedNode && !showsFoldInConnector ? activeRenderTheme.accent("⊞ ") : "";

    const isOnActivePath = selector.activePathIds.has(entry.id);
    const pathMarker = isOnActivePath ? activeRenderTheme.accent("• ") : "";

    const label = flatNode.node.label
      ? activeRenderTheme.warning(`[${flatNode.node.label}] `)
      : "";
    const labelTimestamp =
      selector.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
        ? activeRenderTheme.dim(`${formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
        : "";

    // Navigate mode: sequence number + relative timestamp, like /prompt-history.
    const navInfo = isNavigate
      ? activeRenderTheme.dim(
          `#${String(i + 1).padStart(numWidth, " ")}${
            entry.timestamp ? ` [${formatRelativeTimestamp(entry.timestamp)}]` : ""
          } `,
        )
      : "";

    const content = getEntryDisplayText(flatNode.node, isSelected, selector);

    let line =
      cursor +
      activeRenderTheme.dim(prefix) +
      foldMarker +
      pathMarker +
      navInfo +
      label +
      labelTimestamp +
      content;
    if (isSelected) {
      line = activeRenderTheme.selection(padLine(line, bodyWidth));
    }
    lines.push(truncateToWidth(line, bodyWidth));
  }

  lines.push(
    activeRenderTheme.dim(
      `  (${selector.selectedIndex + 1}/${totalRows})${formatStatusLabels(selector)}`,
    ),
  );
  return lines.map((line) => truncateToWidth(line, bodyWidth));
}

function formatStatusLabels(selector: TreeSelectorState): string {
  const labels: string[] = [];
  switch (selector.filterMode) {
    case "no-tools":
      labels.push("no-tools");
      break;
    case "user-only":
      labels.push("user");
      break;
    case "labeled-only":
      labels.push("labeled");
      break;
    case "all":
      labels.push("all");
      break;
    case "default":
      break;
  }
  if (selector.showLabelTimestamps) labels.push("+label time");
  return labels.length > 0 ? ` [${labels.join("] [")}]` : "";
}

// --- Display helpers ---

function getEntryDisplayText(
  node: SessionTreeNode,
  isSelected: boolean,
  selector: TreeSelectorState,
): string {
  const entry = node.entry;
  let result: string;

  const normalize = (s: string) => s.replace(/[\n\t]/g, " ").trim();

  switch (entry.type) {
    case "message": {
      const msg = entry.message;
      const role = msg.role;
      if (role === "user") {
        const msgWithContent = msg as { content?: unknown };
        const content = normalize(extractContent(msgWithContent.content));
        result = activeRenderTheme.accent("user: ") + content;
      } else if (role === "assistant") {
        const msgWithContent = msg as {
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
        };
        const textContent = normalize(extractContent(msgWithContent.content));
        if (textContent) {
          result = activeRenderTheme.success("assistant: ") + textContent;
        } else if (msgWithContent.stopReason === "aborted") {
          result = activeRenderTheme.success("assistant: ") + activeRenderTheme.dim("(aborted)");
        } else if (msgWithContent.errorMessage) {
          const errMsg = normalize(msgWithContent.errorMessage).slice(0, 80);
          result = activeRenderTheme.success("assistant: ") + activeRenderTheme.danger(errMsg);
        } else {
          result =
            activeRenderTheme.success("assistant: ") + activeRenderTheme.dim("(no content)");
        }
      } else if (role === "toolResult") {
        const toolMsg = msg as { toolCallId?: string; toolName?: string };
        const toolCall = toolMsg.toolCallId
          ? selector.toolCallMap.get(toolMsg.toolCallId)
          : undefined;
        if (toolCall) {
          result = activeRenderTheme.dim(formatToolCall(toolCall.name, toolCall.arguments));
        } else {
          result = activeRenderTheme.dim(`[${toolMsg.toolName ?? "tool"}]`);
        }
      } else if (role === "bashExecution") {
        const bashMsg = msg as { command?: string };
        result = activeRenderTheme.dim(`[bash]: ${normalize(bashMsg.command ?? "")}`);
      } else {
        result = activeRenderTheme.dim(`[${role}]`);
      }
      break;
    }
    case "custom_message": {
      const content =
        typeof entry.content === "string"
          ? entry.content
          : entry.content
              .filter((c): c is { type: "text"; text: string } => c.type === "text")
              .map((c) => c.text)
              .join("");
      result = activeRenderTheme.warning(`[${entry.customType}]: `) + normalize(content);
      break;
    }
    case "compaction": {
      const tokens = Math.round(entry.tokensBefore / 1000);
      result = activeRenderTheme.accent(`[compaction: ${tokens}k tokens]`);
      break;
    }
    case "branch_summary":
      result = activeRenderTheme.warning("[branch summary]: ") + normalize(entry.summary);
      break;
    case "model_change":
      result = activeRenderTheme.dim(`[model: ${entry.modelId}]`);
      break;
    case "thinking_level_change":
      result = activeRenderTheme.dim(`[thinking: ${entry.thinkingLevel}]`);
      break;
    case "custom":
      result = activeRenderTheme.dim(`[custom: ${entry.customType}]`);
      break;
    case "label":
      result = activeRenderTheme.dim(`[label: ${entry.label ?? "(cleared)"}]`);
      break;
    case "session_info":
      result = entry.name
        ? activeRenderTheme.dim(`[title: ${entry.name}]`)
        : activeRenderTheme.dim("[title: ") +
          activeRenderTheme.italic(activeRenderTheme.dim("empty")) +
          activeRenderTheme.dim("]");
      break;
    default:
      result = "";
  }

  return isSelected ? activeRenderTheme.bold(result) : result;
}

/** Relative time like /prompt-history: "Xm ago (HH:MM)" */
function formatRelativeTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffSecs = Math.floor(diffMs / 1000);
  const diffMins = Math.floor(diffSecs / 60);
  const diffHours = Math.floor(diffMins / 60);
  const diffDays = Math.floor(diffHours / 24);

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

  const hours = date.getHours().toString().padStart(2, "0");
  const mins = date.getMinutes().toString().padStart(2, "0");
  const isToday = date.toDateString() === now.toDateString();
  const absolute = isToday
    ? `${hours}:${mins}`
    : `${(date.getMonth() + 1).toString().padStart(2, "0")}-${date.getDate().toString().padStart(2, "0")} ${hours}:${mins}`;

  return `${relative} (${absolute})`;
}

function formatLabelTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  const now = new Date();
  const hours = date.getHours().toString().padStart(2, "0");
  const minutes = date.getMinutes().toString().padStart(2, "0");
  const time = `${hours}:${minutes}`;

  if (
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  ) {
    return time;
  }

  const month = date.getMonth() + 1;
  const day = date.getDate();
  if (date.getFullYear() === now.getFullYear()) {
    return `${month}/${day} ${time}`;
  }

  const year = date.getFullYear().toString().slice(-2);
  return `${year}/${month}/${day} ${time}`;
}
