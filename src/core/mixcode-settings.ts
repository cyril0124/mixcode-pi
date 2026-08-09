import { parseJsoncObject } from "./json.js";

export const MIXCODE_SETTINGS_FILENAME = "mixcode_settings.json";
export const DEFAULT_HISTORY_MAX_BYTES = 5 * 1024 * 1024;

export const ICON_MODES = ["auto", "nerd", "ascii"] as const;
export type IconMode = (typeof ICON_MODES)[number];
export const DEFAULT_ICON_MODE: IconMode = "nerd";

/** Raw (unparsed) mixcode settings — undefined means not explicitly set. */
export interface RawMixCodeSettings {
  /** UI theme id when explicitly set; omit to use DEFAULT_THEME_ID. */
  theme?: string;
  history?: { maxBytes?: number };
  ui?: {
    oversizedAssistantMessage?: {
      enabled?: boolean;
      maxLines?: number;
      maxBytes?: number;
    };
    /** When false, mermaid fences render as plain code blocks. */
    renderMermaid?: boolean;
    /** Input-meta icon glyph mode. */
    icons?: { mode?: IconMode };
  };
  /** Provider ids disabled for selection/use (global). */
  disabledProviders?: string[];
  /** Model refs `provider/modelId` disabled for selection/use (global). */
  disabledModels?: string[];
}

export interface MixCodeSettings {
  /** Explicit theme id, or undefined when the file omits theme (caller applies default). */
  theme?: string;
  history: HistorySettings;
  ui: MixCodeUiSettings;
  disabledProviders: string[];
  disabledModels: string[];
}

export interface HistorySettings {
  maxBytes: number;
}

export interface MixCodeUiSettings {
  oversizedAssistantMessage: OversizedAssistantMessageSettings;
  /** When false, mermaid fences render as plain code blocks. Default true. */
  renderMermaid: boolean;
  icons: { mode: IconMode };
}

export const DEFAULT_RENDER_MERMAID = true;

export interface OversizedAssistantMessageSettings {
  enabled: boolean;
  maxLines: number;
  maxBytes: number;
}

export const DEFAULT_OVERSIZED_ASSISTANT_MESSAGE: OversizedAssistantMessageSettings = {
  enabled: true,
  maxLines: 5000,
  maxBytes: 128 * 1024,
};

export function defaultMixCodeSettings(): MixCodeSettings {
  return {
    // theme omitted: unset, so UI can dim-display the runtime default
    history: { maxBytes: DEFAULT_HISTORY_MAX_BYTES },
    ui: {
      oversizedAssistantMessage: { ...DEFAULT_OVERSIZED_ASSISTANT_MESSAGE },
      renderMermaid: DEFAULT_RENDER_MERMAID,
      icons: { mode: DEFAULT_ICON_MODE },
    },
    disabledProviders: [],
    disabledModels: [],
  };
}

/** True when provider is disabled, or `provider/modelId` is in the model denylist. */
export function isModelDisabled(
  provider: string,
  modelId: string,
  disabledProviders: readonly string[] = [],
  disabledModels: readonly string[] = [],
): boolean {
  if (disabledProviders.includes(provider)) return true;
  const ref = `${provider}/${modelId}`;
  return disabledModels.includes(ref);
}

