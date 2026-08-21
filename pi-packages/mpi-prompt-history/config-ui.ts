// `/prompt-history config` — read/edit <agentDir>/mpi-prompt-history.json.
//
// Byte sizes are entered and shown with unit suffixes because a raw 15728640
// is unreadable; the file itself always stores plain bytes.
import * as fs from "node:fs/promises";
import {
  CONFIG_FILENAME,
  DEFAULT_HISTORY_MAX_BYTES,
  promptHistoryPaths,
  readHistoryMaxBytes,
} from "./history-store.js";

const UNITS: ReadonlyArray<[suffix: string, factor: number]> = [
  ["gb", 1024 ** 3],
  ["mb", 1024 ** 2],
  ["kb", 1024],
  ["b", 1],
];

/** Render a byte count as the most readable whole-ish unit, e.g. 15728640 -> "15 MB". */
export function formatBytes(bytes: number): string {
  for (const [suffix, factor] of UNITS) {
    if (bytes >= factor) {
      const value = bytes / factor;
      const shown = Number.isInteger(value) ? String(value) : value.toFixed(1);
      return `${shown} ${suffix.toUpperCase()}`;
    }
  }
  return `${bytes} B`;
}

/**
 * Parse a user-entered size: plain bytes ("1048576") or a unit suffix
 * ("20mb", "512 KB", "1gb"). Returns undefined when the text is not a positive
 * whole number of bytes, so the caller can reject instead of guessing.
 */
export function parseByteSize(text: string): number | undefined {
  const match = /^\s*(\d+(?:\.\d+)?)\s*(gb|mb|kb|b)?\s*$/i.exec(text);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const suffix = match[2]?.toLowerCase();
  const factor = suffix ? (UNITS.find(([name]) => name === suffix)?.[1] ?? 1) : 1;
  const bytes = amount * factor;
  return Number.isInteger(bytes) ? bytes : undefined;
}

/**
 * Set or clear `maxBytes`, preserving `$schema` and leaving no file behind when
 * the config would be empty. Returns the path written, or undefined when the
 * file was removed because nothing is configured any more.
 */
export async function writeMaxBytes(
  configFile: string,
  maxBytes: number | undefined,
): Promise<string | undefined> {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await fs.readFile(configFile, "utf8")) as Record<string, unknown>;
  } catch (error) {
    // A missing file is the normal first-write case; a malformed one is rewritten
    // from scratch rather than blocking the edit the user just confirmed.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") current = {};
  }
  const next: Record<string, unknown> = {};
  if (typeof current.$schema === "string") next.$schema = current.$schema;
  if (maxBytes !== undefined) next.maxBytes = maxBytes;
  if (Object.keys(next).length === 0) {
    await fs.rm(configFile, { force: true });
    return undefined;
  }
  await fs.writeFile(configFile, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return configFile;
}

interface ConfigUiContext {
  ui: {
    select(title: string, options: string[]): Promise<string | undefined>;
    input(title: string, placeholder?: string): Promise<string | undefined>;
    notify(message: string, type?: "info" | "warning" | "error"): void;
  };
}

/** Interactive editor for the package config. One entry per setting, plus reset. */
export async function runPromptHistoryConfig(options: {
  ctx: ConfigUiContext;
  agentDir: string;
}): Promise<void> {
  const { ctx, agentDir } = options;
  const { configFile } = promptHistoryPaths(agentDir);

  let effective: number;
  try {
    effective = await readHistoryMaxBytes(configFile);
  } catch (error) {
    ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
    return;
  }
  const isDefault = effective === DEFAULT_HISTORY_MAX_BYTES;

  const EDIT = `maxBytes: ${formatBytes(effective)}${isDefault ? " (default)" : ""}`;
  const RESET = `Reset to default (${formatBytes(DEFAULT_HISTORY_MAX_BYTES)})`;
  const choice = await ctx.ui.select(
    `${CONFIG_FILENAME} — history.jsonl size budget`,
    isDefault ? [EDIT] : [EDIT, RESET],
  );
  if (choice === undefined) return;

  if (choice === RESET) {
    await writeMaxBytes(configFile, undefined);
    ctx.ui.notify(`maxBytes reset to ${formatBytes(DEFAULT_HISTORY_MAX_BYTES)}`, "info");
    return;
  }

  const entered = await ctx.ui.input(
    `maxBytes — currently ${formatBytes(effective)}`,
    "e.g. 20mb, 512kb, or 1048576",
  );
  if (entered === undefined || !entered.trim()) return;

  const bytes = parseByteSize(entered);
  if (bytes === undefined) {
    ctx.ui.notify(`Not a positive size: ${entered.trim()}`, "error");
    return;
  }
  const written = await writeMaxBytes(configFile, bytes);
  ctx.ui.notify(`maxBytes set to ${formatBytes(bytes)} in ${written}`, "info");
}
