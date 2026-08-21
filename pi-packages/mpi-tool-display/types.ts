// License notices: ./THIRD_PARTY_NOTICES.md.
// Local scope omits unused tool-ownership and output-mode settings.
export const DIFF_VIEW_MODES = ["auto", "split", "unified"] as const;
export const DIFF_INDICATOR_MODES = ["bars", "classic", "none"] as const;

export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];
export type DiffIndicatorMode = (typeof DIFF_INDICATOR_MODES)[number];

/** Diff-render and output-preview knobs consumed by the renderers. */
export interface ToolDisplayConfig {
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedLines: number;
	diffWordWrap: boolean;
	expandedPreviewMaxLines: number;
	/** Live/expanded preview line budget for bash and read (configured `previewLines`). */
	previewLines: number;
	/** Surface backend truncation notices (configured `showTruncationHints`). */
	showTruncationHints: boolean;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	diffCollapsedLines: 24,
	diffWordWrap: true,
	expandedPreviewMaxLines: 4000,
	previewLines: 8,
	showTruncationHints: false,
};
