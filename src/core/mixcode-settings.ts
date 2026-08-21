export const MIXCODE_SETTINGS_FILENAME = "mixcode_settings.json";

export const ICON_MODES = ["auto", "nerd", "ascii"] as const;
export type IconMode = (typeof ICON_MODES)[number];
export const DEFAULT_ICON_MODE: IconMode = "nerd";

/** Raw (unparsed) mixcode settings — undefined means not explicitly set. */
export interface RawMixCodeSettings {
  /** UI theme id when explicitly set; omit to use DEFAULT_THEME_ID. */
  theme?: string;
  ui?: {
    oversizedAssistantMessage?: {
      enabled?: boolean;
      maxLines?: number;
      maxBytes?: number;
    };
    /** Input-meta icon glyph mode. */
    icons?: { mode?: IconMode };
    /** Default for new tabs: show setWidget chrome in the chat tail. */
    inlineWidgets?: boolean;
  };
  /** Provider ids disabled for selection/use (global). */
  disabledProviders?: string[];
  /** Model refs `provider/modelId` disabled for selection/use (global). */
  disabledModels?: string[];
}

export interface MixCodeSettings {
  /** Explicit theme id, or undefined when the file omits theme (caller applies default). */
  theme?: string;
  ui: MixCodeUiSettings;
  disabledProviders: string[];
  disabledModels: string[];
}

export interface MixCodeUiSettings {
  oversizedAssistantMessage: OversizedAssistantMessageSettings;
  icons: { mode: IconMode };
  inlineWidgets: boolean;
}

export const DEFAULT_INLINE_WIDGETS = false;

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

function defaultMixCodeSettings(): MixCodeSettings {
  return {
    // theme omitted: unset, so UI can dim-display the runtime default
    ui: {
      oversizedAssistantMessage: { ...DEFAULT_OVERSIZED_ASSISTANT_MESSAGE },
      icons: { mode: DEFAULT_ICON_MODE },
      inlineWidgets: DEFAULT_INLINE_WIDGETS,
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

async function readSettingsSource(
  settingsFile: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    return objectRecord(parseJsoncObject(await Bun.file(settingsFile).text()));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Load raw settings preserving undefined for unset fields (no defaults applied). */
export async function loadRawMixCodeSettings(settingsFile: string): Promise<RawMixCodeSettings> {
  const source = await readSettingsSource(settingsFile);
  if (!source) return {};
  const ui = objectRecord(source.ui);
  const oversized = objectRecord(ui.oversizedAssistantMessage);
  const result: RawMixCodeSettings = {};
  if (typeof source.theme === "string" && source.theme.trim()) {
    result.theme = source.theme.trim();
  }
  const rawEnabled = typeof oversized.enabled === "boolean" ? oversized.enabled : undefined;
  const rawMaxLines = positiveInteger(oversized.maxLines);
  const rawOversizedBytes = positiveInteger(oversized.maxBytes);
  const rawIconMode = rawIconModeValue(objectRecord(ui.icons).mode);
  const rawInlineWidgets = typeof ui.inlineWidgets === "boolean" ? ui.inlineWidgets : undefined;
  const hasOversized =
    rawEnabled !== undefined || rawMaxLines !== undefined || rawOversizedBytes !== undefined;
  if (hasOversized || rawIconMode !== undefined || rawInlineWidgets !== undefined) {
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
      ...(rawIconMode !== undefined ? { icons: { mode: rawIconMode } } : {}),
      ...(rawInlineWidgets !== undefined ? { inlineWidgets: rawInlineWidgets } : {}),
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
  const next: Record<string, unknown> = { ...(await readSettingsSource(settingsFile)) };
  if (raw.theme === undefined) delete next.theme;
  else next.theme = raw.theme;
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
  const source = await readSettingsSource(settingsFile);
  if (!source) return defaultMixCodeSettings();
  const theme =
    typeof source.theme === "string" && source.theme.trim() ? source.theme.trim() : undefined;
  return {
    ...(theme ? { theme } : {}),
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
    icons: { mode: parseIconMode(objectRecord(ui.icons).mode, settingsFile) },
    inlineWidgets: parseInlineWidgets(ui.inlineWidgets, settingsFile),
  };
}

function parseInlineWidgets(value: unknown, settingsFile: string): boolean {
  if (value === undefined) return DEFAULT_INLINE_WIDGETS;
  if (typeof value === "boolean") return value;
  throw new Error(`${settingsFile}: ui.inlineWidgets must be a boolean`);
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

function parseJsoncObject(text: string): Record<string, unknown> {
  const value = Bun.JSON5.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected JSON object");
  }
  return value as Record<string, unknown>;
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
