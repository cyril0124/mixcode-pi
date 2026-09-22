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
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
  diffViewMode: "auto",
  diffIndicatorMode: "bars",
  diffSplitMinWidth: 120,
  diffCollapsedLines: 24,
  diffWordWrap: true,
  expandedPreviewMaxLines: 4000,
  previewLines: 8,
};
