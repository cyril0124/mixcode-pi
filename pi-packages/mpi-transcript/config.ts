import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const TRANSCRIPT_CONFIG_FILENAME = "mpi-transcript.json";
export const TRANSCRIPT_EDITOR_MODES = ["auto", "nvim", "vim", "builtin"] as const;
export type TranscriptEditorMode = (typeof TRANSCRIPT_EDITOR_MODES)[number];
export const DEFAULT_TRANSCRIPT_EDITOR: TranscriptEditorMode = "auto";

export interface TranscriptConfig {
  editor: TranscriptEditorMode;
  schemaRef?: string;
}

export type TranscriptConfigLoadResult =
  | { ok: true; path: string; config: TranscriptConfig; missing: boolean }
  | { ok: false; path: string; error: string };

export type TranscriptConfigWriteResult =
  | { ok: true; path: string; config: TranscriptConfig }
  | { ok: false; path: string; error: string };

const CONFIG_KEYS = new Set(["$schema", "editor"]);

export function transcriptConfigPath(agentDir: string): string {
  return path.join(agentDir, TRANSCRIPT_CONFIG_FILENAME);
}

export function parseTranscriptConfig(raw: unknown): TranscriptConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("config root must be an object");
  }
  const source = raw as Record<string, unknown>;
  for (const key of Object.keys(source)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`unknown key ${JSON.stringify(key)}`);
  }
  const editor = source.editor;
  if (editor !== undefined && !TRANSCRIPT_EDITOR_MODES.includes(editor as TranscriptEditorMode)) {
    throw new Error(`editor must be one of ${TRANSCRIPT_EDITOR_MODES.join(", ")}`);
  }
  const schemaRef = source.$schema;
  if (schemaRef !== undefined && (typeof schemaRef !== "string" || !schemaRef.trim())) {
    throw new Error("$schema must be a non-empty string");
  }
  return {
    editor: (editor as TranscriptEditorMode | undefined) ?? DEFAULT_TRANSCRIPT_EDITOR,
    ...(schemaRef !== undefined ? { schemaRef: schemaRef as string } : {}),
  };
}

export function loadTranscriptConfig(agentDir: string): TranscriptConfigLoadResult {
  const filePath = transcriptConfigPath(agentDir);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        ok: true,
        path: filePath,
        config: { editor: DEFAULT_TRANSCRIPT_EDITOR },
        missing: true,
      };
    }
    return { ok: false, path: filePath, error: formatError(error) };
  }

  try {
    return {
      ok: true,
      path: filePath,
      config: parseTranscriptConfig(JSON.parse(text) as unknown),
      missing: false,
    };
  } catch (error) {
    return { ok: false, path: filePath, error: formatError(error) };
  }
}

export function writeTranscriptConfig(
  agentDir: string,
  config: TranscriptConfig,
): TranscriptConfigWriteResult {
  const filePath = transcriptConfigPath(agentDir);
  const normalized = parseTranscriptConfig({
    ...(config.schemaRef !== undefined ? { $schema: config.schemaRef } : {}),
    editor: config.editor,
  });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const { schemaRef, editor } = normalized;
    const raw = { ...(schemaRef !== undefined ? { $schema: schemaRef } : {}), editor };
    fs.writeFileSync(tempPath, `${JSON.stringify(raw, null, 2)}\n`, {
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
