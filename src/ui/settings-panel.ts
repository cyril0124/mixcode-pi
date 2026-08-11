/**
 * /settings — floating overlay, same pattern as the command palette:
 *   state.settingsPanel + showLinesOverlay(renderSettingsPanel) + handleSettingsPanelKey
 */

import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import * as os from "node:os";
import {
  DEFAULT_HISTORY_MAX_BYTES,
  DEFAULT_ICON_MODE,
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
  ICON_MODES,
  loadRawMixCodeSettings,
  writeRawMixCodeSettings,
  type IconMode,
  type RawMixCodeSettings,
} from "../core/mixcode-settings.js";
import type {
  MermaidRenderingMode,
  MixCodeModelRef,
  MixCodeState,
  SettingsPanelState,
} from "../core/types.js";
import type { OverlayTui } from "./app-types.js";
import { closeAppOverlay, showLinesOverlay } from "./app-overlays.js";
import { clearConversationCache } from "./rendering/agent-surface.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import { windowStart } from "./rendering/scroll-window.js";
import {
  getExplicitRetryMaxRetries,
  MIXCODE_RETRY_DEFAULTS,
  setRetryMaxRetries,
} from "../agent/retry-settings.js";
import { DEFAULT_THEME_ID } from "../core/defaults.js";
import { listThemeInfos, setTheme, themeForId } from "./themes.js";

// ─── Setting item descriptors ────────────────────────────────────────────────

interface PanelCtx {
  state: MixCodeState;
  settingsManager: SettingsManager;
  mixcodeRaw: RawMixCodeSettings;
  mixcodeFile: string;
  piSettingsFile: string;
  setHideThinkingBlock?: (hide: boolean) => Promise<void>;
  availableModels: MixCodeModelRef[];
}

interface BooleanItem {
  kind: "boolean";
  label: string;
  section: "pi" | "mixcode";
  defaultValue: boolean;
  getValue(ctx: PanelCtx): boolean | undefined;
  setValue(ctx: PanelCtx, v: boolean): Promise<void>;
}

interface NumberItem {
  kind: "number";
  label: string;
  section: "pi" | "mixcode";
  defaultValue: number;
  getValue(ctx: PanelCtx): number | undefined;
  setValue(ctx: PanelCtx, v: number | undefined): Promise<void>;
}

interface EnumItem {
  kind: "enum";
  label: string;
  section: "pi" | "mixcode";
  defaultValue: string;
  getValue(ctx: PanelCtx): string | undefined;
  getOptions(ctx: PanelCtx): string[];
  setValue(ctx: PanelCtx, v: string | undefined): Promise<void>;
}

interface MultiEnumItem {
  kind: "multi-enum";
  label: string;
  section: "pi" | "mixcode";
  defaultValue: string[];
  getValues(ctx: PanelCtx): string[] | undefined;
  getOptions(ctx: PanelCtx): string[];
  setValues(ctx: PanelCtx, v: string[] | undefined): Promise<void>;
}

type SettingItem = BooleanItem | NumberItem | EnumItem | MultiEnumItem;

