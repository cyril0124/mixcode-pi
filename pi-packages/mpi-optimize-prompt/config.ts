/**
 * Load `<agentDir>/mpi-optimize-prompt.json` (optional fields only).
 * Pure Node — no Bun APIs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { OptimizePromptConfig } from "./core.js";

export const OPTIMIZE_PROMPT_CONFIG_FILENAME = "mpi-optimize-prompt.json";

export function optimizePromptConfigPath(agentDir: string): string {
  return path.join(agentDir, OPTIMIZE_PROMPT_CONFIG_FILENAME);
}

export type OptimizePromptConfigLoad =
  | { ok: true; path: string; config: OptimizePromptConfig; missing?: false }
  | { ok: true; path: string; config: OptimizePromptConfig; missing: true }
  | { ok: false; path: string; error: string };

/** Non-empty trimmed string fields only; unknown keys ignored. */
export function parseOptimizePromptConfig(raw: unknown): OptimizePromptConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const config: OptimizePromptConfig = {};
  if (typeof source.model === "string" && source.model.trim()) {
    config.model = source.model.trim();
  }
  if (typeof source.thinking === "string" && source.thinking.trim()) {
    config.thinking = source.thinking.trim();
  }
  if (typeof source.systemPrompt === "string" && source.systemPrompt.trim()) {
    config.systemPrompt = source.systemPrompt.trim();
  }
  if (typeof source.$schema === "string" && source.$schema.trim()) {
    config.schemaRef = source.$schema;
  }
  return config;
}

export function loadOptimizePromptConfig(agentDir: string): OptimizePromptConfigLoad {
  const filePath = optimizePromptConfigPath(agentDir);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: true, path: filePath, config: {}, missing: true };
    }
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  try {
    const raw = JSON.parse(text) as unknown;
    return { ok: true, path: filePath, config: parseOptimizePromptConfig(raw) };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function formatOptimizePromptConfig(config: OptimizePromptConfig): string {
  // Serialize explicitly so schemaRef is written under its on-disk `$schema` key.
  const { schemaRef, ...fields } = config;
  const out = { ...(schemaRef !== undefined ? { $schema: schemaRef } : {}), ...fields };
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function writeOptimizePromptConfig(
  agentDir: string,
  config: OptimizePromptConfig,
): { ok: true; path: string } | { ok: false; path: string; error: string } {
  const filePath = optimizePromptConfigPath(agentDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    // Empty object still writes `{}` so the path is discoverable via /opt-prompt help.
    fs.writeFileSync(filePath, formatOptimizePromptConfig(config), "utf8");
    return { ok: true, path: filePath };
  } catch (error) {
    return {
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
