// Global mpi-tool-display configuration. Pure Node: this package also runs under upstream Pi.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_DISPLAY_CONFIG_FILENAME = "mpi-tool-display.json";

export interface ToolDisplayRuntimeConfig {
  showRawToolArguments: boolean;
  /** Collapse a finished bash call to one row with a label, command excerpt and status meta. */
  compactBashCallRow: boolean;
}

export const DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG: ToolDisplayRuntimeConfig = {
  showRawToolArguments: false,
  compactBashCallRow: true,
};

export type ToolDisplayConfigLoadResult =
  | { ok: true; path: string; config: ToolDisplayRuntimeConfig; missing: boolean }
  | { ok: false; path: string; error: string };

export type ToolDisplayConfigWriteResult =
  | { ok: true; path: string; config: ToolDisplayRuntimeConfig }
  | { ok: false; path: string; error: string };

const CONFIG_KEYS = new Set(["showRawToolArguments", "compactBashCallRow"]);

/**
 * Keys the file may carry without being rejected even though no setting reads them, so a
 * configuration file that still lists a removed setting keeps loading.
 */
const IGNORED_CONFIG_KEYS = new Set(["compactBashCommandHint"]);

export function toolDisplayConfigPath(agentDir: string): string {
  return path.join(agentDir, TOOL_DISPLAY_CONFIG_FILENAME);
}

export function parseToolDisplayRuntimeConfig(raw: unknown): ToolDisplayRuntimeConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config root must be an object");
  }
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!CONFIG_KEYS.has(key) && !IGNORED_CONFIG_KEYS.has(key)) {
      throw new Error(`unknown key ${JSON.stringify(key)}`);
    }
  }
  const value = source.showRawToolArguments;
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`showRawToolArguments must be a boolean, got ${JSON.stringify(value)}`);
  }
  const compact = source.compactBashCallRow;
  if (compact !== undefined && typeof compact !== "boolean") {
    throw new Error(`compactBashCallRow must be a boolean, got ${JSON.stringify(compact)}`);
  }
  return {
    showRawToolArguments: value ?? DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG.showRawToolArguments,
    compactBashCallRow: compact ?? DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG.compactBashCallRow,
  };
}

export function loadToolDisplayRuntimeConfig(agentDir: string): ToolDisplayConfigLoadResult {
  const filePath = toolDisplayConfigPath(agentDir);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        config: { ...DEFAULT_TOOL_DISPLAY_RUNTIME_CONFIG },
        missing: true,
      };
    }
    return { ok: false, path: filePath, error: formatError(error) };
  }

  try {
    return {
      ok: true,
      path: filePath,
      config: parseToolDisplayRuntimeConfig(JSON.parse(text) as unknown),
      missing: false,
    };
  } catch (error) {
    return { ok: false, path: filePath, error: formatError(error) };
  }
}

export function writeToolDisplayRuntimeConfig(
  agentDir: string,
  config: ToolDisplayRuntimeConfig,
): ToolDisplayConfigWriteResult {
  const filePath = toolDisplayConfigPath(agentDir);
  const normalized = parseToolDisplayRuntimeConfig(config);
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.renameSync(tempPath, filePath);
    fs.chmodSync(filePath, 0o600);
    return { ok: true, path: filePath, config: normalized };
  } catch (error) {
    let cleanupError: unknown;
    try {
      fs.rmSync(tempPath, { force: true });
    } catch (caught) {
      cleanupError = caught;
    }
    const suffix = cleanupError ? `; temp cleanup failed: ${formatError(cleanupError)}` : "";
    return { ok: false, path: filePath, error: `${formatError(error)}${suffix}` };
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
