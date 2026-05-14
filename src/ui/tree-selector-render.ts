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
import { themeForId } from "./themes.js";

function getMaxVisible(): number {
  return Math.max(5, Math.floor((process.stdout.rows || 24) / 2));
}

export function renderTreeSelector(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderTreeSelectorInner(state.treeSelector, width),
  );
}

function renderTreeSelectorInner(selector: TreeSelectorState, width: number): string[] {
  const panelWidth = Math.max(1, width);
  const bodyWidth = panelWidth;

  if (selector.summarizePrompt !== null) {
    return renderSummarizePrompt(selector, bodyWidth);
  }

  const lines: string[] = ["", renderDynamicBorder(bodyWidth), activeRenderTheme.bold("  Session Tree")];
  lines.push(renderTreeHintLine(bodyWidth));
  lines.push(renderSearchLine(selector, bodyWidth));
  lines.push(renderDynamicBorder(bodyWidth));
  lines.push("");

  if (selector.labelEditEntryId !== null) {
    lines.push(...renderLabelInput(selector, bodyWidth));
  } else {
    lines.push(...renderTreeList(selector, bodyWidth));
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

function renderTreeHintLine(width: number): string {
  return truncateToWidth(
    activeRenderTheme.dim(
      "  ↑/↓: move. ←/→: page. ^←/^→ or Alt+←/Alt+→: fold/branch. shift+l: label. ctrl+d/ctrl+t/ctrl+u/ctrl+l/ctrl+a: filters (ctrl+o/shift+ctrl+o cycle). shift+t: label time",
    ),
    width,
  );
}

function renderSearchLine(selector: TreeSelectorState, width: number): string {
  const line = selector.searchQuery
    ? `  ${activeRenderTheme.dim("Type to search:")} ${activeRenderTheme.accent(selector.searchQuery)}`
    : `  ${activeRenderTheme.dim("Type to search:")}`;
  return truncateToWidth(line, width);
}

function renderDynamicBorder(width: number): string {
  return activeRenderTheme.border("─".repeat(Math.max(1, width)));
}

function renderTreeList(selector: TreeSelectorState, bodyWidth: number): string[] {
  const lines: string[] = [];
  if (selector.filteredNodes.length === 0) {
    lines.push(activeRenderTheme.dim("  No entries found"));
    lines.push(activeRenderTheme.dim(`  (0/0)${formatStatusLabels(selector)}`));
    return lines.map((line) => truncateToWidth(line, bodyWidth));
  }

  const maxVisible = getMaxVisible();
  const startIndex = Math.max(
    0,
    Math.min(
      selector.selectedIndex - Math.floor(maxVisible / 2),
      selector.filteredNodes.length - maxVisible,
    ),
  );
  const endIndex = Math.min(startIndex + maxVisible, selector.filteredNodes.length);

  for (let i = startIndex; i < endIndex; i++) {
    const flatNode = selector.filteredNodes[i];
    const entry = flatNode.node.entry;
    const isSelected = i === selector.selectedIndex;

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

    const content = getEntryDisplayText(flatNode.node, isSelected, selector);

    let line =
      cursor +
      activeRenderTheme.dim(prefix) +
      foldMarker +
      pathMarker +
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
      `  (${selector.selectedIndex + 1}/${selector.filteredNodes.length})${formatStatusLabels(selector)}`,
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
