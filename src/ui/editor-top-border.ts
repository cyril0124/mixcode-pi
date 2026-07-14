import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** ANSI SGR escape sequences, stripped to inspect the visible characters. */
const ANSI_SGR_REGEX = /\x1b\[[0-9;:]*m/g;

/**
 * True when a rendered editor line is a plain horizontal border (only ─ and
 * spaces once colors are stripped). Used to avoid clobbering the scroll
 * indicator ("─── ↑ 3 more ─") or wrapped content with the title label.
 */
export function isPlainBorderLine(line: string): boolean {
  const visible = line.replace(ANSI_SGR_REGEX, "");
  return visible.length > 0 && /^[\u2500 ]+$/.test(visible);
}

/** Visible-width geometry for the labels embedded in the editor's top border. */
const VIM_BADGE_TEXT = "[VIM]";
export const SYS_BADGE_TEXT = "[sys]";
// Right chunk around the title: " <title> " + 2 trailing dashes.
const TITLE_FRAME_WIDTH = 1 /* leading space */ + 1 /* trailing space */ + 2 /* trailing dashes */;
// Optional " [sys]" after the title (space + badge), before the trailing frame space/dashes.
const SYS_BADGE_FRAME_WIDTH = 1 /* space before badge */ + visibleWidth(SYS_BADGE_TEXT);
// Left chunk for the vim badge: 2 dashes + " [VIM] ".
const VIM_FRAME_WIDTH = 2 /* leading dashes */ + 1 /* space */ + VIM_BADGE_TEXT.length + 1 /* space */;
// Minimum dashes between the left edge and the title separator (normal mode).
const MIN_TITLE_LEAD_DASHES = 3;

export interface LabeledTopBorderOptions {
  width: number;
  title: string;
  vimMode: boolean;
  /** When true, append [sys] after the title (custom base system prompt). */
  customBasePrompt?: boolean;
  /** Colorizer for the dashed border segments. */
  dash: (text: string) => string;
  /** Colorizer for the [VIM] badge. */
  vimLabel: (text: string) => string;
  /** Colorizer for the agent title. */
  titleLabel: (text: string) => string;
  /** Colorizer for the [sys] badge; defaults to titleLabel. */
  sysLabel?: (text: string) => string;
}

/**
 * Build the editor's top border line with an agent title anchored to the right
 * and an optional [VIM] badge near the left, e.g.
 *   normal:  ────────────────── Agent-1 ──
 *   custom:  ────────────────── Agent-1 [sys] ──
 *   vim:     ── [VIM] ────────── Agent-1 ──
 *
 * The title is truncated with an ellipsis when space is tight; the [VIM] badge
 * is dropped (title preserved) before the line degrades to a plain dashed
 * border. [sys] is preferred over a long title when both compete for width.
 * The returned string always has an exact visible width of `width`.
 */
export function buildLabeledTopBorder(opts: LabeledTopBorderOptions): string {
  const { width, title, vimMode, dash, vimLabel, titleLabel } = opts;
  const sysLabel = opts.sysLabel ?? titleLabel;
  if (width <= 0) return "";
  const dashes = (n: number) => dash("\u2500".repeat(Math.max(0, n)));
  const plain = () => dashes(width);

  const trimmed = title.trim();
  if (!trimmed) return plain();

  // Decide whether the [VIM] badge fits; if not, fall back to a title-only line.
  const wantVim = vimMode;
  const wantSys = Boolean(opts.customBasePrompt);
  const leadWidth = wantVim ? VIM_FRAME_WIDTH : 0;
  const sysWidth = wantSys ? SYS_BADGE_FRAME_WIDTH : 0;
  // Dashes that must connect the left edge / badge to the title separator.
  const minLead = wantVim ? 1 : MIN_TITLE_LEAD_DASHES;
  const maxTitleWidth = width - leadWidth - minLead - TITLE_FRAME_WIDTH - sysWidth;
  if (maxTitleWidth <= 0) {
    // Prefer dropping vim first, then sys, so title can still show.
    if (wantVim) return buildLabeledTopBorder({ ...opts, vimMode: false });
    if (wantSys) return buildLabeledTopBorder({ ...opts, customBasePrompt: false });
    return plain();
  }

  let titleText = trimmed;
  if (visibleWidth(titleText) > maxTitleWidth) {
    titleText = truncateToWidth(titleText, maxTitleWidth, "\u2026");
  }
  const titleWidth = visibleWidth(titleText);

  // Fill dashes that span from the left chunk to the title separator.
  const fill = width - leadWidth - TITLE_FRAME_WIDTH - titleWidth - sysWidth;
  if (fill < minLead) {
    if (wantVim) return buildLabeledTopBorder({ ...opts, vimMode: false });
    if (wantSys) return buildLabeledTopBorder({ ...opts, customBasePrompt: false });
    return plain();
  }

  const sysChunk = wantSys ? ` ${sysLabel(SYS_BADGE_TEXT)}` : "";
  const rightChunk = ` ${titleLabel(titleText)}${sysChunk} ${dash("\u2500\u2500")}`;
  if (!wantVim) {
    return `${dashes(fill)}${rightChunk}`;
  }
  const leftChunk = `${dash("\u2500\u2500")} ${vimLabel(VIM_BADGE_TEXT)} `;
  return `${leftChunk}${dashes(fill)}${rightChunk}`;
}
