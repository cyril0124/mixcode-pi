/**
 * Load `<agentDir>/auto-rename.json` (optional `model` / `thinking` / `onFirstMessage`).
 * Pure Node — no Bun APIs.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const AUTO_RENAME_CONFIG_FILENAME = "auto-rename.json";
export const AUTO_RENAME_INHERIT = "inherit";

export type AutoRenameConfig = {
  /** `provider/modelId`; omit or "inherit" = use active session model. */
  model?: string;
  /** Thinking level; omit or "inherit" = use active session thinking. */
  thinking?: string;
  /** If true, generate a title when the session's first user message is sent. */
  onFirstMessage?: boolean;
};

export function autoRenameConfigPath(agentDir: string): string {
  return path.join(agentDir, AUTO_RENAME_CONFIG_FILENAME);
}

export type AutoRenameConfigLoad =
  | { ok: true; path: string; config: AutoRenameConfig; missing?: false }
  | { ok: true; path: string; config: AutoRenameConfig; missing: true }
  | { ok: false; path: string; error: string };

/** Non-empty trimmed `model` / `thinking`, boolean `onFirstMessage`; unknown keys ignored. */
export function parseAutoRenameConfig(raw: unknown): AutoRenameConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const config: AutoRenameConfig = {};
  if (typeof source.model === "string" && source.model.trim()) {
    config.model = source.model.trim();
  }
  if (typeof source.thinking === "string" && source.thinking.trim()) {
    config.thinking = source.thinking.trim();
  }
  if (typeof source.onFirstMessage === "boolean") {
    config.onFirstMessage = source.onFirstMessage;
  }
  return config;
}

export function loadAutoRenameConfig(agentDir: string): AutoRenameConfigLoad {
  const filePath = autoRenameConfigPath(agentDir);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, path: filePath, config: {}, missing: true };
    }
    return { ok: false, path: filePath, error: error instanceof Error ? error.message : String(error) };
  }
  try {
    return { ok: true, path: filePath, config: parseAutoRenameConfig(JSON.parse(text) as unknown) };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatAutoRenameConfig(config: AutoRenameConfig): string {
  return `${JSON.stringify(config, null, 2)}\n`;
}

export function writeAutoRenameConfig(
  agentDir: string,
  config: AutoRenameConfig,
): { ok: true; path: string } | { ok: false; path: string; error: string } {
  const filePath = autoRenameConfigPath(agentDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, formatAutoRenameConfig(config), "utf8");
    return { ok: true, path: filePath };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Parse `provider/modelId`; rejects bare ids and trailing slashes. */
export function parseAutoRenameModelRef(
  ref: string,
): { provider: string; modelId: string } | undefined {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return undefined;
  return { provider: trimmed.slice(0, slash), modelId: trimmed.slice(slash + 1) };
}

/**
 * Resolve rename model + thinking. Unset / inherit / unparsable fields fall back to the session.
 */
export function resolveAutoRenameTarget(
  active: { provider: string; modelId: string; thinkingLevel: string },
  config?: Pick<AutoRenameConfig, "model" | "thinking">,
): { provider: string; modelId: string; thinkingLevel: string } {
  let provider = active.provider;
  let modelId = active.modelId;
  let thinkingLevel = active.thinkingLevel;
  if (config?.model && config.model !== AUTO_RENAME_INHERIT) {
    const parsed = parseAutoRenameModelRef(config.model);
    if (parsed) {
      provider = parsed.provider;
      modelId = parsed.modelId;
    }
  }
  if (config?.thinking && config.thinking !== AUTO_RENAME_INHERIT) {
    thinkingLevel = config.thinking;
  }
  return { provider, modelId, thinkingLevel };
}
