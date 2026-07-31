import { truncateToWidth } from "@earendil-works/pi-tui";
import { applyMixCodeKeybindings } from "../agent/runtime-pi-tui-bridge.js";
import type { TreeSelectorState } from "../core/tree-selector.js";
import { SUMMARIZE_OPTIONS } from "../core/tree-selector.js";
import type { MixCodeState } from "../core/types.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { themeForId } from "./themes.js";

export function renderTreeSelector(state: MixCodeState, width: number, maxRows?: number): string[] {
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
  if (selector.summarizePrompt !== null) {
    return renderSummarizePrompt(selector, panelWidth);
  }

  const restoreKeybindings = applyMixCodeKeybindings();
  let lines: string[];
  try {
    lines = selector.component?.render(panelWidth) ?? [];
  } finally {
    restoreKeybindings();
  }
  if (selector.mode === "navigate") customizeNavigateHeader(lines);
  const fitted = fitEditorRows(lines, maxRows);
  return fitted.map((line) => truncateToWidth(line, panelWidth));
}

function customizeNavigateHeader(lines: string[]): void {
  const titleIndex = lines.findIndex((line) => stripAnsi(line).includes("Session Tree"));
  if (titleIndex < 0) return;
  const borderIndex = lines.findIndex(
    (line, index) => index > titleIndex && /^─+$/.test(stripAnsi(line).trim()),
  );
  if (borderIndex < 0) return;
  lines.splice(
    titleIndex + 1,
    borderIndex - titleIndex - 1,
    activeRenderTheme.dim("  ↑/↓ or j/k: move+scroll. Enter/Esc: close. Other keys pass through."),
  );
}

function fitEditorRows(lines: string[], maxRows?: number): string[] {
  if (maxRows === undefined || lines.length <= maxRows) return lines;
  if (maxRows <= 1) return lines.slice(-1);
  return [...lines.slice(0, maxRows - 1), lines.at(-1)!];
}

function renderSummarizePrompt(selector: TreeSelectorState, width: number): string[] {
  const prompt = selector.summarizePrompt;
  if (prompt === null) return [];

  const lines: string[] = ["", border(width), activeRenderTheme.bold("  Summarize Branch")];
  lines.push(border(width), "");

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
      ...SUMMARIZE_OPTIONS.map((option, index) => {
        const cursor = index === prompt.selectedIndex ? activeRenderTheme.accent("› ") : "  ";
        const text = index === prompt.selectedIndex ? activeRenderTheme.bold(option) : option;
        return `  ${cursor}${text}`;
      }),
      "",
      activeRenderTheme.dim("  ↑/↓: select  Enter: confirm  Esc: back to tree"),
    );
  }

  lines.push("", border(width));
  return lines.map((line) => truncateToWidth(line, width));
}

function border(width: number): string {
  return activeRenderTheme.border("─".repeat(Math.max(1, width)));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
