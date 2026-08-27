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
const ZEN_BADGE_TEXT = "[ZEN]";
const INL_BADGE_TEXT = "[INL]";
export const SYS_BADGE_TEXT = "[sys]";
// Right chunk around the title: " <title> " + 2 trailing dashes.
const TITLE_FRAME_WIDTH = 1 /* leading space */ + 1 /* trailing space */ + 2 /* trailing dashes */;
// Optional " [sys]" after the title (space + badge), before the trailing frame space/dashes.
const SYS_BADGE_FRAME_WIDTH = 1 /* space before badge */ + visibleWidth(SYS_BADGE_TEXT);
// Optional " · <context>" between title and [sys]/trailing frame.
const CONTEXT_SEP_WIDTH = 3; // " · "
// Left badges share a 2-dash lead; each badge is " [BADGE]".
const LEFT_LEAD_DASHES = 2;
const BADGE_UNIT = (text: string) => 1 /* space */ + visibleWidth(text);
// Minimum dashes between the left edge / badges and the title separator.
const MIN_TITLE_LEAD_DASHES = 3;
const MIN_BADGE_LEAD_DASHES = 1;

export interface LabeledTopBorderOptions {
  width: number;
  title: string;
  vimMode: boolean;
  /** When true, show [ZEN] next to [VIM] (or alone) near the left. */
  zenMode?: boolean;
  /** When true, show [INL] after [ZEN] / [VIM] (inline widget mode). */
  inlineWidgets?: boolean;
  /** When true, append [sys] after the title (custom base system prompt). */
  customBasePrompt?: boolean;
  /**
   * Exact context usage (e.g. "12.3k/200k*") rendered after the title as
   * ` · <context>`. Dropped before the title when width is tight.
   */
  contextText?: string;
  /** Colorizer for the dashed border segments. */
  dash: (text: string) => string;
  /** Colorizer for the [VIM] badge. */
  vimLabel: (text: string) => string;
  /** Colorizer for the [ZEN] badge; defaults to titleLabel (agent accent). */
  zenLabel?: (text: string) => string;
  /** Colorizer for the [INL] badge; defaults to zenLabel. */
  inlLabel?: (text: string) => string;
  /** Colorizer for the agent title. */
  titleLabel: (text: string) => string;
  /** Colorizer for the [sys] badge; defaults to titleLabel. */
  sysLabel?: (text: string) => string;
  /** Colorizer for contextText; defaults to titleLabel. */
  contextLabel?: (text: string) => string;
}

/**
 * Build the editor's top border line with an agent title anchored to the right
 * and optional left badges, e.g.
 *   normal:  ────────────────── Agent-1 ──
 *   context: ────────── Agent-1 · 12.3k/200k ──
 *   custom:  ────────────────── Agent-1 [sys] ──
 *   vim:     ── [VIM] ────────── Agent-1 ──
 *   zen:     ── [ZEN] ────────── Agent-1 ──
 *   inl:     ── [INL] ────────── Agent-1 ──
 *   all:     ── [VIM] [ZEN] [INL] ── Agent-1 ──
 *
 * The title is truncated with an ellipsis when space is tight; left badges and
 * context are dropped (title preserved) before the line degrades to a plain
 * dashed border. Drop order when tight: inl, then zen, then vim, then sys,
 * then context, then title. The returned string always has an exact visible width of `width`.
 */