const ITEMS: SettingItem[] = [
  {
    kind: "boolean",
    label: "hideThinkingBlock",
    section: "pi",
    defaultValue: false,
    getValue: ({ settingsManager }) => settingsManager.getGlobalSettings().hideThinkingBlock,
    setValue: async ({ settingsManager, setHideThinkingBlock }, v) => {
      // Production uses the runtime method so persistence errors are surfaced.
      if (setHideThinkingBlock) await setHideThinkingBlock(v);
      else settingsManager.setHideThinkingBlock(v);
    },
  },
  {
    kind: "enum",
    label: "defaultProvider",
    section: "pi",
    defaultValue: "anthropic",
    getValue: ({ settingsManager }) => settingsManager.getDefaultProvider(),
    getOptions: ({ availableModels }) => [...new Set(availableModels.map((m) => m.provider))],
    setValue: async ({ settingsManager }, v) => {
      if (v !== undefined) settingsManager.setDefaultProvider(v);
    },
  },
  {
    kind: "enum",
    label: "defaultModel",
    section: "pi",
    defaultValue: "claude-opus-4-5",
    getValue: ({ settingsManager }) => settingsManager.getDefaultModel(),
    // Model ids are provider-scoped in settings; only list models for defaultProvider.
    getOptions: ({ availableModels, settingsManager }) => {
      const provider = settingsManager.getDefaultProvider();
      const models = provider
        ? availableModels.filter((m) => m.provider === provider)
        : availableModels;
      return [...new Set(models.map((m) => m.modelId))];
    },
    setValue: async ({ settingsManager }, v) => {
      if (v !== undefined) settingsManager.setDefaultModel(v);
    },
  },
  {
    kind: "boolean",
    label: "retry.enabled",
    section: "pi",
    defaultValue: true,
    // Global file field only (project overrides still affect runtime, but panel edits global).
    getValue: ({ settingsManager }) => settingsManager.getGlobalSettings().retry?.enabled,
    setValue: async ({ settingsManager }, v) => {
      settingsManager.setRetryEnabled(v);
    },
  },
  {
    kind: "number",
    label: "retry.maxRetries",
    section: "pi",
    // MixCode raises the effective default from SDK 3 → 10 when unset.
    defaultValue: MIXCODE_RETRY_DEFAULTS.maxRetries,
    getValue: ({ settingsManager }) => getExplicitRetryMaxRetries(settingsManager),
    setValue: async ({ settingsManager, piSettingsFile }, v) => {
      await setRetryMaxRetries(settingsManager, piSettingsFile, v);
    },
  },
  {
    kind: "boolean",
    label: "showImages",
    section: "pi",
    defaultValue: true,
    getValue: ({ settingsManager }) => settingsManager.getGlobalSettings().terminal?.showImages,
    setValue: async ({ settingsManager }, v) => {
      settingsManager.setShowImages(v);
    },
  },
  {
    kind: "number",
    label: "imageWidthCells",
    section: "pi",
    defaultValue: 60,
    getValue: ({ settingsManager }) => {
      const width = settingsManager.getGlobalSettings().terminal?.imageWidthCells;
      return typeof width === "number" && Number.isFinite(width) ? Math.max(1, Math.floor(width)) : undefined;
    },
    setValue: async ({ settingsManager }, v) => {
      if (v === undefined) return;
      settingsManager.setImageWidthCells(v);
    },
  },
  {
    kind: "boolean",
    label: "blockImages",
    section: "pi",
    defaultValue: false,
    getValue: ({ settingsManager }) => settingsManager.getGlobalSettings().images?.blockImages,
    setValue: async ({ settingsManager }, v) => {
      settingsManager.setBlockImages(v);
    },
  },
  {
    kind: "enum",
    label: "markdown.mermaid",
    section: "pi",
    defaultValue: "streaming",
    getValue: ({ settingsManager }) => settingsManager.getMermaidRenderingMode(),
    getOptions: () => ["off", "final", "streaming"],
    setValue: async ({ settingsManager }, v) => {
      if (v === "off" || v === "final" || v === "streaming") {
        settingsManager.setMermaidRenderingMode(v);
      }
    },
  },
  // Theme is file-backed in mixcode_settings.json; live UI still uses state.theme.
  {
    kind: "enum",
    label: "theme",
    section: "mixcode",
    defaultValue: DEFAULT_THEME_ID,
    // undefined => not explicitly set in the file => dim default display
    getValue: ({ mixcodeRaw }) => mixcodeRaw.theme,
    getOptions: () => listThemeInfos().map((theme) => theme.id),
    setValue: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined) delete next.theme;
      else next.theme = v;
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
      // Live preview: apply default when clearing, else the chosen id.
      setTheme(ctx.state, v ?? DEFAULT_THEME_ID);
    },
  },
  {
    kind: "number",
    label: "history.maxBytes",
    section: "mixcode",
    defaultValue: DEFAULT_HISTORY_MAX_BYTES,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.history?.maxBytes,
    setValue: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined) delete next.history;
      else next.history = { ...next.history, maxBytes: v };
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
  {
    kind: "enum",
    label: "icons.mode",
    section: "mixcode",
    defaultValue: DEFAULT_ICON_MODE,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.ui?.icons?.mode,
    getOptions: () => [...ICON_MODES],
    setValue: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined) {
        if (next.ui?.icons) {
          const icons = { ...next.ui.icons };
          delete icons.mode;
          const ui = { ...next.ui };
          if (Object.keys(icons).length > 0) ui.icons = icons;
          else delete ui.icons;
          if (Object.keys(ui).length > 0) next.ui = ui;
          else delete next.ui;
        }
      } else {
        next.ui = {
          ...next.ui,
          icons: { ...next.ui?.icons, mode: v as IconMode },
        };
      }
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
  {
    kind: "boolean",
    label: "oversized.enabled",
    section: "mixcode",
    defaultValue: DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.enabled,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.ui?.oversizedAssistantMessage?.enabled,
    setValue: async (ctx, v) => {
      const next = mergeOversized(ctx.mixcodeRaw, { enabled: v });
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
  {
    kind: "number",
    label: "oversized.maxLines",
    section: "mixcode",
    defaultValue: DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.maxLines,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.ui?.oversizedAssistantMessage?.maxLines,
    setValue: async (ctx, v) => {
      const next = mergeOversized(ctx.mixcodeRaw, { maxLines: v });
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
  {
    kind: "number",
    label: "oversized.maxBytes",
    section: "mixcode",
    defaultValue: DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.maxBytes,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.ui?.oversizedAssistantMessage?.maxBytes,
    setValue: async (ctx, v) => {
      const next = mergeOversized(ctx.mixcodeRaw, { maxBytes: v });
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
  {
    kind: "multi-enum",
    label: "disabledProviders",
    section: "mixcode",
    defaultValue: [],
    getValues: ({ mixcodeRaw }) => mixcodeRaw.disabledProviders,
    // Full configured set (includes currently disabled) so users can re-enable.
    getOptions: ({ availableModels }) =>
      [...new Set(availableModels.map((m) => m.provider).filter((p) => p !== "faux"))].sort(),
    setValues: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined || v.length === 0) delete next.disabledProviders;
      else next.disabledProviders = v;
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
  {
    kind: "multi-enum",
    label: "disabledModels",
    section: "mixcode",
    defaultValue: [],
    getValues: ({ mixcodeRaw }) => mixcodeRaw.disabledModels,
    getOptions: ({ availableModels }) =>
      availableModels
        .filter((m) => m.provider !== "faux")
        .map((m) => `${m.provider}/${m.modelId}`)
        .sort(),
    setValues: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined || v.length === 0) delete next.disabledModels;
      else next.disabledModels = v;
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
    },
  },
];

function replaceRaw(target: RawMixCodeSettings, next: RawMixCodeSettings): void {
  for (const k of Object.keys(target)) delete (target as Record<string, unknown>)[k];
  Object.assign(target, next);
}

function mergeOversized(
  raw: RawMixCodeSettings,
  patch: { enabled?: boolean; maxLines?: number; maxBytes?: number },
): RawMixCodeSettings {
  const prev = raw.ui?.oversizedAssistantMessage ?? {};
  const merged = { ...prev, ...patch };
  for (const k of Object.keys(merged) as (keyof typeof merged)[]) {
    if (merged[k] === undefined) delete merged[k];
  }
  const result: RawMixCodeSettings = { ...raw };
  if (Object.keys(merged).length > 0) {
    result.ui = { ...raw.ui, oversizedAssistantMessage: merged };
  } else {
    const ui = { ...raw.ui };
    delete ui.oversizedAssistantMessage;
    if (Object.keys(ui).length > 0) result.ui = ui;
    else delete result.ui;
  }
  return result;
}

// ─── Open / close ────────────────────────────────────────────────────────────

export async function openSettingsPanel(
  state: MixCodeState,
  tui: OverlayTui,
  settingsManager: SettingsManager,
  mixcodeFile: string,
  piSettingsFile: string,
  runtimeRef: {
    setHideThinkingBlock?: (hide: boolean) => Promise<void>;
  },
): Promise<void> {
  const mixcodeRaw = await loadRawMixCodeSettings(mixcodeFile);
  state.settingsPanel = {
    open: true,
    selectedIndex: 0,
    editMode: false,
    editText: "",
    editError: undefined,
    enumOpen: false,
    enumIndex: 0,
    mixcodeRaw,
    mixcodeFile,
    piSettingsFile,
    settingsManager,
    setHideThinkingBlock: runtimeRef.setHideThinkingBlock,
  };
  refreshSettingsPanel(state, tui);
}

export function closeSettingsPanel(state: MixCodeState, tui: OverlayTui): void {
  state.settingsPanel.open = false;
  state.settingsPanel.editMode = false;
  state.settingsPanel.enumOpen = false;
  closeAppOverlay(tui);
  tui.requestRender();
}

function refreshSettingsPanel(state: MixCodeState, tui: OverlayTui): void {
  showLinesOverlay(tui, (width) => renderSettingsPanel(state, width));
  tui.requestRender();
}

/**
 * Settings writes hit the persistent store first; live UI reads from MixCodeState.
 * Mirror the written values into state so the change is visible without restart.
 */
function applyLiveEffects(state: MixCodeState): void {
  const panel = state.settingsPanel;
  if (panel.settingsManager) {
    const sm = panel.settingsManager;
    state.hideThinkingBlock = sm.getHideThinkingBlock();
    state.showImages = sm.getShowImages();
    state.imageWidthCells = sm.getImageWidthCells();
    state.mermaidRenderingMode = sm.getMermaidRenderingMode();
  }
  const raw = panel.mixcodeRaw;
  // Theme: explicit file value, else runtime default (dim path in the panel).
  setTheme(state, raw.theme ?? DEFAULT_THEME_ID);
  const oversized = raw.ui?.oversizedAssistantMessage;
  state.ui = {
    oversizedAssistantMessage: {
      enabled: oversized?.enabled ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.enabled,
      maxLines: oversized?.maxLines ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.maxLines,
      maxBytes: oversized?.maxBytes ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.maxBytes,
    },
    icons: { mode: raw.ui?.icons?.mode ?? DEFAULT_ICON_MODE },
  };
  for (const tab of state.tabs) clearConversationCache(tab.sessionId);
}

// ─── Render ──────────────────────────────────────────────────────────────────

/** Human-facing labels; keys stay stable for persistence. */
const ITEM_LABELS: Record<string, string> = {
  theme: "Theme",
  hideThinkingBlock: "Hide thinking blocks",
  defaultProvider: "Default provider",
  defaultModel: "Default model",
  "retry.enabled": "Auto-retry",
  "retry.maxRetries": "Retry times",
  showImages: "Show images",
  imageWidthCells: "Image width (cells)",
  blockImages: "Block images to model",
  "markdown.mermaid": "Mermaid diagrams",
  "history.maxBytes": "History max bytes",
  "icons.mode": "Icon mode",
  "oversized.enabled": "Collapse oversized messages",
  "oversized.maxLines": "Oversized max lines",
  "oversized.maxBytes": "Oversized max bytes",
  disabledProviders: "Disabled providers",
  disabledModels: "Disabled models",
};

export function renderSettingsPanel(state: MixCodeState, width: number): string[] {
  return renderWithTheme(themeForId(state.theme), () => renderSettingsPanelInner(state, width));
}

function renderSettingsPanelInner(state: MixCodeState, width: number): string[] {
  const panel = state.settingsPanel;
  const ctx = panelCtx(state);
  if (!ctx) return overlayPanel("Settings", ["Settings manager not available."], width);

  const t = activeRenderTheme;
  const dim = (s: string) => t.dim(s);
  const accent = (s: string) => t.accent(s);
  const sel = (s: string) => t.selectedBg(s);
  const innerWidth = Math.max(1, width - 2);

  // Label left / value right, same density as command palette rows.
  const markerWidth = 2;
  const gap = 2;
  const labelCol = Math.max(18, Math.min(32, Math.floor((innerWidth - markerWidth - gap) * 0.55)));
  const valueCol = Math.max(8, innerWidth - markerWidth - gap - labelCol);

  const sectionHeader = (title: string) => {
    const left = ` ${title} `;
    const fill = Math.max(0, innerWidth - visibleWidth(left));
    return dim(`${left}${"─".repeat(fill)}`);
  };
  const pathLine = (filePath: string) =>
    dim(`  ${formatSettingsPath(filePath, Math.max(1, innerWidth - 2))}`);

  // Enum open: compact single-item view so the options window fits under the
  // overlay maxHeight instead of head-clipping the caret on short terminals.
  if (panel.enumOpen) {
    const item = ITEMS[panel.selectedIndex];
    if (item?.kind === "enum" || item?.kind === "multi-enum") {
      return overlayPanel(
        "Settings",
        renderEnumFocusLines(panel, ctx, item, {
          dim,
          accent,
          sel,
          innerWidth,
          labelCol,
          valueCol,
          gap,
          sectionHeader,
          pathLine,
        }),
        width,
      );
    }
  }

  // Main list: render only a window around selectedIndex so short terminals
  // don't head-clip the caret / footer (TUI overlay maxHeight is ~80%).
  return overlayPanel(
    "Settings",
    renderMainSettingsLines(panel, ctx, {
      dim,
      accent,
      sel,
      innerWidth,
      labelCol,
      valueCol,
      gap,
      sectionHeader,
      pathLine,
    }),
    width,
  );
}

function settingsOverlayBodyBudget(): number {
  const termRows = process.stdout.rows || 24;
  // defaultOverlayOptions maxHeight "80%", minus top/bottom borders.
  return Math.max(6, Math.floor(termRows * 0.8) - 2);
}

function renderMainSettingsLines(
  panel: SettingsPanelState,
  ctx: PanelCtx,
  ui: {
    dim: (s: string) => string;
    accent: (s: string) => string;
    sel: (s: string) => string;
    innerWidth: number;
    labelCol: number;
    valueCol: number;
    gap: number;
    sectionHeader: (title: string) => string;
    pathLine: (filePath: string) => string;
  },
): string[] {
  const { dim, accent, sel, innerWidth, labelCol, valueCol, gap, sectionHeader, pathLine } = ui;
  const footerHint = panel.editError
    ? dim(`  ${panel.editError}  ⏎ retry  esc cancel`)
    : dim("  ↑↓ select  ⏎ edit/toggle  esc close");
  const footer = ["", footerHint];
  const bodyBudget = Math.max(4, settingsOverlayBodyBudget() - footer.length);

  // Build flat item rows first (no section headers yet), then window them.
  const itemRows = ITEMS.map((item, idx) => {
    const isSelected = idx === panel.selectedIndex;
    const marker = isSelected ? accent("› ") : "  ";
    const label = ITEM_LABELS[item.label] ?? item.label;
    const multiValues = item.kind === "multi-enum" ? item.getValues(ctx) : undefined;
    const rawValue = item.kind === "multi-enum" ? multiValues : item.getValue(ctx);
    const isSet = rawValue !== undefined;
    const editing = isSelected && panel.editMode && item.kind === "number";

    let valuePlain: string;
    if (editing) {
      valuePlain = `${panel.editText}█`;
    } else if (item.kind === "boolean") {
      valuePlain = formatBool((isSet ? rawValue : item.defaultValue) as boolean);
    } else if (item.kind === "number") {
      valuePlain = formatNumber((isSet ? rawValue : item.defaultValue) as number);
    } else if (item.kind === "multi-enum") {
      const vals = multiValues ?? item.defaultValue;
      valuePlain =
        vals.length === 0 ? "none  (default)" : `${vals.length} selected · /reload`;
    } else {
      valuePlain = String(isSet ? rawValue : item.defaultValue);
    }
    if (!isSet && !editing && item.kind !== "multi-enum") valuePlain = `${valuePlain}  (default)`;

    const labelText = truncateToWidth(label, labelCol, "…");
    const valueText = truncateToWidth(valuePlain, valueCol, "…");
    const valueColored =
      !isSet && !editing
        ? dim(valueText)
        : item.kind === "boolean" && valuePlain.startsWith("On")
          ? accent(valueText)
          : item.kind === "boolean"
            ? dim(valueText)
            : valueText;

    const labelPadded = labelText + " ".repeat(Math.max(0, labelCol - visibleWidth(labelText)));
    const row = `${marker}${labelPadded}${" ".repeat(gap)}${valueColored}`;
    return {
      idx,
      section: item.section,
      line: isSelected ? sel(padLine(row, innerWidth)) : row,
    };
  });

  // Prefer showing as many items as fit; reserve 2 lines for active section header+path
  // and 2 for more-above/below markers when needed.
  const maxItems = Math.max(3, bodyBudget - 4);
  const start = windowStart(panel.selectedIndex, itemRows.length, maxItems);
  const end = Math.min(start + maxItems, itemRows.length);
  const slice = itemRows.slice(start, end);

  const lines: string[] = [];
  let shownPi = false;
  let shownMixcode = false;
  if (start > 0) lines.push(dim(`  ... (${start} more above)`));

  for (const row of slice) {
    if (row.section === "pi" && !shownPi) {
      shownPi = true;
      lines.push(sectionHeader("Pi"));
      lines.push(pathLine(panel.piSettingsFile));
    }
    if (row.section === "mixcode" && !shownMixcode) {
      shownMixcode = true;
      if (lines.length > 0 && !lines[lines.length - 1]!.includes("more above")) {
        // Keep a blank separator only when both sections are visible and budget allows.
        if (shownPi) lines.push("");
      }
      lines.push(sectionHeader("Mixcode"));
      lines.push(pathLine(panel.mixcodeFile));
    }
    lines.push(row.line);
  }

  if (end < itemRows.length) lines.push(dim(`  ... (${itemRows.length - end} more below)`));

  // If chrome pushed us over budget, drop blank separators first then trim head
  // while keeping the selected row if possible.
  while (lines.length > bodyBudget) {
    const blank = lines.indexOf("");
    if (blank >= 0) {
      lines.splice(blank, 1);
      continue;
    }
    // Drop oldest non-selected chrome/item from the top.
    const dropAt = lines.findIndex((l, i) => i > 0 && !l.includes("›"));
    if (dropAt >= 0) lines.splice(dropAt, 1);
    else break;
  }

  lines.push(...footer);
  return lines;
}

function renderEnumFocusLines(
  panel: SettingsPanelState,
  ctx: PanelCtx,
  item: EnumItem | MultiEnumItem,
  ui: {
    dim: (s: string) => string;
    accent: (s: string) => string;
    sel: (s: string) => string;
    innerWidth: number;
    labelCol: number;
    valueCol: number;
    gap: number;
    sectionHeader: (title: string) => string;
    pathLine: (filePath: string) => string;
  },
): string[] {
  const { dim, accent, sel, innerWidth, labelCol, valueCol, gap, sectionHeader, pathLine } = ui;
  const sectionTitle = item.section === "pi" ? "Pi" : "Mixcode";
  const filePath = item.section === "pi" ? panel.piSettingsFile : panel.mixcodeFile;
  const label = ITEM_LABELS[item.label] ?? item.label;
  const multiSelected =
    item.kind === "multi-enum" ? new Set(item.getValues(ctx) ?? item.defaultValue) : undefined;
  const rawValue = item.kind === "enum" ? item.getValue(ctx) : item.getValues(ctx);
  const isSet = rawValue !== undefined;
  let valuePlain =
    item.kind === "multi-enum"
      ? multiSelected!.size === 0
        ? "none  (default)"
        : `${multiSelected!.size} selected · /reload`
      : String(isSet ? rawValue : item.defaultValue);
  if (item.kind === "enum" && !isSet) valuePlain = `${valuePlain}  (default)`;
  const labelText = truncateToWidth(label, labelCol, "…");
  const valueText = truncateToWidth(valuePlain, valueCol, "…");
  const valueColored = !isSet ? dim(valueText) : valueText;
  const labelPadded = labelText + " ".repeat(Math.max(0, labelCol - visibleWidth(labelText)));
  const row = `${accent("› ")}${labelPadded}${" ".repeat(gap)}${valueColored}`;

  const lines: string[] = [
    sectionHeader(sectionTitle),
    pathLine(filePath),
    sel(padLine(row, innerWidth)),
  ];

  const opts = item.getOptions(ctx);
  if (opts.length === 0) {
    lines.push(dim("    (no options available)"));
  } else {
    // Fit under default overlay maxHeight (~80% of terminal). Chrome is:
    // top/bottom borders + section + path + parent row + optional more
    // markers + blank + footer.
    const termRows = process.stdout.rows || 24;
    const overlayCap = Math.max(8, Math.floor(termRows * 0.8));
    const chromeRows = 9; // borders(2)+section+path+parent+more*2+blank+footer
    const maxVisible = Math.max(3, Math.min(10, overlayCap - chromeRows));
    const startIndex = windowStart(panel.enumIndex, opts.length, maxVisible);
    const endIndex = Math.min(startIndex + maxVisible, opts.length);
    if (startIndex > 0) {
      lines.push(dim(`    ... (${startIndex} more above)`));
    }
    for (let oi = startIndex; oi < endIndex; oi++) {
      const opt = opts[oi]!;
      const optSelected = oi === panel.enumIndex;
      const optMarker = optSelected ? accent("› ") : "  ";
      const checked =
        item.kind === "multi-enum" ? (multiSelected!.has(opt) ? "[x] " : "[ ] ") : "";
      const optRow = `  ${optMarker}${checked}${truncateToWidth(opt, Math.max(1, innerWidth - 4 - checked.length), "…")}`;
      lines.push(optSelected ? sel(padLine(optRow, innerWidth)) : dim(optRow));
    }
    if (endIndex < opts.length) {
      lines.push(dim(`    ... (${opts.length - endIndex} more below)`));
    }
  }

  lines.push(
    "",
    dim(
      item.kind === "multi-enum"
        ? "  ↑↓ move  ⏎ toggle  esc back · takes effect on /reload"
        : "  ↑↓ select  ⏎ choose  esc back",
    ),
  );
  return lines;
}

function formatBool(v: boolean): string {
  return v ? "On" : "Off";
}

function formatNumber(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KB`;
  return String(n);
}

function isByteSizeSetting(item: SettingItem | undefined): boolean {
  return item?.kind === "number" && item.label.endsWith("maxBytes");
}

/** Parse settings number fields; accept 5m/5mb/5k/5kb only for byte fields. */
function parseSettingsNumber(raw: string, allowByteUnits = false): number | undefined {
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return undefined;
  const match = allowByteUnits
    ? /^(\d+)\s*(mb|m|kb|k|b)?$/.exec(trimmed)
    : /^(\d+)$/.exec(trimmed);
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const unit = allowByteUnits ? (match[2] ?? "") : "";
  if (unit === "mb" || unit === "m") return n * 1024 * 1024;
  if (unit === "kb" || unit === "k") return n * 1024;
  return n;
}

function settingsNumberEditPrefill(value: number | undefined, allowByteUnits = false): string {
  if (value === undefined) return "";
  // Prefill byte fields with the same compact unit shown in the list so
  // editing 5 MB is not mistaken for 5 bytes.
  if (allowByteUnits) {
    if (value >= 1024 * 1024 && value % (1024 * 1024) === 0) return `${value / (1024 * 1024)}mb`;
    if (value >= 1024 && value % 1024 === 0) return `${value / 1024}kb`;
  }
  return String(value);
}

/** Collapse $HOME to ~, then middle-truncate if longer than maxWidth. */
export function formatSettingsPath(filePath: string, maxWidth: number): string {
  if (!filePath) return "";
  const home = (process.env.HOME || os.homedir());
  const display =
    home && (filePath === home || filePath.startsWith(`${home}/`))
      ? `~${filePath.slice(home.length)}`
      : filePath;
  if (visibleWidth(display) <= maxWidth) return display;
  if (maxWidth <= 1) return "…";
  // Keep head + tail around a single ellipsis.
  const ellipsis = "…";
  const budget = maxWidth - visibleWidth(ellipsis);
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  // Character-based split is fine for path ASCII; visibleWidth handles edge cases.
  return `${display.slice(0, head)}${ellipsis}${display.slice(display.length - tail)}`;
}

function panelCtx(state: MixCodeState): PanelCtx | undefined {
  const panel = state.settingsPanel;
  if (!panel.settingsManager) return undefined;
  return {
    state,
    settingsManager: panel.settingsManager,
    mixcodeRaw: panel.mixcodeRaw,
    mixcodeFile: panel.mixcodeFile,
    piSettingsFile: panel.piSettingsFile,
    setHideThinkingBlock: panel.setHideThinkingBlock,
    availableModels: state.availableModels,
  };
}

// ─── Key handler ─────────────────────────────────────────────────────────────

export function handleSettingsPanelKey(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
): boolean {
  if (!state.settingsPanel.open) return false;
  if (isKeyRelease(data)) return true;

  const panel = state.settingsPanel;
  if (panel.editMode) {
    handleEdit(state, data, tui, panel);
    return true;
  }
  if (panel.enumOpen) {
    handleEnum(state, data, tui, panel);
    return true;
  }
  handleNormal(state, data, tui, panel);
  return true;
}

function saveSetting(
  state: MixCodeState,
  tui: OverlayTui,
  item: SettingItem,
  ctx: PanelCtx,
  write: () => Promise<void>,
  onSuccess: () => void,
): void {
  state.settingsPanel.editError = undefined;
  void (async () => {
    try {
      await write();
      await ctx.settingsManager.flush();
      const errors = ctx.settingsManager.drainErrors();
      if (errors.length > 0) {
        throw new Error(errors.map(({ scope, error }) => `${scope}: ${error.message}`).join("; "));
      }
      onSuccess();
    } catch (error) {
      const messages = [error instanceof Error ? error.message : String(error)];
      try {
        await ctx.settingsManager.reload();
        messages.push(
          ...ctx.settingsManager
            .drainErrors()
            .map(({ scope, error: reloadError }) => `${scope}: ${reloadError.message}`),
        );
      } catch (reloadError) {
        messages.push(
          `reload failed: ${reloadError instanceof Error ? reloadError.message : String(reloadError)}`,
        );
      }
      applyLiveEffects(state);
      const label = ITEM_LABELS[item.label] ?? item.label;
      state.settingsPanel.editError = `Failed to save ${label}: ${messages.join("; ")}`;
      refreshSettingsPanel(state, tui);
    }
  })();
}

function handleNormal(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  panel: SettingsPanelState,
): void {
  if (matchesKey(data, "up") || data === "\x1b[A") {
    panel.selectedIndex = Math.max(0, panel.selectedIndex - 1);
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "down") || data === "\x1b[B") {
    panel.selectedIndex = Math.min(ITEMS.length - 1, panel.selectedIndex + 1);
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "return") || data === "\r" || data === "\n") {
    const item = ITEMS[panel.selectedIndex];
    const ctx = panelCtx(state);
    if (!item || !ctx) return;
    if (item.kind === "boolean") {
      const cur = item.getValue(ctx) ?? item.defaultValue;
      saveSetting(
        state,
        tui,
        item,
        ctx,
        () => item.setValue(ctx, !cur),
        () => {
          applyLiveEffects(state);
          refreshSettingsPanel(state, tui);
        },
      );
    } else if (item.kind === "number") {
      const cur = item.getValue(ctx);
      panel.editMode = true;
      panel.editText = settingsNumberEditPrefill(cur, isByteSizeSetting(item));
      refreshSettingsPanel(state, tui);
    } else if (item.kind === "enum" || item.kind === "multi-enum") {
      const opts = item.getOptions(ctx);
      panel.enumOpen = true;
      if (item.kind === "enum") {
        const cur = item.getValue(ctx) ?? item.defaultValue;
        panel.enumIndex = Math.max(0, opts.indexOf(cur));
        // Theme: start browse preview on the currently highlighted option.
        if (item.label === "theme") {
          const preview = opts[panel.enumIndex] ?? cur;
          if (preview) setTheme(state, preview);
        }
      } else {
        panel.enumIndex = 0;
      }
      refreshSettingsPanel(state, tui);
    }
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    closeSettingsPanel(state, tui);
  }
}

function handleEdit(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  panel: SettingsPanelState,
): void {
  if (matchesKey(data, "return") || data === "\r" || data === "\n") {
    const item = ITEMS[panel.selectedIndex] as NumberItem | undefined;
    const ctx = panelCtx(state);
    if (item?.kind === "number" && ctx) {
      const trimmed = panel.editText.trim();
      // Empty input clears the explicit override (restore default).
      if (trimmed === "") {
        saveSetting(
          state,
          tui,
          item,
          ctx,
          () => item.setValue(ctx, undefined),
          () => {
            applyLiveEffects(state);
            panel.editMode = false;
            panel.editText = "";
            panel.editError = undefined;
            refreshSettingsPanel(state, tui);
          },
        );
        return;
      }
      const parsed = parseSettingsNumber(trimmed, isByteSizeSetting(item));
      // Non-empty invalid input stays in edit mode with an inline footer error.
      if (parsed === undefined) {
        panel.editError = isByteSizeSetting(item)
          ? `Invalid number: "${trimmed}" (use N, Nkb, or Nmb)`
          : `Invalid number: "${trimmed}" (positive integer)`;
        refreshSettingsPanel(state, tui);
        return;
      }
      saveSetting(
        state,
        tui,
        item,
        ctx,
        () => item.setValue(ctx, parsed),
        () => {
          applyLiveEffects(state);
          panel.editMode = false;
          panel.editText = "";
          panel.editError = undefined;
          refreshSettingsPanel(state, tui);
        },
      );
      return;
    }
    panel.editMode = false;
    panel.editText = "";
    panel.editError = undefined;
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    panel.editMode = false;
    panel.editText = "";
    panel.editError = undefined;
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "backspace") || data === "\x7f") {
    panel.editText = panel.editText.slice(0, -1);
    panel.editError = undefined;
    refreshSettingsPanel(state, tui);
  } else if (data.length === 1 && /[\d.a-zA-Z]/.test(data)) {
    panel.editText += data;
    panel.editError = undefined;
    refreshSettingsPanel(state, tui);
  }
}

function handleEnum(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  panel: SettingsPanelState,
): void {
  const item = ITEMS[panel.selectedIndex];
  const ctx = panelCtx(state);
  if (!item || !ctx || (item.kind !== "enum" && item.kind !== "multi-enum")) return;
  const opts = item.getOptions(ctx);

  if (matchesKey(data, "up") || data === "\x1b[A") {
    panel.enumIndex = Math.max(0, panel.enumIndex - 1);
    if (item.kind === "enum") previewEnumSelection(state, item, opts[panel.enumIndex]);
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "down") || data === "\x1b[B") {
    panel.enumIndex = Math.min(Math.max(0, opts.length - 1), panel.enumIndex + 1);
    if (item.kind === "enum") previewEnumSelection(state, item, opts[panel.enumIndex]);
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "return") || data === "\r" || data === "\n") {
    if (item.kind === "multi-enum") {
      const current = new Set(item.getValues(ctx) ?? []);
      const opt = opts[panel.enumIndex];
      if (opt) {
        if (current.has(opt)) current.delete(opt);
        else current.add(opt);
      }
      const next = [...current].sort();
      saveSetting(
        state,
        tui,
        item,
        ctx,
        () => item.setValues(ctx, next.length > 0 ? next : undefined),
        () => refreshSettingsPanel(state, tui),
      );
      return;
    }
    saveSetting(
      state,
      tui,
      item,
      ctx,
      () => item.setValue(ctx, opts[panel.enumIndex]),
      () => {
        applyLiveEffects(state);
        panel.enumOpen = false;
        refreshSettingsPanel(state, tui);
      },
    );
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    // Cancel browse preview for theme: restore the persisted/file value.
    if (item.kind === "enum" && item.label === "theme") {
      setTheme(state, ctx.mixcodeRaw.theme ?? DEFAULT_THEME_ID);
    }
    panel.enumOpen = false;
    refreshSettingsPanel(state, tui);
  }
}

/** Live-preview enum values that only affect UI (currently theme). */
function previewEnumSelection(
  state: MixCodeState,
  item: EnumItem,
  value: string | undefined,
): void {
  if (item.label !== "theme" || value === undefined) return;
  setTheme(state, value);
}
