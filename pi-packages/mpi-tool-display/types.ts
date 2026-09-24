// License notices: ./THIRD_PARTY_NOTICES.md.
// Local scope omits unused tool-ownership and output-mode settings.
export type DiffViewMode = "auto" | "split" | "unified";
export type DiffIndicatorMode = "bars" | "classic" | "none";

/** Diff-render and output-preview knobs consumed by the renderers. */
export interface ToolDisplayConfig {
  diffViewMode: DiffViewMode;
  diffIndicatorMode: DiffIndicatorMode;
  diffSplitMinWidth: number;
  /** Content-line budget before wrapping; a split left/right pair counts once. */
  diffCollapsedLines: number;
  diffWordWrap: boolean;
  expandedPreviewMaxLines: number;
  /** Live/expanded preview line budget for bash and read (configured `previewLines`). */
  previewLines: number;
  /** Output lines a failed bash call keeps visible while collapsed. */
  bashFailureTailLines: number;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  diffViewMode: "auto",
  diffIndicatorMode: "bars",
  diffSplitMinWidth: 120,
  diffCollapsedLines: 24,
  diffWordWrap: true,
  expandedPreviewMaxLines: 4000,
  previewLines: 8,
  bashFailureTailLines: 3,
};

/**
 * Key of the compact bash outcome inside Pi's per-row renderer state. The result renderer
 * writes it; the call renderer reads it to build the one-row collapsed status.
 */
export const BASH_CALL_OUTCOME_STATE_KEY = "mpiToolDisplayBashOutcome";

/** Status a finished bash call shows on its collapsed call row. */
export interface BashCallOutcome {
  /** Output lines the result carried, used for the `<N> lines` meta. */
  lineCount: number;
  failed: boolean;
  /** Exit code parsed from Pi's `Command exited with code N` result text. */
  exitCode?: number;
  timedOut: boolean;
  aborted: boolean;
}
