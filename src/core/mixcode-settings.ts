import { readFile } from "node:fs/promises";
import { parseJsoncObject } from "./json.js";

export const MIXCODE_SETTINGS_FILENAME = "mixcode_settings.json";
export const DEFAULT_HISTORY_MAX_BYTES = 5 * 1024 * 1024;

export interface MixCodeSettings {
  history: HistorySettings;
  ui: MixCodeUiSettings;
}

export interface HistorySettings {
  maxBytes: number;
}

export interface MixCodeUiSettings {
  oversizedAssistantMessage: OversizedAssistantMessageSettings;
}

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
    history: { maxBytes: DEFAULT_HISTORY_MAX_BYTES },
    ui: { oversizedAssistantMessage: { ...DEFAULT_OVERSIZED_ASSISTANT_MESSAGE } },
  };
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
  return {
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
  };
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
