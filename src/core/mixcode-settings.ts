import { readFile } from "node:fs/promises";
import { parseJsoncObject } from "./json.js";

export const MIXCODE_SETTINGS_FILENAME = "mixcode_settings.json";
export const DEFAULT_HISTORY_MAX_BYTES = 5 * 1024 * 1024;

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
  };
}

export interface MixCodeSettings {
  /** Explicit theme id, or undefined when the file omits theme (caller applies default). */
  theme?: string;
  history: HistorySettings;
  ui: MixCodeUiSettings;
}

export interface HistorySettings {
  maxBytes: number;
}

export interface MixCodeUiSettings {
  oversizedAssistantMessage: OversizedAssistantMessageSettings;
  /** When false, mermaid fences render as plain code blocks. Default true. */
  renderMermaid: boolean;
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
    },
  };
}

/** Load raw settings preserving undefined for unset fields (no defaults applied). */
export async function loadRawMixCodeSettings(settingsFile: string): Promise<RawMixCodeSettings> {
  let raw: unknown;
  try {
    raw = parseJsoncObject(await readFile(settingsFile, "utf8"));
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
  const hasOversized =
    rawEnabled !== undefined || rawMaxLines !== undefined || rawOversizedBytes !== undefined;
  if (hasOversized || rawRenderMermaid !== undefined) {
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
    };
  }
  return result;
}

/** Write raw settings back to file (undefined fields are omitted). */
export async function writeRawMixCodeSettings(
  settingsFile: string,
  raw: RawMixCodeSettings,
): Promise<void> {
  const { writeFile, mkdir } = await import("node:fs/promises");
  const { dirname } = await import("node:path");
  await mkdir(dirname(settingsFile), { recursive: true });
  // Preserve unknown top-level keys; comments are still dropped because we rewrite JSON.
  let existing: Record<string, unknown> = {};
  try {
    existing = objectRecord(parseJsoncObject(await readFile(settingsFile, "utf8")));
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
  await writeFile(settingsFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

export async function loadMixCodeSettings(settingsFile: string): Promise<MixCodeSettings> {
  let raw: unknown;
  try {
    raw = parseJsoncObject(await readFile(settingsFile, "utf8"));
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
  };
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
