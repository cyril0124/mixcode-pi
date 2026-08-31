import { spawnSync } from "node:child_process";
import type { TranscriptEditorMode } from "./config.js";

export const EXTERNAL_TRANSCRIPT_EDITORS = ["nvim", "vim"] as const;
export type ExternalTranscriptEditor = (typeof EXTERNAL_TRANSCRIPT_EDITORS)[number];
export type EditorAvailabilityProbe = (command: ExternalTranscriptEditor) => boolean;

/** Probe the executable without opening an editor or invoking a shell. */
export function isEditorAvailable(command: ExternalTranscriptEditor): boolean {
  const result = spawnSync(command, ["--version"], {
    stdio: "ignore",
    timeout: 1000,
    killSignal: "SIGTERM",
  });
  return result.error === undefined && result.status === 0;
}

/** Return installed editors in the user's preferred auto-selection order. */
export function availableTranscriptEditors(
  probe: EditorAvailabilityProbe = isEditorAvailable,
): ExternalTranscriptEditor[] {
  return EXTERNAL_TRANSCRIPT_EDITORS.filter(probe);
}

/** Options shown by the package config panel. */
export function transcriptEditorOptions(
  probe: EditorAvailabilityProbe = isEditorAvailable,
): TranscriptEditorMode[] {
  return ["auto", ...availableTranscriptEditors(probe), "builtin"];
}

/** Resolve a configured mode to an external command, or undefined for in-app view. */
export function resolveTranscriptEditor(
  mode: TranscriptEditorMode,
  probe: EditorAvailabilityProbe = isEditorAvailable,
): ExternalTranscriptEditor | undefined {
  if (mode === "builtin") return undefined;
  if (mode === "auto") return EXTERNAL_TRANSCRIPT_EDITORS.find(probe);
  return mode;
}