/** Load raw settings preserving undefined for unset fields (no defaults applied). */
export async function loadRawMixCodeSettings(settingsFile: string): Promise<RawMixCodeSettings> {
  let raw: unknown;
  try {
    raw = parseJsoncObject(await Bun.file(settingsFile).text());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  const source = objectRecord(raw);
  const history = objectRecord(source.history);
  const ui = objectRecord(source.ui);
  const oversized = objectRecord(ui.oversizedAssistantMessage);
  const result: RawMixCodeSettings = {};
  if (typeof source.theme === "string" && source.theme.trim()) {
    result.theme = source.theme.trim();
  }
  const rawMaxBytes = positiveInteger(history.maxBytes);
  if (rawMaxBytes !== undefined) result.history = { maxBytes: rawMaxBytes };
  const rawEnabled = typeof oversized.enabled === "boolean" ? oversized.enabled : undefined;
  const rawMaxLines = positiveInteger(oversized.maxLines);
  const rawOversizedBytes = positiveInteger(oversized.maxBytes);
  const rawRenderMermaid =
    typeof ui.renderMermaid === "boolean" ? ui.renderMermaid : undefined;
  const rawIconMode = rawIconModeValue(objectRecord(ui.icons).mode);
  const hasOversized =
    rawEnabled !== undefined || rawMaxLines !== undefined || rawOversizedBytes !== undefined;
  if (hasOversized || rawRenderMermaid !== undefined || rawIconMode !== undefined) {
    result.ui = {
      ...(hasOversized
        ? {
            oversizedAssistantMessage: {
              ...(rawEnabled !== undefined ? { enabled: rawEnabled } : {}),
              ...(rawMaxLines !== undefined ? { maxLines: rawMaxLines } : {}),
              ...(rawOversizedBytes !== undefined ? { maxBytes: rawOversizedBytes } : {}),
            },
          }
        : {}),
      ...(rawRenderMermaid !== undefined ? { renderMermaid: rawRenderMermaid } : {}),
      ...(rawIconMode !== undefined ? { icons: { mode: rawIconMode } } : {}),
    };
  }
  const disabledProviders = stringList(source.disabledProviders);
  if (disabledProviders !== undefined) result.disabledProviders = disabledProviders;
  const disabledModels = stringList(source.disabledModels);
  if (disabledModels !== undefined) result.disabledModels = disabledModels;
  return result;
}

/** Write raw settings back to file (undefined fields are omitted). */
export async function writeRawMixCodeSettings(
  settingsFile: string,
  raw: RawMixCodeSettings,
): Promise<void> {
  // Preserve unknown top-level keys; comments are still dropped because we rewrite JSON.
  let existing: Record<string, unknown> = {};
  try {
    existing = objectRecord(parseJsoncObject(await Bun.file(settingsFile).text()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const next: Record<string, unknown> = { ...existing };
  if (raw.theme === undefined) delete next.theme;
  else next.theme = raw.theme;
  if (raw.history === undefined) delete next.history;
  else next.history = raw.history;
  if (raw.ui === undefined) delete next.ui;
  else next.ui = raw.ui;
  if (raw.disabledProviders === undefined) delete next.disabledProviders;
  else next.disabledProviders = raw.disabledProviders;
  if (raw.disabledModels === undefined) delete next.disabledModels;
  else next.disabledModels = raw.disabledModels;
  // Bun.write creates parent dirs; no mkdir needed.
  await Bun.write(settingsFile, `${JSON.stringify(next, null, 2)}\n`);
}

export async function loadMixCodeSettings(settingsFile: string): Promise<MixCodeSettings> {
  let raw: unknown;
  try {
    raw = parseJsoncObject(await Bun.file(settingsFile).text());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultMixCodeSettings();
    throw error;
  }
  const source = objectRecord(raw);
  const history = objectRecord(source.history);
  const theme =
    typeof source.theme === "string" && source.theme.trim() ? source.theme.trim() : undefined;
  return {
    ...(theme ? { theme } : {}),
    history: {
      maxBytes: positiveInteger(history.maxBytes) ?? DEFAULT_HISTORY_MAX_BYTES,
    },
    ui: parseUiSettings(source.ui, settingsFile),
    disabledProviders: stringList(source.disabledProviders) ?? [],
    disabledModels: stringList(source.disabledModels) ?? [],
  };
}

function parseUiSettings(value: unknown, settingsFile: string): MixCodeUiSettings {
  const ui = objectRecord(value);
  return {
    oversizedAssistantMessage: parseOversizedAssistantMessageSettings(
      ui.oversizedAssistantMessage,
      settingsFile,
    ),
    renderMermaid: booleanUiSetting(
      ui.renderMermaid,
      DEFAULT_RENDER_MERMAID,
      settingsFile,
      "renderMermaid",
    ),
    icons: { mode: parseIconMode(objectRecord(ui.icons).mode, settingsFile) },
  };
}

function rawIconModeValue(value: unknown): IconMode | undefined {
  if (typeof value !== "string") return undefined;
  return (ICON_MODES as readonly string[]).includes(value) ? (value as IconMode) : undefined;
}

function parseIconMode(value: unknown, settingsFile: string): IconMode {
  if (value === undefined) return DEFAULT_ICON_MODE;
  const parsed = rawIconModeValue(value);
  if (parsed !== undefined) return parsed;
  throw new Error(
    `${settingsFile}: ui.icons.mode must be one of ${ICON_MODES.join(", ")}`,
  );
}

function booleanUiSetting(
  value: unknown,
  fallback: boolean,
  settingsFile: string,
  field: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${settingsFile}: ui.${field} must be a boolean`);
}

function parseOversizedAssistantMessageSettings(
  value: unknown,
  settingsFile: string,
): OversizedAssistantMessageSettings {
  const fallback = DEFAULT_OVERSIZED_ASSISTANT_MESSAGE;
  if (value === undefined) return { ...fallback };
  const source = objectRecord(value);
  if (source !== value) {
    throw new Error(`${settingsFile}: ui.oversizedAssistantMessage must be an object`);
  }
  return {
    enabled: booleanSetting(source.enabled, fallback.enabled, settingsFile, "enabled"),
    maxLines: positiveIntegerSetting(source.maxLines, fallback.maxLines, settingsFile, "maxLines"),
    maxBytes: positiveIntegerSetting(source.maxBytes, fallback.maxBytes, settingsFile, "maxBytes"),
  };
}

function booleanSetting(
  value: unknown,
  fallback: boolean,
  settingsFile: string,
  field: string,
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  throw new Error(`${settingsFile}: ui.oversizedAssistantMessage.${field} must be a boolean`);
}

function positiveIntegerSetting(
  value: unknown,
  fallback: number,
  settingsFile: string,
  field: string,
): number {
  if (value === undefined) return fallback;
  const parsed = positiveInteger(value);
  if (parsed !== undefined) return parsed;
  throw new Error(`${settingsFile}: ui.oversizedAssistantMessage.${field} must be a positive integer`);
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Keep non-empty trimmed strings; non-arrays yield undefined (caller applies default). */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}
