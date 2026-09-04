/**
 * /settings — floating overlay in upstream pi component style: filter / edit /
 * enum state lives in the SettingsPanel class, input arrives via TUI focus,
 * and app state keeps only the routing flag (state.settingsPanel.open).
 */

import { matchesKey, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { homeDir } from "../../core/paths.js";
import {
  DEFAULT_BOXED_HIDDEN_THINKING,
  DEFAULT_ICON_MODE,
  DEFAULT_INLINE_WIDGETS,
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
  ICON_MODES,
  loadRawMixCodeSettings,
  writeRawMixCodeSettings,
  type IconMode,
  type RawMixCodeSettings,
} from "../../core/mixcode-settings.js";
import type { MixCodeModelRef, MixCodeState } from "../../core/types.js";
import type { OverlayTui } from "../app-types.js";
import { appOverlayComponent, closeAppOverlay, showComponentOverlay } from "../app-overlays.js";
import { clearConversationCache } from "../rendering/agent-surface.js";
import { activeRenderTheme, renderWithTheme } from "../rendering/context.js";
import { overlayPanel, padLine } from "../rendering/primitives.js";
import { windowStart } from "../rendering/scroll-window.js";
import {
  getExplicitRetryMaxRetries,
  MIXCODE_RETRY_DEFAULTS,
  setRetryMaxRetries,
} from "../../agent/retry-settings.js";
import { DEFAULT_THEME_ID } from "../../core/defaults.js";
import { fuzzyMatch } from "../../core/fuzzy.js";
import { listThemeInfos, setTheme, themeForId } from "../themes.js";

// ─── Setting item descriptors ────────────────────────────────────────────────

interface PanelCtx {
  state: MixCodeState;
  settingsManager: SettingsManager;
  mixcodeRaw: RawMixCodeSettings;
  mixcodeFile: string;
  piSettingsFile: string;
  setHideThinkingBlock?: (hide: boolean) => Promise<void>;
  setShowCacheMissNotices?: (show: boolean) => Promise<void>;
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
      return typeof width === "number" && Number.isFinite(width)
        ? Math.max(1, Math.floor(width))
        : undefined;
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
  {
    kind: "boolean",
    label: "showCacheMissNotices",
    section: "pi",
    defaultValue: false,
    getValue: ({ settingsManager }) => settingsManager.getGlobalSettings().showCacheMissNotices,
    setValue: async ({ settingsManager, setShowCacheMissNotices }, v) => {
      if (setShowCacheMissNotices) await setShowCacheMissNotices(v);
      else settingsManager.setShowCacheMissNotices(v);
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
  {
    kind: "boolean",
    label: "inlineWidgets",
    section: "mixcode",
    defaultValue: DEFAULT_INLINE_WIDGETS,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.ui?.inlineWidgets,
    setValue: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined) {
        if (next.ui) {
          const ui = { ...next.ui };
          delete ui.inlineWidgets;
          if (Object.keys(ui).length > 0) next.ui = ui;
          else delete next.ui;
        }
      } else {
        next.ui = { ...next.ui, inlineWidgets: v };
      }
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
      const enabled = v === true;
      if (ctx.state.ui) ctx.state.ui.inlineWidgets = enabled;
    },
  },
  {
    kind: "boolean",
    label: "boxedHiddenThinking",
    section: "mixcode",
    defaultValue: DEFAULT_BOXED_HIDDEN_THINKING,
    getValue: ({ mixcodeRaw }) => mixcodeRaw.ui?.boxedHiddenThinking,
    setValue: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined) {
        if (next.ui) {
          const ui = { ...next.ui };
          delete ui.boxedHiddenThinking;
          if (Object.keys(ui).length > 0) next.ui = ui;
          else delete next.ui;
        }
      } else {
        next.ui = { ...next.ui, boxedHiddenThinking: v };
      }
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
      replaceRaw(ctx.mixcodeRaw, next);
      if (ctx.state.ui) ctx.state.ui.boxedHiddenThinking = v === true;
      for (const tab of ctx.state.tabs) clearConversationCache(tab.sessionId);
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

export interface SettingsPanelDeps {
  /** Read-only render source (theme, models) and live-effect target. */
  state: MixCodeState;
  tui: OverlayTui;
  settingsManager: SettingsManager;
  /** Production persistence paths so write errors surface and live state stays synchronized. */
  setHideThinkingBlock?: (hide: boolean) => Promise<void>;
  setShowCacheMissNotices?: (show: boolean) => Promise<void>;
}

export class SettingsPanel implements Component {
  selectedIndex = 0;
  filterQuery = "";
  editMode = false;
  editText = "";
  /** Inline validation error shown in the settings footer while editing. */
  editError?: string;
  enumOpen = false;
  enumIndex = 0;
  /** Snapshot of raw mixcode settings; mutated in place on write. */
  mixcodeRaw: RawMixCodeSettings;
  mixcodeFile: string;
  /** Absolute path to Pi global settings.json (display only). */
  piSettingsFile: string;

  constructor(
    readonly deps: SettingsPanelDeps,
    init: { mixcodeRaw: RawMixCodeSettings; mixcodeFile: string; piSettingsFile: string },
  ) {
    this.mixcodeRaw = init.mixcodeRaw;
    this.mixcodeFile = init.mixcodeFile;
    this.piSettingsFile = init.piSettingsFile;
  }

  invalidate(): void {}

  render(width: number): string[] {
    return renderWithTheme(themeForId(this.deps.state.theme), () =>
      renderSettingsPanelInner(this, width),
    );
  }

  handleInput(data: string): void {
    if (this.editMode) {
      handleEdit(this, data);
      return;
    }
    if (this.enumOpen) {
      handleEnum(this, data);
      return;
    }
    handleNormal(this, data);
  }
}

const liveSettingsPanels = new WeakMap<MixCodeState, SettingsPanel>();

export function getSettingsPanelComponent(state: MixCodeState): SettingsPanel | undefined {
  return liveSettingsPanels.get(state);
}

export function presentSettingsPanel(state: MixCodeState, tui: OverlayTui): void {
  const panel = liveSettingsPanels.get(state);
  if (!panel || !state.settingsPanel.open) return;
  const owner = state.settingsPanel.ownerSessionId;
  const live = !owner || owner === state.activeTabId;
  if (live) {
    showComponentOverlay(tui, panel);
    tui.requestRender();
    return;
  }
  if (appOverlayComponent(tui) === panel) closeAppOverlay(tui);
}

export async function openSettingsPanel(
  state: MixCodeState,
  tui: OverlayTui,
  settingsManager: SettingsManager,
  mixcodeFile: string,
  piSettingsFile: string,
  runtimeRef: {
    setHideThinkingBlock?: (hide: boolean) => Promise<void>;
    setShowCacheMissNotices?: (show: boolean) => Promise<void>;
  },
  ownerSessionId = state.activeTabId,
): Promise<SettingsPanel> {
  const mixcodeRaw = await loadRawMixCodeSettings(mixcodeFile);
  const panel = new SettingsPanel(
    {
      state,
      tui,
      settingsManager,
      setHideThinkingBlock: runtimeRef.setHideThinkingBlock,
      setShowCacheMissNotices: runtimeRef.setShowCacheMissNotices,
    },
    { mixcodeRaw, mixcodeFile, piSettingsFile },
  );
  state.settingsPanel = { open: true, ownerSessionId };
  liveSettingsPanels.set(state, panel);
  presentSettingsPanel(state, tui);
  return panel;
}

export function closeSettingsPanel(state: MixCodeState, tui: OverlayTui): void {
  const panel = liveSettingsPanels.get(state);
  state.settingsPanel.open = false;
  state.settingsPanel.ownerSessionId = undefined;
  liveSettingsPanels.delete(state);
  if (panel && appOverlayComponent(tui) === panel) closeAppOverlay(tui);
  tui.requestRender();
}

function refreshSettingsPanel(panel: SettingsPanel): void {
  panel.deps.tui.requestRender();
}

/**
 * Settings writes hit the persistent store first; live UI reads from MixCodeState.
 * Mirror the written values into state so the change is visible without restart.
 */
function applyLiveEffects(panel: SettingsPanel): void {
  const state = panel.deps.state;
  const sm = panel.deps.settingsManager;
  state.hideThinkingBlock = sm.getHideThinkingBlock();
  state.showImages = sm.getShowImages();
  state.imageWidthCells = sm.getImageWidthCells();
  state.mermaidRenderingMode = sm.getMermaidRenderingMode();
  const raw = panel.mixcodeRaw;
  // Theme: explicit file value, else runtime default (dim path in the panel).
  setTheme(panel.deps.state, raw.theme ?? DEFAULT_THEME_ID);
  const oversized = raw.ui?.oversizedAssistantMessage;
  state.ui = {
    oversizedAssistantMessage: {
      enabled: oversized?.enabled ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.enabled,
      maxLines: oversized?.maxLines ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.maxLines,
      maxBytes: oversized?.maxBytes ?? DEFAULT_OVERSIZED_ASSISTANT_MESSAGE.maxBytes,
    },
    icons: { mode: raw.ui?.icons?.mode ?? DEFAULT_ICON_MODE },
    inlineWidgets: raw.ui?.inlineWidgets === true,
    boxedHiddenThinking: raw.ui?.boxedHiddenThinking === true,
  };
  for (const tab of state.tabs) {
    tab.inlineWidgets = state.ui.inlineWidgets;
    clearConversationCache(tab.sessionId);
  }
}

// ─── Render ──────────────────────────────────────────────────────────────────

/** Human-facing labels; keys stay stable for persistence. */
const ITEM_LABELS: Record<string, string> = {
  theme: "Theme",
  hideThinkingBlock: "Hide thinking blocks",
  showCacheMissNotices: "Cache miss notices",
  defaultProvider: "Default provider",
  defaultModel: "Default model",
  "retry.enabled": "Auto-retry",
  "retry.maxRetries": "Retry times",
  showImages: "Show images",
  imageWidthCells: "Image width (cells)",
  blockImages: "Block images to model",
  "markdown.mermaid": "Mermaid diagrams",
  "icons.mode": "Icon mode",
  inlineWidgets: "Inline widgets",
  boxedHiddenThinking: "Boxed hidden thinking",
  "oversized.enabled": "Collapse oversized messages",
  "oversized.maxLines": "Oversized max lines",
  "oversized.maxBytes": "Oversized max bytes",
  disabledProviders: "Disabled providers",
  disabledModels: "Disabled models",
};

function filteredSettingIndexes(panel: SettingsPanel): number[] {
  const query = panel.filterQuery.trim();
  if (!query) return ITEMS.map((_, index) => index);
  return ITEMS.flatMap((item, index) => {
    const label = ITEM_LABELS[item.label] ?? item.label;
    const matchesLabel = fuzzyMatch(query, label) !== undefined;
    const matchesKey = fuzzyMatch(query, item.label) !== undefined;
    return matchesLabel || matchesKey ? [index] : [];
  });
}

function renderSettingsPanelInner(panel: SettingsPanel, width: number): string[] {
  const ctx = panelCtx(panel);

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
  panel: SettingsPanel,
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
  const filterQuery = panel.filterQuery;
  const visibleIndexes = filteredSettingIndexes(panel);
  const filterLine = filterQuery
    ? `  ${dim("filter:")} ${filterQuery}  ${dim(`${visibleIndexes.length}/${ITEMS.length}`)}`
    : dim(`  filter: type to filter  ${ITEMS.length}/${ITEMS.length}`);
  const footerHint = panel.editError
    ? dim(`  ${panel.editError}  ⏎ retry  esc cancel`)
    : dim("  ↑↓ select  ⏎ edit/toggle  type to filter  esc close");
  const footer = ["", footerHint];
  const bodyBudget = Math.max(4, settingsOverlayBodyBudget() - footer.length);

  // Keep absolute ITEMS indexes so writes and existing callers retain their contract.
  const itemRows = visibleIndexes.map((idx) => {
    const item = ITEMS[idx]!;
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
      valuePlain = vals.length === 0 ? "none  (default)" : `${vals.length} selected · /reload`;
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

  if (itemRows.length === 0) {
    return [filterLine, "", dim("  No matching settings"), ...footer];
  }

  // Prefer showing as many items as fit; reserve filter plus active section chrome.
  const maxItems = Math.max(1, bodyBudget - 6);
  const selectedPosition = Math.max(
    0,
    itemRows.findIndex((row) => row.idx === panel.selectedIndex),
  );
  const start = windowStart(selectedPosition, itemRows.length, maxItems);
  const end = Math.min(start + maxItems, itemRows.length);
  const slice = itemRows.slice(start, end);

  const lines: string[] = [filterLine, ""];
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

  // If chrome pushed us over budget, preserve the filter, selected section,
  // selected row, and footer; paths and off-screen detail are expendable first.
  while (lines.length > bodyBudget) {
    const blank = lines.indexOf("");
    if (blank >= 0) {
      lines.splice(blank, 1);
      continue;
    }
    const path = lines.findIndex(
      (line) => line.includes(panel.piSettingsFile) || line.includes(panel.mixcodeFile),
    );
    if (path >= 0) {
      lines.splice(path, 1);
      continue;
    }
    const moreBelow = lines.findIndex((line) => line.includes("more below"));
    if (moreBelow >= 0) {
      lines.splice(moreBelow, 1);
      continue;
    }
    const dropAt = lines.findIndex(
      (line) => !line.includes("›") && !line.includes("filter:") && !line.includes("─"),
    );
    if (dropAt >= 0) lines.splice(dropAt, 1);
    else break;
  }

  lines.push(...footer);
  return lines;
}

function renderEnumFocusLines(
  panel: SettingsPanel,
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
      const checked = item.kind === "multi-enum" ? (multiSelected!.has(opt) ? "[x] " : "[ ] ") : "";
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
  const match = allowByteUnits ? /^(\d+)\s*(mb|m|kb|k|b)?$/.exec(trimmed) : /^(\d+)$/.exec(trimmed);
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
  const home = homeDir();
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

function panelCtx(panel: SettingsPanel): PanelCtx {
  const { state, settingsManager, setHideThinkingBlock, setShowCacheMissNotices } = panel.deps;
  return {
    state,
    settingsManager,
    mixcodeRaw: panel.mixcodeRaw,
    mixcodeFile: panel.mixcodeFile,
    piSettingsFile: panel.piSettingsFile,
    setHideThinkingBlock,
    setShowCacheMissNotices,
    availableModels: state.availableModels,
  };
}

// ─── Key handler ─────────────────────────────────────────────────────────────

function saveSetting(
  panel: SettingsPanel,
  item: SettingItem,
  ctx: PanelCtx,
  write: () => Promise<void>,
  onSuccess: () => void,
): void {
  panel.editError = undefined;
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
      applyLiveEffects(panel);
      const label = ITEM_LABELS[item.label] ?? item.label;
      panel.editError = `Failed to save ${label}: ${messages.join("; ")}`;
      refreshSettingsPanel(panel);
    }
  })();
}

function handleNormal(panel: SettingsPanel, data: string): void {
  const visibleIndexes = filteredSettingIndexes(panel);
  const selectedPosition = visibleIndexes.indexOf(panel.selectedIndex);
  if (matchesKey(data, "up") || data === "\x1b[A") {
    if (visibleIndexes.length === 0) return;
    const nextPosition =
      (Math.max(0, selectedPosition) - 1 + visibleIndexes.length) % visibleIndexes.length;
    panel.selectedIndex = visibleIndexes[nextPosition]!;
    refreshSettingsPanel(panel);
  } else if (matchesKey(data, "down") || data === "\x1b[B") {
    if (visibleIndexes.length === 0) return;
    const nextPosition = (Math.max(-1, selectedPosition) + 1) % visibleIndexes.length;
    panel.selectedIndex = visibleIndexes[nextPosition]!;
    refreshSettingsPanel(panel);
  } else if (matchesKey(data, "return") || data === "\r" || data === "\n") {
    if (!visibleIndexes.includes(panel.selectedIndex)) return;
    const item = ITEMS[panel.selectedIndex];
    const ctx = panelCtx(panel);
    if (!item) return;
    if (item.kind === "boolean") {
      const cur = item.getValue(ctx) ?? item.defaultValue;
      saveSetting(
        panel,
        item,
        ctx,
        () => item.setValue(ctx, !cur),
        () => {
          applyLiveEffects(panel);
          refreshSettingsPanel(panel);
        },
      );
    } else if (item.kind === "number") {
      const cur = item.getValue(ctx);
      panel.editMode = true;
      panel.editText = settingsNumberEditPrefill(cur, isByteSizeSetting(item));
      refreshSettingsPanel(panel);
    } else if (item.kind === "enum" || item.kind === "multi-enum") {
      const opts = item.getOptions(ctx);
      panel.enumOpen = true;
      if (item.kind === "enum") {
        const cur = item.getValue(ctx) ?? item.defaultValue;
        panel.enumIndex = Math.max(0, opts.indexOf(cur));
        // Theme: start browse preview on the currently highlighted option.
        if (item.label === "theme") {
          const preview = opts[panel.enumIndex] ?? cur;
          if (preview) setTheme(panel.deps.state, preview);
        }
      } else {
        panel.enumIndex = 0;
      }
      refreshSettingsPanel(panel);
    }
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    if (panel.filterQuery) {
      updateSettingsFilter(panel, "");
      refreshSettingsPanel(panel);
    } else {
      closeSettingsPanel(panel.deps.state, panel.deps.tui);
    }
  } else if (matchesKey(data, "backspace") || data === "\x7f") {
    updateSettingsFilter(panel, panel.filterQuery.slice(0, -1));
    refreshSettingsPanel(panel);
  } else if (data.length > 0 && !/[\x00-\x1f\x7f]/.test(data)) {
    updateSettingsFilter(panel, panel.filterQuery + data);
    refreshSettingsPanel(panel);
  }
}

function updateSettingsFilter(panel: SettingsPanel, query: string): void {
  panel.filterQuery = query;
  const visibleIndexes = filteredSettingIndexes(panel);
  if (!visibleIndexes.includes(panel.selectedIndex) && visibleIndexes[0] !== undefined) {
    panel.selectedIndex = visibleIndexes[0];
  }
}

function handleEdit(panel: SettingsPanel, data: string): void {
  if (matchesKey(data, "return") || data === "\r" || data === "\n") {
    const item = ITEMS[panel.selectedIndex] as NumberItem | undefined;
    const ctx = panelCtx(panel);
    if (item?.kind === "number") {
      const trimmed = panel.editText.trim();
      // Empty input clears the explicit override (restore default).
      if (trimmed === "") {
        saveSetting(
          panel,
          item,
          ctx,
          () => item.setValue(ctx, undefined),
          () => {
            applyLiveEffects(panel);
            panel.editMode = false;
            panel.editText = "";
            panel.editError = undefined;
            refreshSettingsPanel(panel);
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
        refreshSettingsPanel(panel);
        return;
      }
      saveSetting(
        panel,
        item,
        ctx,
        () => item.setValue(ctx, parsed),
        () => {
          applyLiveEffects(panel);
          panel.editMode = false;
          panel.editText = "";
          panel.editError = undefined;
          refreshSettingsPanel(panel);
        },
      );
      return;
    }
    panel.editMode = false;
    panel.editText = "";
    panel.editError = undefined;
    refreshSettingsPanel(panel);
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    panel.editMode = false;
    panel.editText = "";
    panel.editError = undefined;
    refreshSettingsPanel(panel);
  } else if (matchesKey(data, "backspace") || data === "\x7f") {
    panel.editText = panel.editText.slice(0, -1);
    panel.editError = undefined;
    refreshSettingsPanel(panel);
  } else if (data.length === 1 && /[\d.a-zA-Z]/.test(data)) {
    panel.editText += data;
    panel.editError = undefined;
    refreshSettingsPanel(panel);
  }
}

function handleEnum(panel: SettingsPanel, data: string): void {
  const item = ITEMS[panel.selectedIndex];
  const ctx = panelCtx(panel);
  if (!item || (item.kind !== "enum" && item.kind !== "multi-enum")) return;
  const opts = item.getOptions(ctx);

  if (matchesKey(data, "up") || data === "\x1b[A") {
    panel.enumIndex = opts.length === 0 ? 0 : (panel.enumIndex - 1 + opts.length) % opts.length;
    if (item.kind === "enum") previewEnumSelection(panel, item, opts[panel.enumIndex]);
    refreshSettingsPanel(panel);
  } else if (matchesKey(data, "down") || data === "\x1b[B") {
    panel.enumIndex = opts.length === 0 ? 0 : (panel.enumIndex + 1) % opts.length;
    if (item.kind === "enum") previewEnumSelection(panel, item, opts[panel.enumIndex]);
    refreshSettingsPanel(panel);
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
        panel,
        item,
        ctx,
        () => item.setValues(ctx, next.length > 0 ? next : undefined),
        () => refreshSettingsPanel(panel),
      );
      return;
    }
    saveSetting(
      panel,
      item,
      ctx,
      () => item.setValue(ctx, opts[panel.enumIndex]),
      () => {
        applyLiveEffects(panel);
        panel.enumOpen = false;
        refreshSettingsPanel(panel);
      },
    );
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    // Cancel browse preview for theme: restore the persisted/file value.
    if (item.kind === "enum" && item.label === "theme") {
      setTheme(panel.deps.state, ctx.mixcodeRaw.theme ?? DEFAULT_THEME_ID);
    }
    panel.enumOpen = false;
    refreshSettingsPanel(panel);
  }
}

/** Live-preview enum values that only affect UI (currently theme). */
function previewEnumSelection(
  panel: SettingsPanel,
  item: EnumItem,
  value: string | undefined,
): void {
  if (item.label !== "theme" || value === undefined) return;
  setTheme(panel.deps.state, value);
}
