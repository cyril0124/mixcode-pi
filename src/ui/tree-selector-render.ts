import { truncateToWidth } from "@earendil-works/pi-tui";

import {
  extractContent,
  formatToolCall,
  isFoldable,
  type SessionTreeNode,
  SUMMARIZE_OPTIONS,
  type TreeFilterMode,
  type TreeSelectorState,
} from "../core/tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import { themeForId } from "./themes.js";

function getMaxVisible(): number {
  return Math.max(8, Math.floor((process.stdout.rows || 24) / 2));
}

export function renderTreeSelector(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () =>
    renderTreeSelectorInner(state.treeSelector, width),
  );
}

function renderTreeSelectorInner(selector: TreeSelectorState, width: number): string[] {
  const panelWidth = Math.min(Math.max(70, width - 4), width);
  const bodyWidth = Math.max(1, panelWidth - 4);

  // Summarize prompt mode
  if (selector.summarizePrompt !== null) {
    const prompt = selector.summarizePrompt;
    if (prompt.customMode) {
      const lines = [
        activeRenderTheme.bold("Custom summarization instructions"),
        "",
        `Instructions: ${prompt.customInput}`,
        "",
        activeRenderTheme.dim("Enter: confirm  Esc: back  Ctrl+U: clear"),
      ];
      return overlayPanel("Summarize Branch", lines, panelWidth);
    }
    const lines = [
      activeRenderTheme.bold("Summarize branch?"),
      "",
      ...SUMMARIZE_OPTIONS.map((option, i) => {
        const cursor = i === prompt.selectedIndex ? activeRenderTheme.accent("› ") : "  ";
        const text = i === prompt.selectedIndex ? activeRenderTheme.bold(option) : option;
        return cursor + text;
      }),
      "",
      activeRenderTheme.dim("↑/↓: select  Enter: confirm  Esc: back to tree"),
    ];
    return overlayPanel("Summarize Branch", lines, panelWidth);
  }

  // Label edit mode
  if (selector.labelEditEntryId !== null) {
    const lines = [
      activeRenderTheme.bold("Edit Label"),
      "",
      `Label (empty to remove): ${selector.labelEditInput}`,
      "",
      activeRenderTheme.dim("Enter: save  Esc: cancel  Ctrl+U: clear"),
    ];
    return overlayPanel("Edit Label", lines, panelWidth);
  }

  // Header
  const filterLabel = formatFilterLabel(selector.filterMode);
  const headerRight = [
    activeRenderTheme.dim("Filter:"),
    activeRenderTheme.accent(filterLabel),
    selector.showLabelTimestamps ? activeRenderTheme.dim(" [+time]") : "",
  ].join("");

  // Hints
  const hintLine = activeRenderTheme.dim(
    "↑/↓: move  ←/→: page  Ctrl+H/L: fold/branch  Ctrl+E: label  Ctrl+N/P: cycle filter  Ctrl+D: time",
  );

  // Search
  const searchLine = selector.searchQuery
    ? `${activeRenderTheme.dim("Search:")} ${activeRenderTheme.accent(selector.searchQuery)}`
    : activeRenderTheme.dim("Type to search");

  const lines: string[] = [
    truncateToWidth(headerRight, bodyWidth),
    truncateToWidth(hintLine, bodyWidth),
    "",
    truncateToWidth(searchLine, bodyWidth),
    "",
  ];

  // Tree list
  if (selector.filteredNodes.length === 0) {
    lines.push(activeRenderTheme.dim("  No entries found"));
    lines.push(activeRenderTheme.dim(`  (0/0) [${filterLabel}]`));
  } else {
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

      // Build prefix with gutters
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

      // Fold marker for nodes without connectors (roots)
      const showsFoldInConnector = flatNode.showConnector && !flatNode.isVirtualRootChild;
      const foldMarker =
        isFoldedNode && !showsFoldInConnector ? activeRenderTheme.accent("⊞ ") : "";

      // Active path marker
      const isOnActivePath = selector.activePathIds.has(entry.id);
      const pathMarker = isOnActivePath ? activeRenderTheme.accent("• ") : "";

      // Label
      const label = flatNode.node.label
        ? activeRenderTheme.warning(`[${flatNode.node.label}] `)
        : "";
      const labelTimestamp =
        selector.showLabelTimestamps && flatNode.node.label && flatNode.node.labelTimestamp
          ? activeRenderTheme.dim(`${formatLabelTimestamp(flatNode.node.labelTimestamp)} `)
          : "";

      // Content
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
        `  (${selector.selectedIndex + 1}/${selector.filteredNodes.length}) [${filterLabel}]`,
      ),
    );
  }

  lines.push("", activeRenderTheme.dim("Enter: navigate  Esc: close"));

  return overlayPanel("Session Tree", lines, panelWidth);
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

function formatFilterLabel(mode: TreeFilterMode): string {
  switch (mode) {
    case "default":
      return "default";
    case "no-tools":
      return "no-tools";
    case "user-only":
      return "user";
    case "labeled-only":
      return "labeled";
    case "all":
      return "all";
  }
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
