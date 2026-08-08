// Header keyboard-shortcut hints, MixCode's analogue of Pi's builtin header
// (interactive-mode's compact instructions / expanded instructions pair).
//
// Compact (default):  esc interrupt · tab tabs · ctrl+p commands · ! bash · ctrl+o more
// Expanded (ctrl+o):  the full global keymap, one row per action, plus the
//                     slash/bash literals and a /hotkeys pointer.
//
// The expansion state is tab.extensionUi.toolsExpanded — the same flag that
// expands tool output blocks — mirroring Pi where app.tools.expand flips the
// header and chat blocks together. Rendering rides the scrollable header slot
// (above the startup resource summary), so it scrolls away with history and
// survives chat rebuilds.

import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { MIXCODE_KEYMAP } from "../../core/keymap.js";
import type { MixCodeTabInfo } from "../../core/types.js";
import { activeRenderTheme } from "./context.js";
import { padLine } from "./primitives.js";

// Hand-curated compact line (like Pi's compactInstructions), sized to cover
// the day-to-day keys — interrupt/undo, navigation, palette, editor, queue —
// while staying a short block; ctrl+o reveals the full annotated list.
//
// Intentionally static across modes: Vim mode swallows ctrl+p for its own
// navigation, but the header still documents the global command palette chord
// so users know it after leaving Vim (q). Do not hide or rewrite this row in Vim.
const COMPACT_HINTS: ReadonlyArray<readonly [key: string, label: string]> = [
  ["esc", "interrupt"],
  ["esc esc", "tree"],
  ["tab", "tabs"],
  ["ctrl+p", "commands"],
  ["ctrl+t", "jump"],
  ["ctrl+e", "editor"],
  ["ctrl+u", "dequeue"],
  ["!", "bash"],
  ["ctrl+o", "more"],
];

// Literal rows appended to the expanded list; these are input prefixes, not
// keymap entries, so they live here (same set /hotkeys shows under "Other").
const EXPANDED_EXTRAS: ReadonlyArray<readonly [key: string, description: string]> = [
  ["/", "Slash commands"],
  ["!", "Run bash command"],
  ["!!", "Run bash command (excluded from context)"],
];

/**
 * Render the hint block for the scrollable header. Empty when the tab has no
 * startup summary (the hints belong to the same startup block and would be
 * orphaned without it, e.g. on preview-only tabs before the runtime is ready).
 */
export function renderHeaderKeyHints(tab: MixCodeTabInfo, width: number): string[] {
  if (!tab.startupSummary) return [];
  return tab.extensionUi.toolsExpanded ? renderExpanded(width) : renderCompact(width);
}

function renderCompact(width: number): string[] {
  const separator = activeRenderTheme.dim(" · ");
  const units = COMPACT_HINTS.map(
    ([key, label]) => `${activeRenderTheme.toolTitle(key)}${activeRenderTheme.dim(` ${label}`)}`,
  );
  // Pack whole key+label units per line so a hint never wraps mid-pair.
  const lines: string[] = [];
  let current = "";
  for (const unit of units) {
    const candidate = current ? `${current}${separator}${unit}` : unit;
    if (current && visibleWidth(candidate) > Math.max(1, width)) {
      lines.push(current);
      current = unit;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  return lines.map((line) => padLine(line, width));
}

function renderExpanded(width: number): string[] {
  const rows = [...globalKeymapRows(), ...EXPANDED_EXTRAS];
  const keyColumn = Math.max(...rows.map(([key]) => key.length)) + 2;
  const lines = rows.flatMap(([key, description]) => {
    const label = `${activeRenderTheme.toolTitle(key.padEnd(keyColumn))}${activeRenderTheme.dim(description)}`;
    return wrapTextWithAnsi(label, Math.max(1, width)).map((line) => padLine(line, width));
  });
  lines.push(
    padLine(
      `${activeRenderTheme.toolTitle("/hotkeys".padEnd(keyColumn))}${activeRenderTheme.dim("Full shortcut list (all scopes)")}`,
      width,
    ),
  );
  return lines;
}

// Global-scope keymap rows with keys merged per action (alt+up and ctrl+u both
// pop the queue → one "alt+up/ctrl+u" row), keeping the list short and factual.
function globalKeymapRows(): Array<[key: string, description: string]> {
  const byAction = new Map<string, { keys: string[]; description: string }>();
  for (const item of MIXCODE_KEYMAP) {
    if ((item.scope ?? "global") !== "global") continue;
    const existing = byAction.get(item.action);
    if (existing) existing.keys.push(item.key);
    else byAction.set(item.action, { keys: [item.key], description: item.description });
  }
  return [...byAction.values()].map(({ keys, description }) => [keys.join("/"), description]);
}