export function buildLabeledTopBorder(opts: LabeledTopBorderOptions): string {
  const { width, title, vimMode, dash, vimLabel, titleLabel } = opts;
  const zenMode = opts.zenMode === true;
  const inlineWidgets = opts.inlineWidgets === true;
  const sysLabel = opts.sysLabel ?? titleLabel;
  const zenLabel = opts.zenLabel ?? titleLabel;
  const inlLabel = opts.inlLabel ?? zenLabel;
  const contextLabel = opts.contextLabel ?? titleLabel;
  if (width <= 0) return "";
  const dashes = (n: number) => dash("\u2500".repeat(Math.max(0, n)));
  const plain = () => dashes(width);

  const trimmed = title.trim();
  if (!trimmed) return plain();

  const wantVim = vimMode;
  const wantZen = zenMode;
  const wantInl = inlineWidgets;
  const wantSys = Boolean(opts.customBasePrompt);
  const contextText = opts.contextText?.trim() ?? "";
  const wantContext = contextText.length > 0;
  const leftWidth =
    wantVim || wantZen || wantInl
      ? LEFT_LEAD_DASHES +
        (wantVim ? BADGE_UNIT(VIM_BADGE_TEXT) : 0) +
        (wantZen ? BADGE_UNIT(ZEN_BADGE_TEXT) : 0) +
        (wantInl ? BADGE_UNIT(INL_BADGE_TEXT) : 0) +
        1 /* trailing space after last badge */
      : 0;
  const sysWidth = wantSys ? SYS_BADGE_FRAME_WIDTH : 0;
  const contextWidth = wantContext ? CONTEXT_SEP_WIDTH + visibleWidth(contextText) : 0;
  const minLead = wantVim || wantZen || wantInl ? MIN_BADGE_LEAD_DASHES : MIN_TITLE_LEAD_DASHES;
  const maxTitleWidth = width - leftWidth - minLead - TITLE_FRAME_WIDTH - sysWidth - contextWidth;
  if (maxTitleWidth <= 0) {
    // Prefer dropping inl first, then zen, then vim, then sys, then context.
    if (wantInl) return buildLabeledTopBorder({ ...opts, inlineWidgets: false });
    if (wantZen) return buildLabeledTopBorder({ ...opts, zenMode: false });
    if (wantVim) return buildLabeledTopBorder({ ...opts, vimMode: false });
    if (wantSys) return buildLabeledTopBorder({ ...opts, customBasePrompt: false });
    if (wantContext) return buildLabeledTopBorder({ ...opts, contextText: undefined });
    return plain();
  }

  let titleText = trimmed;
  if (visibleWidth(titleText) > maxTitleWidth) {
    titleText = truncateToWidth(titleText, maxTitleWidth, "\u2026");
  }
  const titleWidth = visibleWidth(titleText);

  // Fill dashes that span from the left chunk to the title separator.
  const fill = width - leftWidth - TITLE_FRAME_WIDTH - titleWidth - sysWidth - contextWidth;
  if (fill < minLead) {
    if (wantInl) return buildLabeledTopBorder({ ...opts, inlineWidgets: false });
    if (wantZen) return buildLabeledTopBorder({ ...opts, zenMode: false });
    if (wantVim) return buildLabeledTopBorder({ ...opts, vimMode: false });
    if (wantSys) return buildLabeledTopBorder({ ...opts, customBasePrompt: false });
    if (wantContext) return buildLabeledTopBorder({ ...opts, contextText: undefined });
    return plain();
  }

  const contextChunk = wantContext ? ` · ${contextLabel(contextText)}` : "";
  const sysChunk = wantSys ? ` ${sysLabel(SYS_BADGE_TEXT)}` : "";
  const rightChunk = ` ${titleLabel(titleText)}${contextChunk}${sysChunk} ${dash("\u2500\u2500")}`;
  if (!wantVim && !wantZen && !wantInl) {
    return `${dashes(fill)}${rightChunk}`;
  }
  const badges =
    (wantVim ? ` ${vimLabel(VIM_BADGE_TEXT)}` : "") +
    (wantZen ? ` ${zenLabel(ZEN_BADGE_TEXT)}` : "") +
    (wantInl ? ` ${inlLabel(INL_BADGE_TEXT)}` : "");
  const leftChunk = `${dash("\u2500".repeat(LEFT_LEAD_DASHES))}${badges} `;
  return `${leftChunk}${dashes(fill)}${rightChunk}`;
}
