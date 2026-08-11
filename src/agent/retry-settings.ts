import type { SettingsManager } from "@earendil-works/pi-coding-agent";

export const MIXCODE_RETRY_DEFAULTS = {
  maxRetries: 10,
  baseDelayMs: 200,
  jitterRatio: 0.1,
} as const;

const SDK_RETRY_DEFAULTS = {
  maxRetries: 3,
  baseDelayMs: 2000,
} as const;

const originalGetRetrySettings = new WeakMap<
  SettingsManager,
  SettingsManager["getRetrySettings"]
>();
const jitterPatchedSettingsManagers = new WeakSet<SettingsManager>();

type RetryKey = "maxRetries" | "baseDelayMs";

export function configureMixCodeRetrySettings(settingsManager: SettingsManager): void {
  const getRetrySettings = ensureOriginalGetRetrySettings(settingsManager);
  installMixCodeRetryDefaultsAndJitter(settingsManager, getRetrySettings);
}

function ensureOriginalGetRetrySettings(
  settingsManager: SettingsManager,
): SettingsManager["getRetrySettings"] {
  const existing = originalGetRetrySettings.get(settingsManager);
  if (existing) return existing;

  const original = settingsManager.getRetrySettings.bind(settingsManager);
  originalGetRetrySettings.set(settingsManager, original);
  return original;
}

function applyMixCodeRetryDefaults(
  settingsManager: SettingsManager,
  settings: ReturnType<SettingsManager["getRetrySettings"]>,
): ReturnType<SettingsManager["getRetrySettings"]> {
  return {
    ...settings,
    maxRetries: shouldApplyMixCodeDefault(settingsManager, "maxRetries", settings.maxRetries)
      ? MIXCODE_RETRY_DEFAULTS.maxRetries
      : settings.maxRetries,
    baseDelayMs: shouldApplyMixCodeDefault(settingsManager, "baseDelayMs", settings.baseDelayMs)
      ? MIXCODE_RETRY_DEFAULTS.baseDelayMs
      : settings.baseDelayMs,
  };
}

function shouldApplyMixCodeDefault(
  settingsManager: SettingsManager,
  key: RetryKey,
  currentValue: number,
): boolean {
  if (hasExplicitRetryValue(settingsManager, key)) return false;
  return currentValue === SDK_RETRY_DEFAULTS[key];
}

function hasExplicitRetryValue(settingsManager: SettingsManager, key: RetryKey): boolean {
  const globalRetry = settingsManager.getGlobalSettings().retry;
  const projectRetry = settingsManager.getProjectSettings().retry;
  return globalRetry?.[key] !== undefined || projectRetry?.[key] !== undefined;
}

/** Explicit global retry.maxRetries when set in settings.json; undefined => default. */
export function getExplicitRetryMaxRetries(settingsManager: SettingsManager): number | undefined {
  const globalRetry = settingsManager.getGlobalSettings().retry;
  const value = globalRetry?.maxRetries;
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Persist global retry.maxRetries into Pi's settings.json, then reload the manager.
 * Pi only exposes setRetryEnabled publicly; nested maxRetries is written as JSON.
 * Passing undefined clears the explicit value (back to MixCode/SDK default).
 */
export async function setRetryMaxRetries(
  settingsManager: SettingsManager,
  settingsFile: string,
  maxRetries: number | undefined,
): Promise<void> {
  if (maxRetries !== undefined && (!Number.isInteger(maxRetries) || maxRetries <= 0)) {
    throw new Error(`retry.maxRetries must be a positive integer, got ${maxRetries}`);
  }
  await settingsManager.flush();
  let raw: Record<string, unknown> = {};
  try {
    const text = await Bun.file(settingsFile).text();
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      raw = parsed as Record<string, unknown>;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const retry =
    raw.retry && typeof raw.retry === "object" && !Array.isArray(raw.retry)
      ? { ...(raw.retry as Record<string, unknown>) }
      : {};
  if (maxRetries === undefined) delete retry.maxRetries;
  else retry.maxRetries = maxRetries;
  if (Object.keys(retry).length > 0) raw.retry = retry;
  else delete raw.retry;
  // Bun.write creates parent dirs.
  await Bun.write(settingsFile, `${JSON.stringify(raw, null, 2)}\n`);
  await settingsManager.reload();
  // Re-apply MixCode retry defaults/jitter after reload (reload rebuilds getters).
  configureMixCodeRetrySettings(settingsManager);
}

function installMixCodeRetryDefaultsAndJitter(
  settingsManager: SettingsManager,
  getRetrySettings: SettingsManager["getRetrySettings"],
): void {
  if (jitterPatchedSettingsManagers.has(settingsManager)) return;

  settingsManager.getRetrySettings = () => {
    const settings = applyMixCodeRetryDefaults(settingsManager, getRetrySettings());
    return {
      ...settings,
      // Pi SDK applies exponential backoff after reading baseDelayMs, so adding
      // jitter here gives each retry attempt a Codex-style ±10% final delay.
      baseDelayMs: applyRetryJitter(settings.baseDelayMs),
    };
  };
  jitterPatchedSettingsManagers.add(settingsManager);
}

export function applyRetryJitter(delayMs: number, random = Math.random()): number {
  const minFactor = 1 - MIXCODE_RETRY_DEFAULTS.jitterRatio;
  const jitterRange = MIXCODE_RETRY_DEFAULTS.jitterRatio * 2;
  return Math.round(delayMs * (minFactor + random * jitterRange));
}
