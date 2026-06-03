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
