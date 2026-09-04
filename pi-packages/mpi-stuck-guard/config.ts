// stuck-guard configuration for provider stream liveness.
// Loaded from <agentDir>/mpi-stuck-guard.json with strict validation.

import * as fs from "node:fs";
import * as path from "node:path";

export const STUCK_GUARD_CONFIG_FILENAME = "mpi-stuck-guard.json";

export interface StuckGuardConfig {
  streamWatchdogEnabled: boolean;
  providerIds: string[];
  streamStartTimeoutSeconds: number;
  streamIdleTimeoutSeconds: number;
  streamRetryStartTimeoutSeconds: number;
  knownTimeoutCooldownSeconds: number;
  schemaHintFailureThreshold: number;
}

export const DEFAULT_STUCK_GUARD_CONFIG: StuckGuardConfig = {
  streamWatchdogEnabled: true,
  providerIds: [],
  streamStartTimeoutSeconds: 300,
  streamIdleTimeoutSeconds: 300,
  streamRetryStartTimeoutSeconds: 300,
  knownTimeoutCooldownSeconds: 60,
  schemaHintFailureThreshold: 2,
};

export type StuckGuardConfigLoad =
  | { ok: true; config: StuckGuardConfig; path: string; missing?: true }
  | { ok: false; path: string; error: string };

const TIMEOUT_KEYS = [
  "streamStartTimeoutSeconds",
  "streamIdleTimeoutSeconds",
  "streamRetryStartTimeoutSeconds",
  "knownTimeoutCooldownSeconds",
] as const;

const ALLOWED_ROOT_KEYS = new Set<string>([
  ...TIMEOUT_KEYS,
  "streamWatchdogEnabled",
  "providerIds",
  "schemaHintFailureThreshold",
  "$schema",
]);

/** Parse and validate a raw config body. Unknown keys or wrong types fail loud. */
export function parseStuckGuardConfig(
  raw: unknown,
): { ok: true; config: StuckGuardConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config root must be an object" };
  }
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) return { ok: false, error: `unknown key: ${key}` };
  }

  const config: StuckGuardConfig = { ...DEFAULT_STUCK_GUARD_CONFIG };
  if (root.streamWatchdogEnabled !== undefined) {
    if (typeof root.streamWatchdogEnabled !== "boolean")
      return { ok: false, error: "streamWatchdogEnabled must be a boolean" };
    config.streamWatchdogEnabled = root.streamWatchdogEnabled;
  }
  if (root.providerIds !== undefined) {
    if (
      !Array.isArray(root.providerIds) ||
      root.providerIds.some((value) => typeof value !== "string" || value.length === 0)
    ) {
      return { ok: false, error: "providerIds must be an array of non-empty strings" };
    }
    config.providerIds = [...root.providerIds];
  }
  if (root.$schema !== undefined && typeof root.$schema !== "string") {
    return { ok: false, error: "$schema must be a string" };
  }
  for (const key of TIMEOUT_KEYS) {
    const value = root[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return { ok: false, error: `${key} must be an integer >= 0` };
    }
    config[key] = value;
  }
  if (root.schemaHintFailureThreshold !== undefined) {
    const value = root.schemaHintFailureThreshold;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
      return { ok: false, error: "schemaHintFailureThreshold must be an integer >= 1" };
    }
    config.schemaHintFailureThreshold = value;
  }
  return { ok: true, config };
}

/** Config lives at `<agentDir>/mpi-stuck-guard.json`. */
export function stuckGuardConfigPath(agentDir: string): string {
  return path.join(agentDir, STUCK_GUARD_CONFIG_FILENAME);
}

export function writeStuckGuardConfig(
  agentDir: string,
  config: StuckGuardConfig,
): { ok: true; path: string } | { ok: false; path: string; error: string } {
  const filePath = stuckGuardConfigPath(agentDir);
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { ok: true, path: filePath };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Read the config file. Missing files use defaults; present invalid files fail loudly. */
export function loadStuckGuardConfig(agentDir: string): StuckGuardConfigLoad {
  const filePath = stuckGuardConfigPath(agentDir);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, config: { ...DEFAULT_STUCK_GUARD_CONFIG }, path: filePath, missing: true };
    }
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      path: filePath,
      error: `invalid JSON in ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = parseStuckGuardConfig(parsed);
  if (!result.ok) return { ok: false, path: filePath, error: `${filePath}: ${result.error}` };
  return { ok: true, config: result.config, path: filePath };
}
