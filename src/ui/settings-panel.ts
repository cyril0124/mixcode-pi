/**
 * /settings — floating overlay, same pattern as the command palette:
 *   state.settingsPanel + showLinesOverlay(renderSettingsPanel) + handleSettingsPanelKey
 */

import { isKeyRelease, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SettingsManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import {
  DEFAULT_HISTORY_MAX_BYTES,
  DEFAULT_OVERSIZED_ASSISTANT_MESSAGE,
  loadRawMixCodeSettings,
  writeRawMixCodeSettings,
  type RawMixCodeSettings,
} from "../core/mixcode-settings.js";
import type { MixCodeModelRef, MixCodeState, SettingsPanelState } from "../core/types.js";
import type { OverlayTui } from "./app-types.js";
import { closeAppOverlay, showLinesOverlay } from "./app-overlays.js";
import { clearConversationCache } from "./rendering/agent-surface.js";
import { activeRenderTheme, renderWithTheme } from "./rendering/context.js";
import { overlayPanel, padLine } from "./rendering/primitives.js";
import {
  getExplicitRetryMaxRetries,
  MIXCODE_RETRY_DEFAULTS,
  setRetryMaxRetries,
} from "../agent/retry-settings.js";
import { DEFAULT_THEME_ID } from "../core/defaults.js";
import { setTheme, THEMES, themeForId } from "./themes.js";

// ─── Setting item descriptors ────────────────────────────────────────────────

interface PanelCtx {
  state: MixCodeState;
  settingsManager: SettingsManager;
  mixcodeRaw: RawMixCodeSettings;
  mixcodeFile: string;
  piSettingsFile: string;
  setHideThinkingBlock?: (hide: boolean) => void;
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

type SettingItem = BooleanItem | NumberItem | EnumItem;

const ITEMS: SettingItem[] = [
  {
    kind: "boolean",
    label: "hideThinkingBlock",
    section: "pi",
    defaultValue: false,
    getValue: ({ settingsManager }) => settingsManager.getGlobalSettings().hideThinkingBlock,
    setValue: async ({ settingsManager, setHideThinkingBlock }, v) => {
      // Persist via SettingsManager; live UI state is synced in applyLiveEffects.
      settingsManager.setHideThinkingBlock(v);
      setHideThinkingBlock?.(v);
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
    getOptions: ({ availableModels }) => availableModels.map((m) => m.modelId),
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
  // Theme is file-backed in mixcode_settings.json; live UI still uses state.theme.
  {
    kind: "enum",
    label: "theme",
    section: "mixcode",
    defaultValue: DEFAULT_THEME_ID,
    // undefined => not explicitly set in the file => dim default display
    getValue: ({ mixcodeRaw }) => mixcodeRaw.theme,
    getOptions: () => THEMES.map((theme) => theme.id),
    setValue: async (ctx, v) => {
      const next: RawMixCodeSettings = { ...ctx.mixcodeRaw };
      if (v === undefined) delete next.theme;
      else next.theme = v;
      replaceRaw(ctx.mixcodeRaw, next);
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
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
      replaceRaw(ctx.mixcodeRaw, next);
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
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
      replaceRaw(ctx.mixcodeRaw, next);
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
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
      replaceRaw(ctx.mixcodeRaw, next);
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
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
      replaceRaw(ctx.mixcodeRaw, next);
      await writeRawMixCodeSettings(ctx.mixcodeFile, next);
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
    setHideThinkingBlock?: (hide: boolean) => void;
  },
): Promise<void> {
  const mixcodeRaw = await loadRawMixCodeSettings(mixcodeFile);
  state.settingsPanel = {
    open: true,
    selectedIndex: 0,
    editMode: false,
    editText: "",
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
    state.hideThinkingBlock = panel.settingsManager.getHideThinkingBlock();
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
  "history.maxBytes": "History max bytes",
  "oversized.enabled": "Collapse oversized messages",
  "oversized.maxLines": "Oversized max lines",
  "oversized.maxBytes": "Oversized max bytes",
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
  const sel = (s: string) => t.selection(s);
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

  const lines: string[] = [];
  let shownPi = false;
  let shownMixcode = false;

  ITEMS.forEach((item, idx) => {
    if (item.section === "pi" && !shownPi) {
      shownPi = true;
      lines.push(sectionHeader("Pi"));
      lines.push(pathLine(panel.piSettingsFile));
    }
    if (item.section === "mixcode" && !shownMixcode) {
      shownMixcode = true;
      if (lines.length > 0) lines.push("");
      lines.push(sectionHeader("Mixcode"));
      lines.push(pathLine(panel.mixcodeFile));
    }

    const isSelected = idx === panel.selectedIndex;
    const marker = isSelected ? accent("› ") : "  ";
    const label = ITEM_LABELS[item.label] ?? item.label;
    const rawValue = item.getValue(ctx);
    const isSet = rawValue !== undefined;
    const editing = isSelected && panel.editMode && item.kind === "number";

    let valuePlain: string;
    if (editing) {
      valuePlain = `${panel.editText}█`;
    } else if (item.kind === "boolean") {
      valuePlain = formatBool((isSet ? rawValue : item.defaultValue) as boolean);
    } else if (item.kind === "number") {
      valuePlain = formatNumber((isSet ? rawValue : item.defaultValue) as number);
    } else {
      valuePlain = String(isSet ? rawValue : item.defaultValue);
    }
    if (!isSet && !editing) valuePlain = `${valuePlain}  (default)`;

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
    lines.push(isSelected ? sel(padLine(row, innerWidth)) : row);

    if (isSelected && panel.enumOpen && item.kind === "enum") {
      const opts = item.getOptions(ctx);
      if (opts.length === 0) {
        lines.push(dim("    (no options available)"));
      } else {
        opts.forEach((opt, oi) => {
          const optSelected = oi === panel.enumIndex;
          const optMarker = optSelected ? accent("› ") : "  ";
          const optRow = `  ${optMarker}${truncateToWidth(opt, Math.max(1, innerWidth - 4), "…")}`;
          lines.push(optSelected ? sel(padLine(optRow, innerWidth)) : dim(optRow));
        });
      }
    }
  });

  lines.push("", dim("  ↑↓ select  ⏎ edit/toggle  esc close"));
  return overlayPanel("Settings", lines, width);
}

function formatBool(v: boolean): string {
  return v ? "On" : "Off";
}

function formatNumber(n: number): string {
  if (n >= 1024 * 1024 && n % (1024 * 1024) === 0) return `${n / (1024 * 1024)} MB`;
  if (n >= 1024 && n % 1024 === 0) return `${n / 1024} KB`;
  return String(n);
}

/** Collapse $HOME to ~, then middle-truncate if longer than maxWidth. */
export function formatSettingsPath(filePath: string, maxWidth: number): string {
  if (!filePath) return "";
  const home = homedir();
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
      void item.setValue(ctx, !cur).then(() => {
        applyLiveEffects(state);
        refreshSettingsPanel(state, tui);
      });
    } else if (item.kind === "number") {
      const cur = item.getValue(ctx);
      panel.editMode = true;
      panel.editText = cur !== undefined ? String(cur) : "";
      refreshSettingsPanel(state, tui);
    } else if (item.kind === "enum") {
      const opts = item.getOptions(ctx);
      const cur = item.getValue(ctx);
      panel.enumOpen = true;
      panel.enumIndex = Math.max(0, opts.indexOf(cur ?? ""));
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
      const parsed = parseInt(trimmed, 10);
      void item
        .setValue(
          ctx,
          trimmed === "" || isNaN(parsed) || parsed <= 0 ? undefined : parsed,
        )
        .then(() => {
          applyLiveEffects(state);
          panel.editMode = false;
          panel.editText = "";
          refreshSettingsPanel(state, tui);
        });
      return;
    }
    panel.editMode = false;
    panel.editText = "";
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    panel.editMode = false;
    panel.editText = "";
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "backspace") || data === "\x7f") {
    panel.editText = panel.editText.slice(0, -1);
    refreshSettingsPanel(state, tui);
  } else if (data.length === 1 && /\d/.test(data)) {
    panel.editText += data;
    refreshSettingsPanel(state, tui);
  }
}

function handleEnum(
  state: MixCodeState,
  data: string,
  tui: OverlayTui,
  panel: SettingsPanelState,
): void {
  const item = ITEMS[panel.selectedIndex] as EnumItem | undefined;
  const ctx = panelCtx(state);
  if (!item || item.kind !== "enum" || !ctx) return;
  const opts = item.getOptions(ctx);

  if (matchesKey(data, "up") || data === "\x1b[A") {
    panel.enumIndex = Math.max(0, panel.enumIndex - 1);
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "down") || data === "\x1b[B") {
    panel.enumIndex = Math.min(opts.length - 1, panel.enumIndex + 1);
    refreshSettingsPanel(state, tui);
  } else if (matchesKey(data, "return") || data === "\r" || data === "\n") {
    void item.setValue(ctx, opts[panel.enumIndex]).then(() => {
      applyLiveEffects(state);
      panel.enumOpen = false;
      refreshSettingsPanel(state, tui);
    });
  } else if (matchesKey(data, "escape") || data === "\x1b") {
    panel.enumOpen = false;
    refreshSettingsPanel(state, tui);
  }
}
