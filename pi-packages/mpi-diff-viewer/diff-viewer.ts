import {
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  fuzzyFilter,
  Key,
  matchesKey,
  sliceByColumn,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
  countReviewCommentsForFile,
  createReviewDraft,
  findReviewComment,
  type ReviewDraft,
  type ReviewIntent,
  type ReviewTarget,
  reviewTargetKey,
  saveReviewComment,
  sortedReviewComments,
} from "./review.js";
import type { DiffFile, DiffRow, SessionDiff } from "./session-diff.js";

interface ViewerTui {
  terminal: { columns: number; rows: number };
  requestRender(): void;
}

export interface ReviewEditor {
  getText(): string;
  setText(text: string): void;
  handleInput(data: string): void;
  render(width: number): string[];
  focused?: boolean;
}

export interface DiffViewerConfig {
  tui: ViewerTui;
  theme: Theme;
  diff: SessionDiff;
  done: (result?: ReviewDraft) => void;
  highlight?: (text: string, path: string) => string;
  editor?: ReviewEditor;
}

type ViewMode = "unified" | "side-by-side";
type Tone = "context" | "added" | "removed";

interface HighlightedRow {
  oldText: string;
  newText: string;
}

interface VisualDiffRow {
  text: string;
  targets: SelectableLineTarget[];
}

interface PreparedFile {
  highlightedRows: Map<DiffRow, HighlightedRow>;
  views: Map<string, VisualDiffRow[]>;
}

interface PrewarmTask {
  key: string;
  fileIndex: number;
  width: number;
  viewMode: ViewMode;
}

interface SelectableLineTarget {
  hunkIndex: number;
  row: DiffRow;
  side: "old" | "new";
  line: number;
  code: string;
}

type FileTreeNode = FileTreeDirectory | FileTreeLeaf;

interface FileTreeDirectory {
  kind: "directory";
  name: string;
  children: FileTreeNode[];
  directories: Map<string, FileTreeDirectory>;
}

interface FileTreeLeaf {
  kind: "file";
  name: string;
  fileIndex: number;
}

type NavigatorRow =
  | { kind: "root"; depth: number; label: string; fileIndexes: number[] }
  | { kind: "directory"; depth: number; label: string; path: string; fileIndexes: number[] }
  | { kind: "file"; depth: number; label: string; fileIndex: number; path: string };

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "", true);
}

function statusIcon(status: DiffFile["status"]): string {
  if (status === "added") return "";
  if (status === "deleted") return "";
  return "";
}

function hunkLabel(header: string): string {
  return /^@@[^@]*@@\s*(.*)$/.exec(header)?.[1]?.trim() || header;
}

function collectTreeFileIndexes(node: FileTreeNode): number[] {
  if (node.kind === "file") return [node.fileIndex];
  return node.children.flatMap(collectTreeFileIndexes);
}

function buildNavigatorRows(files: DiffFile[], fileIndexes: number[]): NavigatorRow[] {
  const root: FileTreeDirectory = {
    kind: "directory",
    name: "",
    children: [],
    directories: new Map(),
  };

  for (const fileIndex of fileIndexes) {
    const file = files[fileIndex];
    if (!file) continue;
    const splitPath = file.path.split(/[\\/]/).filter(Boolean);
    const parts = splitPath.length > 0 ? splitPath : [file.path];
    let directory = root;
    for (const name of parts.slice(0, -1)) {
      let child = directory.directories.get(name);
      if (!child) {
        child = {
          kind: "directory",
          name,
          children: [],
          directories: new Map(),
        };
        directory.directories.set(name, child);
        directory.children.push(child);
      }
      directory = child;
    }
    directory.children.push({
      kind: "file",
      name: parts.at(-1) ?? file.path,
      fileIndex,
    });
  }

  const rows: NavigatorRow[] = [
    { kind: "root", depth: 0, label: "/", fileIndexes: [...fileIndexes] },
  ];
  const appendNode = (node: FileTreeNode, depth: number, parentPath: string): void => {
    if (node.kind === "file") {
      const file = files[node.fileIndex];
      rows.push({
        kind: "file",
        depth,
        label: node.name,
        fileIndex: node.fileIndex,
        path: file?.path ?? node.name,
      });
      return;
    }

    const names = [node.name];
    let directory = node;
    while (directory.children.length === 1 && directory.children[0]?.kind === "directory") {
      directory = directory.children[0];
      names.push(directory.name);
    }
    const pathLabel = names.join("/");
    const path = parentPath ? `${parentPath}/${pathLabel}` : pathLabel;
    rows.push({
      kind: "directory",
      depth,
      label: pathLabel,
      path,
      fileIndexes: collectTreeFileIndexes(directory),
    });
    for (const child of directory.children) appendNode(child, depth + 1, path);
  };

  for (const child of root.children) appendNode(child, 1, "");
  return rows;
}

function renderPanel(
  title: string,
  width: number,
  height: number,
  theme: Theme,
  content: string[],
): string[] {
  const innerWidth = Math.max(1, width - 2);
  const border = (text: string) => theme.fg("border", text);
  const titleText = ` ${title} `;
  const visibleTitle = truncateToWidth(titleText, innerWidth, "", false);
  const top = `${border("┌")}${theme.fg("accent", visibleTitle)}${border(
    `${"─".repeat(Math.max(0, innerWidth - visibleWidth(visibleTitle)))}┐`,
  )}`;
  const bodyHeight = Math.max(0, height - 2);
  const lines = [top];
  for (let index = 0; index < bodyHeight; index++) {
    lines.push(`${border("│")}${fit(content[index] ?? "", innerWidth)}${border("│")}`);
  }
  lines.push(border(`└${"─".repeat(innerWidth)}┘`));
  return lines;
}

function renderCenteredOverlay(base: string[], overlay: string[], width: number): string[] {
  const overlayWidth = Math.min(width, Math.max(...overlay.map(visibleWidth), 0));
  const left = Math.max(0, Math.floor((width - overlayWidth) / 2));
  const top = Math.max(0, Math.floor((base.length - overlay.length) / 2));
  return base.map((line, row) => {
    const overlayLine = overlay[row - top];
    if (overlayLine === undefined) return line;
    const fitted = fit(line, width);
    const rightStart = left + overlayWidth;
    return `${fit(sliceByColumn(fitted, 0, left, true), left)}${fit(overlayLine, overlayWidth)}${sliceByColumn(
      fitted,
      rightStart,
      Math.max(0, width - rightStart),
      true,
    )}`;
  });
}

type IntraLineDiffKind = "equal" | "added" | "removed";

interface IntraLineDiffPart {
  kind: IntraLineDiffKind;
  value: string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
const hanPattern = /\p{Script=Han}/u;
const trailingAnsiPattern = /(?:\x1b\[[0-?]*[ -/]*[@-~])+$/;
// Sampled from delta's reference image: muted rows with a lighter semantic block.
const deltaAddedRowBg = "\x1b[48;2;12;39;5m";
const deltaRemovedRowBg = "\x1b[48;2;57;5;4m";
const deltaAddedHighlightBg = "\x1b[48;2;40;94;23m";
const deltaRemovedHighlightBg = "\x1b[48;2;132;31;26m";
const deltaHighlightFg = "\x1b[38;2;228;229;222m";

function splitGraphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

function splitDiffTokens(text: string): string[] {
  const tokens: string[] = [];
  for (const { segment } of wordSegmenter.segment(text)) {
    if (!hanPattern.test(segment)) {
      tokens.push(segment);
      continue;
    }

    let nonHan = "";
    for (const grapheme of splitGraphemes(segment)) {
      if (hanPattern.test(grapheme)) {
        if (nonHan) tokens.push(nonHan);
        nonHan = "";
        tokens.push(grapheme);
      } else {
        nonHan += grapheme;
      }
    }
    if (nonHan) tokens.push(nonHan);
  }
  return tokens;
}

function mergeIntraLineDiff(parts: IntraLineDiffPart[]): IntraLineDiffPart[] {
  const merged: IntraLineDiffPart[] = [];
  for (const part of parts) {
    if (!part.value) continue;
    const previous = merged.at(-1);
    if (previous?.kind === part.kind) previous.value += part.value;
    else merged.push({ ...part });
  }
  return merged;
}

function backtrackIntraLineDiff(
  trace: Map<number, number>[],
  oldTokens: string[],
  newTokens: string[],
): IntraLineDiffPart[] {
  let oldIndex = oldTokens.length;
  let newIndex = newTokens.length;
  const reversed: IntraLineDiffPart[] = [];

  for (let editLength = trace.length - 1; editLength >= 0; editLength--) {
    const frontier = trace[editLength]!;
    const diagonal = oldIndex - newIndex;
    const previousDiagonal =
      diagonal === -editLength ||
      (diagonal !== editLength &&
        (frontier.get(diagonal - 1) ?? Number.NEGATIVE_INFINITY) <
          (frontier.get(diagonal + 1) ?? Number.NEGATIVE_INFINITY))
        ? diagonal + 1
        : diagonal - 1;
    const previousOldIndex = frontier.get(previousDiagonal) ?? 0;
    const previousNewIndex = previousOldIndex - previousDiagonal;

    while (oldIndex > previousOldIndex && newIndex > previousNewIndex) {
      reversed.push({ kind: "equal", value: oldTokens[oldIndex - 1]! });
      oldIndex--;
      newIndex--;
    }
    if (editLength === 0) break;
    if (oldIndex === previousOldIndex) {
      reversed.push({ kind: "added", value: newTokens[newIndex - 1]! });
      newIndex--;
    } else {
      reversed.push({ kind: "removed", value: oldTokens[oldIndex - 1]! });
      oldIndex--;
    }
  }

  return mergeIntraLineDiff(reversed.reverse());
}

// Myers shortest-edit-path keeps repeated tokens aligned without a quadratic LCS table.
function diffTokens(oldTokens: string[], newTokens: string[]): IntraLineDiffPart[] {
  if (oldTokens.length === 0) return [{ kind: "added", value: newTokens.join("") }];
  if (newTokens.length === 0) return [{ kind: "removed", value: oldTokens.join("") }];

  const maximumEditLength = oldTokens.length + newTokens.length;
  const trace: Map<number, number>[] = [];
  const frontier = new Map<number, number>([[1, 0]]);

  for (let editLength = 0; editLength <= maximumEditLength; editLength++) {
    trace.push(new Map(frontier));
    for (let diagonal = -editLength; diagonal <= editLength; diagonal += 2) {
      const insertion = frontier.get(diagonal + 1);
      const removal = frontier.get(diagonal - 1);
      let oldIndex =
        diagonal === -editLength ||
        (diagonal !== editLength &&
          (removal ?? Number.NEGATIVE_INFINITY) < (insertion ?? Number.NEGATIVE_INFINITY))
          ? (insertion ?? 0)
          : (removal ?? -1) + 1;
      let newIndex = oldIndex - diagonal;

      while (
        oldIndex < oldTokens.length &&
        newIndex < newTokens.length &&
        oldTokens[oldIndex] === newTokens[newIndex]
      ) {
        oldIndex++;
        newIndex++;
      }
      frontier.set(diagonal, oldIndex);
      if (oldIndex >= oldTokens.length && newIndex >= newTokens.length) {
        return backtrackIntraLineDiff(trace, oldTokens, newTokens);
      }
    }
  }

  throw new Error("Intra-line diff did not reach the end of both inputs");
}

function intraLineDiff(oldText: string, newText: string): IntraLineDiffPart[] {
  const oldTokens = splitDiffTokens(oldText);
  const newTokens = splitDiffTokens(newText);
  let prefixLength = 0;
  while (
    prefixLength < oldTokens.length &&
    prefixLength < newTokens.length &&
    oldTokens[prefixLength] === newTokens[prefixLength]
  ) {
    prefixLength++;
  }

  let suffixLength = 0;
  while (
    suffixLength < oldTokens.length - prefixLength &&
    suffixLength < newTokens.length - prefixLength &&
    oldTokens[oldTokens.length - suffixLength - 1] ===
      newTokens[newTokens.length - suffixLength - 1]
  ) {
    suffixLength++;
  }

  const parts: IntraLineDiffPart[] = [];
  if (prefixLength > 0) {
    parts.push({ kind: "equal", value: oldTokens.slice(0, prefixLength).join("") });
  }
  parts.push(
    ...diffTokens(
      oldTokens.slice(prefixLength, oldTokens.length - suffixLength),
      newTokens.slice(prefixLength, newTokens.length - suffixLength),
    ),
  );
  if (suffixLength > 0) {
    parts.push({ kind: "equal", value: oldTokens.slice(-suffixLength).join("") });
  }
  return mergeIntraLineDiff(parts);
}

function styleIntraLineDiffSide(
  highlighted: string,
  parts: IntraLineDiffPart[],
  side: "old" | "new",
  theme: Theme,
): string {
  const sideParts = parts.filter(
    (part) =>
      !((side === "old" && part.kind === "added") || (side === "new" && part.kind === "removed")),
  );
  const isChanged = (part: IntraLineDiffPart | undefined): boolean =>
    part !== undefined && (side === "old" ? part.kind === "removed" : part.kind === "added");
  const runs: Array<{ value: string; changed: boolean }> = [];
  for (let index = 0; index < sideParts.length; index++) {
    const part = sideParts[index]!;
    const changed =
      isChanged(part) ||
      (part.kind === "equal" &&
        /^\s+$/.test(part.value) &&
        isChanged(sideParts[index - 1]) &&
        isChanged(sideParts[index + 1]));
    const previous = runs.at(-1);
    if (previous?.changed === changed) previous.value += part.value;
    else runs.push({ value: part.value, changed });
  }

  let column = 0;
  let rendered = "";
  for (const run of runs) {
    const width = visibleWidth(run.value);
    const text = sliceByColumn(highlighted, column, width, true);
    if (run.changed) {
      const plainText = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      const highlightBg = side === "old" ? deltaRemovedHighlightBg : deltaAddedHighlightBg;
      const rowBg = side === "old" ? deltaRemovedRowBg : deltaAddedRowBg;
      rendered += `${highlightBg}${deltaHighlightFg}${theme.bold(plainText)}\x1b[39m${rowBg}`;
    } else {
      rendered += text;
    }
    column += width;
  }
  return `${rendered}${trailingAnsiPattern.exec(highlighted)?.[0] ?? ""}`;
}

function defaultHighlight(text: string, path: string): string {
  return highlightCode(text, getLanguageFromPath(path)).join("\n");
}

function createCommentEditor(tui: ViewerTui, theme: Theme): ReviewEditor {
  const editorTheme: EditorTheme = {
    borderColor: (text) => theme.fg("borderAccent", text),
    selectList: {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    },
  };
  const editor = new Editor(tui as TUI, editorTheme, { paddingX: 1 });
  editor.disableSubmit = true;
  return editor;
}

export class DiffViewer {
  private selectedNavigatorIndex = 0;
  private viewMode: ViewMode;
  private navigatorVisible = true;
  private navigatorScroll = 0;
  private diffScroll = 0;
  private diffPageSize = 1;
  private diffRowCount = 0;
  private searchMode = false;
  private searchQuery = "";
  private helpMode = false;
  private commentMode = false;
  private selectedLineIndex = 0;
  private rangeAnchorIndex: number | undefined;
  private reviewMode = false;
  private reviewSelection = 0;
  private confirmDiscard = false;
  private editTarget: ReviewTarget | undefined;
  private editIntent: ReviewIntent = "discuss";
  private reviewDraft = createReviewDraft();
  private readonly editor: ReviewEditor;
  private preparedFiles = new Map<number, PreparedFile>();
  private prewarmQueue: PrewarmTask[] = [];
  private prewarmKeys = new Set<string>();
  private prewarmHandle: ReturnType<typeof setImmediate> | undefined;
  private prewarmContext = "";
  private disposed = false;

  constructor(private readonly config: DiffViewerConfig) {
    this.viewMode = config.tui.terminal.columns >= 96 ? "side-by-side" : "unified";
    this.editor = config.editor ?? createCommentEditor(config.tui, config.theme);
    this.selectFirstVisibleFile();
  }

  invalidate(): void {
    this.cancelPrewarm();
    this.prewarmContext = "";
    this.preparedFiles.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelPrewarm();
  }

  private requestRender(): void {
    this.config.tui.requestRender();
  }

  private prepareFile(fileIndex: number): PreparedFile {
    const cached = this.preparedFiles.get(fileIndex);
    if (cached) return cached;
    const file = this.config.diff.files[fileIndex];
    if (!file) throw new Error(`Unknown diff file index: ${fileIndex}`);

    const highlightedRows = new Map<DiffRow, HighlightedRow>();
    const oldRows: DiffRow[] = [];
    const newRows: DiffRow[] = [];
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        highlightedRows.set(row, { oldText: row.oldText, newText: row.newText });
        if (row.oldLineNumber !== undefined) oldRows.push(row);
        if (row.newLineNumber !== undefined) newRows.push(row);
      }
    }

    this.highlightSide(file, oldRows, "oldText", highlightedRows);
    this.highlightSide(file, newRows, "newText", highlightedRows);
    for (const hunk of file.hunks) {
      for (const row of hunk.rows) {
        if (row.kind !== "replace") continue;
        const highlighted = highlightedRows.get(row)!;
        const parts = intraLineDiff(row.oldText, row.newText);
        highlighted.oldText = styleIntraLineDiffSide(
          highlighted.oldText,
          parts,
          "old",
          this.config.theme,
        );
        highlighted.newText = styleIntraLineDiffSide(
          highlighted.newText,
          parts,
          "new",
          this.config.theme,
        );
      }
    }
    const prepared = { highlightedRows, views: new Map<string, VisualDiffRow[]>() };
    this.preparedFiles.set(fileIndex, prepared);
    return prepared;
  }

  private highlightSide(
    file: DiffFile,
    rows: DiffRow[],
    side: keyof HighlightedRow,
    highlightedRows: Map<DiffRow, HighlightedRow>,
  ): void {
    if (rows.length === 0) return;
    const source = rows.map((row) => row[side]).join("\n");
    const highlighted = (this.config.highlight ?? defaultHighlight)(source, file.path).split("\n");
    if (highlighted.length !== rows.length) {
      throw new Error(
        `Syntax highlighter returned ${highlighted.length} lines for ${rows.length} ${side} lines in ${file.path}`,
      );
    }
    rows.forEach((row, index) => {
      highlightedRows.get(row)![side] = highlighted[index]!;
    });
  }

  private visibleFileIndexes(): number[] {
    const rankedIndexes = fuzzyFilter(
      this.config.diff.files.map((file, index) => ({ file, index })),
      this.searchQuery,
      ({ file }) => file.path,
    ).map(({ index }) => index);
    return buildNavigatorRows(this.config.diff.files, rankedIndexes).flatMap((row) =>
      row.kind === "file" ? [row.fileIndex] : [],
    );
  }

  private navigatorRows(): NavigatorRow[] {
    return buildNavigatorRows(this.config.diff.files, this.visibleFileIndexes());
  }

  private selectedNavigatorRow(): NavigatorRow | undefined {
    const rows = this.navigatorRows();
    if (rows.length === 0) return undefined;
    this.selectedNavigatorIndex = Math.max(
      0,
      Math.min(rows.length - 1, this.selectedNavigatorIndex),
    );
    return rows[this.selectedNavigatorIndex];
  }

  private activeFileIndexes(): number[] {
    const row = this.selectedNavigatorRow();
    if (!row) return [];
    if (row.kind === "file") return [row.fileIndex];
    return row.fileIndexes;
  }

  private activeFile(): DiffFile | undefined {
    const indexes = this.activeFileIndexes();
    if (indexes.length !== 1) return undefined;
    return this.config.diff.files[indexes[0]!];
  }

  private selectableLines(): SelectableLineTarget[] {
    const file = this.activeFile();
    if (!file) return [];
    const targets: SelectableLineTarget[] = [];
    file.hunks.forEach((hunk, hunkIndex) => {
      for (const row of hunk.rows) {
        if ((row.kind === "delete" || row.kind === "replace") && row.oldLineNumber !== undefined) {
          targets.push({
            hunkIndex,
            row,
            side: "old",
            line: row.oldLineNumber,
            code: row.oldText,
          });
        }
        if ((row.kind === "insert" || row.kind === "replace") && row.newLineNumber !== undefined) {
          targets.push({
            hunkIndex,
            row,
            side: "new",
            line: row.newLineNumber,
            code: row.newText,
          });
        }
      }
    });
    return targets;
  }

  private selectedLine(): SelectableLineTarget | undefined {
    const targets = this.selectableLines();
    this.selectedLineIndex = Math.max(0, Math.min(targets.length - 1, this.selectedLineIndex));
    return targets[this.selectedLineIndex];
  }

  private lineReviewTarget(line = this.selectedLine()): ReviewTarget | undefined {
    const file = this.activeFile();
    if (!file || !line) return undefined;
    const targets = this.selectableLines();
    const selected =
      this.rangeAnchorIndex === undefined
        ? [line]
        : targets
            .slice(
              Math.min(this.rangeAnchorIndex, this.selectedLineIndex),
              Math.max(this.rangeAnchorIndex, this.selectedLineIndex) + 1,
            )
            .filter((target) => target.side === line.side && target.hunkIndex === line.hunkIndex);
    const ordered = (selected.length > 0 ? [...selected] : [line]).sort(
      (left, right) => left.line - right.line,
    );
    return {
      kind: "line",
      path: file.path,
      side: line.side,
      startLine: ordered[0]?.line ?? line.line,
      endLine: ordered.at(-1)?.line ?? line.line,
      code: ordered.map((target) => target.code),
    };
  }

  private coveringLineComment(line = this.selectedLine()) {
    return line ? this.commentAtLine(line) : undefined;
  }

  private moveLineSelection(delta: number): void {
    const targets = this.selectableLines();
    if (targets.length === 0) return;
    if (this.rangeAnchorIndex === undefined) {
      this.selectedLineIndex = Math.max(
        0,
        Math.min(targets.length - 1, this.selectedLineIndex + delta),
      );
      return;
    }

    const anchor = targets[this.rangeAnchorIndex];
    if (!anchor) return;
    for (
      let index = this.selectedLineIndex + Math.sign(delta);
      0 <= index && index < targets.length;
      index += Math.sign(delta)
    ) {
      const candidate = targets[index];
      if (candidate?.side === anchor.side && candidate.hunkIndex === anchor.hunkIndex) {
        this.selectedLineIndex = index;
        return;
      }
    }
  }

  private selectLineSide(side: "old" | "new"): void {
    if (this.viewMode !== "side-by-side" || this.rangeAnchorIndex !== undefined) return;
    const targets = this.selectableLines();
    const selected = targets[this.selectedLineIndex];
    if (!selected || selected.side === side) return;
    const pairIndex = targets.findIndex(
      (target) =>
        target.hunkIndex === selected.hunkIndex &&
        target.row === selected.row &&
        target.side === side,
    );
    if (pairIndex >= 0) this.selectedLineIndex = pairIndex;
  }

  private openCommentEditor(target: ReviewTarget): void {
    const existing = findReviewComment(this.reviewDraft, target);
    this.editTarget = target;
    this.editIntent = existing?.intent ?? "discuss";
    this.editor.setText(existing?.body ?? "");
    this.editor.focused = true;
    this.requestRender();
  }

  private saveCommentEditor(): void {
    if (!this.editTarget) return;
    this.reviewDraft = saveReviewComment(
      this.reviewDraft,
      this.editTarget,
      this.editor.getText(),
      this.editIntent,
    );
    this.editTarget = undefined;
    this.editor.focused = false;
    this.requestRender();
  }

  private selectFirstVisibleFile(): void {
    const rows = this.navigatorRows();
    const firstFile = rows.findIndex((row) => row.kind === "file");
    this.selectedNavigatorIndex = firstFile >= 0 ? firstFile : 0;
    this.selectedLineIndex = 0;
    this.diffScroll = 0;
  }

  private moveNavigator(delta: number): void {
    const rows = this.navigatorRows();
    if (rows.length === 0) return;
    this.selectedNavigatorIndex = Math.max(
      0,
      Math.min(rows.length - 1, this.selectedNavigatorIndex + delta),
    );
    this.selectedLineIndex = 0;
    this.rangeAnchorIndex = undefined;
    this.commentMode = false;
    this.diffScroll = 0;
    this.requestRender();
  }

  private moveFile(delta: number): void {
    const rows = this.navigatorRows();
    const filePositions = rows
      .map((row, index) => (row.kind === "file" ? index : -1))
      .filter((index) => index >= 0);
    if (filePositions.length === 0) return;
    const currentPos = this.selectedNavigatorIndex;
    let target =
      delta > 0
        ? filePositions.find((position) => position > currentPos)
        : [...filePositions].reverse().find((position) => position < currentPos);
    if (target === undefined) {
      target = delta > 0 ? filePositions.at(-1) : filePositions[0];
    }
    if (target === undefined) return;
    this.selectedNavigatorIndex = target;
    this.selectedLineIndex = 0;
    this.rangeAnchorIndex = undefined;
    this.commentMode = false;
    this.diffScroll = 0;
    this.requestRender();
  }

  private scrollDiff(delta: number): void {
    const maximum = Math.max(0, this.diffRowCount - this.diffPageSize);
    this.diffScroll = Math.max(0, Math.min(maximum, this.diffScroll + delta));
    this.requestRender();
  }

  private handleSearchInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.searchMode = false;
      this.searchQuery = "";
      this.selectFirstVisibleFile();
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.searchMode = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, Key.backspace)) {
      this.searchQuery = this.searchQuery.slice(0, -1);
      this.selectFirstVisibleFile();
      this.requestRender();
      return;
    }
    if (data.length === 1 && data >= " ") {
      this.searchQuery += data;
      this.selectFirstVisibleFile();
      this.requestRender();
    }
  }

  handleInput(data: string): void {
    if (this.editTarget) {
      if (matchesKey(data, Key.escape)) {
        this.editTarget = undefined;
        this.editor.focused = false;
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("o"))) {
        this.editIntent = this.editIntent === "fix" ? "discuss" : "fix";
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.shift("enter"))) {
        this.editor.handleInput("\n");
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        this.saveCommentEditor();
        return;
      }
      this.editor.handleInput(data);
      this.requestRender();
      return;
    }
    if (
      data === "s" &&
      this.reviewDraft.comments.length > 0 &&
      !this.searchMode &&
      !this.confirmDiscard
    ) {
      this.config.done(this.reviewDraft);
      return;
    }
    if (this.confirmDiscard) {
      if (data === "d") {
        this.config.done();
        return;
      }
      if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
        this.confirmDiscard = false;
        this.requestRender();
      }
      return;
    }
    if (this.reviewMode) {
      const comments = sortedReviewComments(this.reviewDraft);
      if (data === "q" || matchesKey(data, Key.ctrl("c"))) {
        this.reviewMode = false;
        this.confirmDiscard = this.reviewDraft.comments.length > 0;
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.escape) || data === "r") {
        this.reviewMode = false;
        this.requestRender();
        return;
      }
      if (data === "j" || matchesKey(data, Key.down)) {
        this.reviewSelection = Math.min(comments.length - 1, this.reviewSelection + 1);
        this.requestRender();
        return;
      }
      if (data === "k" || matchesKey(data, Key.up)) {
        this.reviewSelection = Math.max(0, this.reviewSelection - 1);
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const comment = comments[this.reviewSelection];
        if (comment) this.openCommentEditor(comment.target);
        return;
      }
      if (data === "x") {
        const comment = comments[this.reviewSelection];
        if (comment) {
          this.reviewDraft = saveReviewComment(
            this.reviewDraft,
            comment.target,
            "",
            comment.intent,
          );
          this.reviewSelection = Math.min(this.reviewSelection, Math.max(0, comments.length - 2));
        }
        this.requestRender();
        return;
      }
      return;
    }
    if (this.commentMode) {
      if (matchesKey(data, Key.escape)) {
        this.commentMode = false;
        this.rangeAnchorIndex = undefined;
        this.requestRender();
        return;
      }
      if (data === "V") {
        this.rangeAnchorIndex =
          this.rangeAnchorIndex === undefined ? this.selectedLineIndex : undefined;
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.left)) {
        this.selectLineSide("old");
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.right)) {
        this.selectLineSide("new");
        this.requestRender();
        return;
      }
      if (data === "j" || matchesKey(data, Key.down)) {
        this.moveLineSelection(1);
        this.requestRender();
        return;
      }
      if (data === "k" || matchesKey(data, Key.up)) {
        this.moveLineSelection(-1);
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("d"))) {
        this.moveLineSelection(Math.max(1, Math.floor(this.diffPageSize / 2)));
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.ctrl("u"))) {
        this.moveLineSelection(-Math.max(1, Math.floor(this.diffPageSize / 2)));
        this.requestRender();
        return;
      }
      if (matchesKey(data, Key.enter)) {
        const existing = this.coveringLineComment();
        const target = existing?.target ?? this.lineReviewTarget();
        if (target) this.openCommentEditor(target);
        return;
      }
      if (data === "x") {
        const existing = this.coveringLineComment();
        const target = existing?.target ?? this.lineReviewTarget();
        if (target) {
          this.reviewDraft = saveReviewComment(
            this.reviewDraft,
            target,
            "",
            existing?.intent ?? "fix",
          );
        }
        this.requestRender();
        return;
      }
      return;
    }
    if (this.searchMode) {
      this.handleSearchInput(data);
      return;
    }
    if (this.helpMode && (data === "?" || matchesKey(data, Key.escape))) {
      this.helpMode = false;
      this.requestRender();
      return;
    }
    if (data === "?") {
      this.helpMode = true;
      this.requestRender();
      return;
    }
    if (data === "q" || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      if (this.reviewDraft.comments.length > 0) {
        this.confirmDiscard = true;
        this.requestRender();
      } else {
        this.config.done();
      }
      return;
    }
    if (data === "l") {
      this.helpMode = false;
      const file = this.activeFile();
      if (file) this.openCommentEditor({ kind: "file", path: file.path });
      return;
    }
    if (data === "a") {
      this.helpMode = false;
      this.openCommentEditor({ kind: "all" });
      return;
    }
    if (data === "c") {
      this.helpMode = false;
      if (this.activeFile() && this.selectableLines().length > 0) {
        this.commentMode = true;
        this.selectedLineIndex = 0;
        this.rangeAnchorIndex = undefined;
        this.requestRender();
      }
      return;
    }
    if (data === "r") {
      this.helpMode = false;
      this.reviewMode = true;
      this.reviewSelection = 0;
      this.requestRender();
      return;
    }
    if (data === "t" || data === "/") {
      this.searchMode = true;
      this.navigatorVisible = true;
      this.requestRender();
      return;
    }
    if (data === "e") {
      this.navigatorVisible = !this.navigatorVisible;
      this.requestRender();
      return;
    }
    if (data === "s") return;
    if (data === "v") {
      this.viewMode = this.viewMode === "unified" ? "side-by-side" : "unified";
      this.diffScroll = 0;
      this.requestRender();
      return;
    }
    if (data === "j" || matchesKey(data, Key.down)) {
      this.moveNavigator(1);
      return;
    }
    if (data === "k" || matchesKey(data, Key.up)) {
      this.moveNavigator(-1);
      return;
    }
    if (data === "n") {
      this.moveFile(1);
      return;
    }
    if (data === "p" || data === "N") {
      this.moveFile(-1);
      return;
    }
    if (matchesKey(data, Key.ctrl("d"))) {
      this.scrollDiff(Math.max(1, Math.floor(this.diffPageSize / 2)));
      return;
    }
    if (matchesKey(data, Key.ctrl("u"))) {
      this.scrollDiff(-Math.max(1, Math.floor(this.diffPageSize / 2)));
      return;
    }
    if (matchesKey(data, "pageDown")) {
      this.scrollDiff(this.diffPageSize);
      return;
    }
    if (matchesKey(data, "pageUp")) {
      this.scrollDiff(-this.diffPageSize);
      return;
    }
    if (data === "g" || matchesKey(data, "home")) {
      this.diffScroll = 0;
      this.requestRender();
      return;
    }
    if (data === "G" || matchesKey(data, "end")) {
      this.diffScroll = Math.max(0, this.diffRowCount - this.diffPageSize);
      this.requestRender();
      return;
    }
  }

  private applyTone(line: string, tone: Tone): string {
    if (tone === "added") return `${deltaAddedRowBg}${line}\x1b[49m`;
    if (tone === "removed") return `${deltaRemovedRowBg}${line}\x1b[49m`;
    return line;
  }

  private wrappedLine(
    width: number,
    prefix: string,
    highlighted: string,
    tone: Tone,
    targets: SelectableLineTarget[] = [],
  ): VisualDiffRow[] {
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, width - prefixWidth);
    const wrapped = wrapTextWithAnsi(highlighted, contentWidth);
    const parts = wrapped.length > 0 ? wrapped : [""];
    return parts.map((part, index) => ({
      text: this.applyTone(
        fit(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${part}`, width),
        tone,
      ),
      targets,
    }));
  }

  private lineNumberWidth(file: DiffFile): number {
    let maximum = 1;
    for (const hunk of file.hunks) {
      maximum = Math.max(maximum, hunk.oldStart + hunk.oldCount, hunk.newStart + hunk.newCount);
    }
    return Math.max(4, String(maximum).length);
  }

  private highlightedRow(prepared: PreparedFile, row: DiffRow): HighlightedRow {
    const highlighted = prepared.highlightedRows.get(row);
    if (!highlighted) throw new Error("Diff row is missing from its prepared file");
    return highlighted;
  }

  private renderUnifiedLine(
    row: DiffRow,
    side: "old" | "new" | "context",
    hunkIndex: number,
    width: number,
    numberWidth: number,
    prepared: PreparedFile,
  ): VisualDiffRow[] {
    const oldNumber = side === "old" || side === "context" ? row.oldLineNumber : undefined;
    const newNumber = side === "new" || side === "context" ? row.newLineNumber : undefined;
    const tone: Tone = side === "old" ? "removed" : side === "new" ? "added" : "context";
    const highlighted = this.highlightedRow(prepared, row);
    const text = side === "old" ? highlighted.oldText : highlighted.newText;
    const oldLabel =
      oldNumber === undefined
        ? " ".repeat(numberWidth)
        : this.config.theme.fg(
            side === "old" ? "error" : "muted",
            String(oldNumber).padStart(numberWidth),
          );
    const newLabel =
      newNumber === undefined
        ? " ".repeat(numberWidth)
        : this.config.theme.fg(
            side === "new" ? "success" : "muted",
            String(newNumber).padStart(numberWidth),
          );
    const separator = this.config.theme.fg("borderAccent", ":");
    const rail = this.config.theme.fg("borderAccent", "│");
    const targetSide = side === "context" ? undefined : side;
    const lineNumber =
      targetSide === "old"
        ? row.oldLineNumber
        : targetSide === "new"
          ? row.newLineNumber
          : undefined;
    const targets: SelectableLineTarget[] =
      lineNumber === undefined || targetSide === undefined
        ? []
        : [
            {
              hunkIndex,
              row,
              side: targetSide,
              line: lineNumber,
              code: targetSide === "old" ? row.oldText : row.newText,
            },
          ];
    return this.wrappedLine(
      width,
      `${oldLabel} ${separator}${newLabel} ${rail} `,
      text,
      tone,
      targets,
    );
  }

  private renderUnifiedRows(
    file: DiffFile,
    width: number,
    prepared: PreparedFile,
  ): VisualDiffRow[] {
    const lines: VisualDiffRow[] = [];
    const numberWidth = this.lineNumberWidth(file);
    file.hunks.forEach((hunk, hunkIndex) => {
      lines.push({
        text: fit(
          this.config.theme.underline(this.config.theme.fg("warning", hunkLabel(hunk.header))),
          width,
        ),
        targets: [],
      });
      for (const row of hunk.rows) {
        if (row.kind === "equal") {
          lines.push(
            ...this.renderUnifiedLine(row, "context", hunkIndex, width, numberWidth, prepared),
          );
        } else if (row.kind === "delete") {
          lines.push(
            ...this.renderUnifiedLine(row, "old", hunkIndex, width, numberWidth, prepared),
          );
        } else if (row.kind === "insert") {
          lines.push(
            ...this.renderUnifiedLine(row, "new", hunkIndex, width, numberWidth, prepared),
          );
        } else {
          lines.push(
            ...this.renderUnifiedLine(row, "old", hunkIndex, width, numberWidth, prepared),
          );
          lines.push(
            ...this.renderUnifiedLine(row, "new", hunkIndex, width, numberWidth, prepared),
          );
        }
        if (row.oldNoNewline || row.newNoNewline) {
          lines.push({
            text: fit(this.config.theme.fg("muted", "\\ No newline at end of file"), width),
            targets: [],
          });
        }
      }
    });
    if (lines.length === 0) {
      lines.push({ text: fit(this.config.theme.fg("muted", "Empty file"), width), targets: [] });
    }
    return lines;
  }

  private renderSideCell(
    width: number,
    lineNumber: number | undefined,
    text: string,
    tone: Tone,
    numberWidth: number,
  ): string[] {
    if (lineNumber === undefined) return [" ".repeat(width)];
    const numberColor = tone === "removed" ? "error" : tone === "added" ? "success" : "muted";
    const gutter = this.config.theme.fg(numberColor, String(lineNumber).padStart(numberWidth));
    const rail = this.config.theme.fg("borderAccent", "│");
    return this.wrappedLine(width, `${gutter} ${rail} `, text, tone).map((row) => row.text);
  }

  private renderSideBySideRows(
    file: DiffFile,
    width: number,
    prepared: PreparedFile,
  ): VisualDiffRow[] {
    const separator = this.config.theme.fg("borderAccent", "│");
    const oldWidth = Math.max(1, Math.floor((width - 1) / 2));
    const newWidth = Math.max(1, width - 1 - oldWidth);
    const numberWidth = this.lineNumberWidth(file);
    const lines: VisualDiffRow[] = [
      {
        text: `${fit(this.config.theme.bold(this.config.theme.fg("error", "Deleted / Old")), oldWidth)}${separator}${fit(
          this.config.theme.bold(this.config.theme.fg("success", "Added / New")),
          newWidth,
        )}`,
        targets: [],
      },
    ];

    file.hunks.forEach((hunk, hunkIndex) => {
      lines.push({
        text: fit(
          this.config.theme.underline(this.config.theme.fg("warning", hunkLabel(hunk.header))),
          width,
        ),
        targets: [],
      });
      for (const row of hunk.rows) {
        const oldTone: Tone = row.kind === "equal" ? "context" : "removed";
        const newTone: Tone = row.kind === "equal" ? "context" : "added";
        const highlighted = this.highlightedRow(prepared, row);
        const oldLines = this.renderSideCell(
          oldWidth,
          row.oldLineNumber,
          highlighted.oldText,
          oldTone,
          numberWidth,
        );
        const newLines = this.renderSideCell(
          newWidth,
          row.newLineNumber,
          highlighted.newText,
          newTone,
          numberWidth,
        );
        const targets: SelectableLineTarget[] = [];
        if (row.kind !== "equal" && row.oldLineNumber !== undefined) {
          targets.push({
            hunkIndex,
            row,
            side: "old",
            line: row.oldLineNumber,
            code: row.oldText,
          });
        }
        if (row.kind !== "equal" && row.newLineNumber !== undefined) {
          targets.push({
            hunkIndex,
            row,
            side: "new",
            line: row.newLineNumber,
            code: row.newText,
          });
        }
        const rowHeight = Math.max(oldLines.length, newLines.length);
        for (let index = 0; index < rowHeight; index++) {
          lines.push({
            text: `${oldLines[index] ?? " ".repeat(oldWidth)}${separator}${newLines[index] ?? " ".repeat(newWidth)}`,
            targets,
          });
        }
        if (row.oldNoNewline || row.newNoNewline) {
          lines.push({
            text: fit(this.config.theme.fg("muted", "\\ No newline at end of file"), width),
            targets: [],
          });
        }
      }
    });
    if (file.hunks.length === 0) {
      lines.push({ text: fit(this.config.theme.fg("muted", "Empty file"), width), targets: [] });
    }
    return lines;
  }

  private viewCacheKey(viewMode: ViewMode, width: number): string {
    return `${viewMode}:${width}`;
  }

  private renderedRows(fileIndex: number, width: number, viewMode: ViewMode): VisualDiffRow[] {
    const file = this.config.diff.files[fileIndex];
    if (!file) throw new Error(`Unknown diff file index: ${fileIndex}`);
    const prepared = this.prepareFile(fileIndex);
    const key = this.viewCacheKey(viewMode, width);
    const cached = prepared.views.get(key);
    if (cached) return cached;
    const rows =
      viewMode === "side-by-side"
        ? this.renderSideBySideRows(file, width, prepared)
        : this.renderUnifiedRows(file, width, prepared);
    prepared.views.set(key, rows);
    return rows;
  }

  private scheduleAdjacentPrewarm(width: number): void {
    const context = `${this.viewMode}:${width}:${this.searchQuery}`;
    if (context !== this.prewarmContext) {
      this.cancelPrewarm();
      this.prewarmContext = context;
    }

    const indexes = this.visibleFileIndexes();
    const active = this.activeFileIndexes();
    const current = active.length === 1 ? indexes.indexOf(active[0]!) : -1;
    if (current < 0) return;
    for (const position of [current + 1, current - 1]) {
      const fileIndex = indexes[position];
      if (fileIndex !== undefined) this.enqueuePrewarm(fileIndex, width, this.viewMode);
    }
    this.scheduleNextPrewarm();
  }

  private enqueuePrewarm(fileIndex: number, width: number, viewMode: ViewMode): void {
    const viewKey = this.viewCacheKey(viewMode, width);
    if (this.preparedFiles.get(fileIndex)?.views.has(viewKey)) return;
    const key = `${fileIndex}:${viewKey}`;
    if (this.prewarmKeys.has(key)) return;
    this.prewarmKeys.add(key);
    this.prewarmQueue.push({ key, fileIndex, width, viewMode });
  }

  private scheduleNextPrewarm(): void {
    if (this.disposed || this.prewarmHandle || this.prewarmQueue.length === 0) return;
    const task = this.prewarmQueue.shift()!;
    this.prewarmHandle = setImmediate(() => {
      this.prewarmHandle = undefined;
      this.prewarmKeys.delete(task.key);
      if (!this.disposed) {
        const viewKey = this.viewCacheKey(task.viewMode, task.width);
        if (!this.preparedFiles.get(task.fileIndex)?.views.has(viewKey)) {
          this.renderedRows(task.fileIndex, task.width, task.viewMode);
        }
      }
      this.scheduleNextPrewarm();
    });
    this.prewarmHandle.unref?.();
  }

  private cancelPrewarm(): void {
    if (this.prewarmHandle) clearImmediate(this.prewarmHandle);
    this.prewarmHandle = undefined;
    this.prewarmQueue = [];
    this.prewarmKeys.clear();
  }

  private commentAtLine(line: SelectableLineTarget) {
    const file = this.activeFile();
    if (!file) return undefined;
    return this.reviewDraft.comments.find((comment) => {
      const target = comment.target;
      return (
        target.kind === "line" &&
        target.path === file.path &&
        target.side === line.side &&
        target.startLine <= line.line &&
        line.line <= target.endLine
      );
    });
  }

  private decorateVisualRow(row: VisualDiffRow, width: number): string {
    const selected = this.commentMode ? this.selectedLine() : undefined;
    const isSelected =
      selected &&
      row.targets.some(
        (target) =>
          target.hunkIndex === selected.hunkIndex &&
          target.side === selected.side &&
          target.line === selected.line,
      );
    const range =
      this.commentMode && this.rangeAnchorIndex !== undefined
        ? this.lineReviewTarget(selected)
        : undefined;
    const isInRange =
      range?.kind === "line" &&
      row.targets.some(
        (target) =>
          target.side === range.side &&
          range.startLine <= target.line &&
          target.line <= range.endLine,
      );
    const cursor = isSelected
      ? this.config.theme.fg("accent", selected.side === "old" ? "‹" : "›")
      : isInRange
        ? this.config.theme.fg("accent", "┃")
        : " ";
    const comment = row.targets.map((target) => this.commentAtLine(target)).find(Boolean);
    const marker = comment
      ? this.config.theme.fg(comment.intent === "fix" ? "error" : "accent", "●")
      : " ";
    return `${cursor}${marker}${fit(row.text, Math.max(1, width - 2))}`;
  }

  private addScrollbar(rows: VisualDiffRow[], width: number, pageSize: number): string[] {
    const contentWidth = Math.max(1, width - 1);
    const maximum = Math.max(0, rows.length - pageSize);
    this.diffScroll = Math.max(0, Math.min(maximum, this.diffScroll));
    const visible = rows.slice(this.diffScroll, this.diffScroll + pageSize);
    if (pageSize <= 0) return [];

    const thumbSize =
      rows.length <= pageSize
        ? pageSize
        : Math.max(1, Math.floor((pageSize * pageSize) / rows.length));
    const thumbStart =
      maximum === 0 ? 0 : Math.floor((this.diffScroll * (pageSize - thumbSize)) / maximum);
    return visible.map((row, index) => {
      const inThumb = index >= thumbStart && index < thumbStart + thumbSize;
      const marker = this.config.theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "┃" : "│");
      return `${fit(this.decorateVisualRow(row, contentWidth), contentWidth)}${marker}`;
    });
  }

  private renderNavigatorContent(width: number, height: number): string[] {
    const indexes = this.visibleFileIndexes();
    const header = this.searchMode
      ? `Filter: ${this.searchQuery}_`
      : this.searchQuery
        ? `Filter: ${this.searchQuery}`
        : `${indexes.length} file${indexes.length === 1 ? "" : "s"}`;
    const lines = [
      this.config.theme.fg(this.searchMode ? "accent" : "muted", header),
      "─".repeat(width),
    ];
    const treeRows = this.navigatorRows();
    this.selectedNavigatorIndex = Math.max(
      0,
      Math.min(Math.max(0, treeRows.length - 1), this.selectedNavigatorIndex),
    );
    const pageSize = Math.max(1, height - lines.length);
    const activePosition = this.selectedNavigatorIndex;
    if (activePosition < this.navigatorScroll) this.navigatorScroll = activePosition;
    if (activePosition >= this.navigatorScroll + pageSize) {
      this.navigatorScroll = activePosition - pageSize + 1;
    }
    const maximumScroll = Math.max(0, treeRows.length - pageSize);
    this.navigatorScroll = Math.min(this.navigatorScroll, maximumScroll);

    treeRows.slice(this.navigatorScroll, this.navigatorScroll + pageSize).forEach((row, offset) => {
      const absoluteIndex = this.navigatorScroll + offset;
      const selected = absoluteIndex === this.selectedNavigatorIndex;
      if (row.kind === "root") {
        const rendered = fit(this.config.theme.bold(this.config.theme.fg("accent", " /")), width);
        lines.push(selected ? this.config.theme.bg("selectedBg", rendered) : rendered);
        return;
      }

      const connector = this.config.theme.fg("borderMuted", "│".repeat(row.depth));
      if (row.kind === "directory") {
        const rendered = fit(
          `${connector}${this.config.theme.fg("accent", ` ${row.label}`)}`,
          width,
        );
        lines.push(selected ? this.config.theme.bg("selectedBg", rendered) : rendered);
        return;
      }

      const file = this.config.diff.files[row.fileIndex];
      if (!file) return;
      const tone =
        file.status === "added" ? "success" : file.status === "deleted" ? "error" : "warning";
      const icon = this.config.theme.fg(tone, statusIcon(file.status));
      const stats = [
        file.additions > 0 ? this.config.theme.fg("success", `+${file.additions}`) : "",
        file.deletions > 0 ? this.config.theme.fg("error", `-${file.deletions}`) : "",
      ]
        .filter(Boolean)
        .join(" ");
      const prefix = `${connector}${icon} `;
      const commentCount = countReviewCommentsForFile(this.reviewDraft, file.path);
      const commentMarker =
        commentCount > 0 ? this.config.theme.fg("accent", ` ${commentCount}●`) : "";
      const suffix = `${commentMarker}${stats ? ` ${stats}` : ""}`;
      const nameWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
      const name = truncateToWidth(row.label, nameWidth, "…", true);
      const rendered = fit(`${prefix}${this.config.theme.fg(tone, name)}${suffix}`, width);
      lines.push(selected ? this.config.theme.bg("selectedBg", rendered) : rendered);
    });

    if (indexes.length === 0) lines.push(this.config.theme.fg("warning", "No matching files"));
    return lines;
  }

  private renderReviewContent(width: number, height: number): string[] {
    const comments = sortedReviewComments(this.reviewDraft);
    const lines = [
      this.config.theme.bold("Review comments"),
      this.config.theme.fg(
        "muted",
        `${comments.length} comment${comments.length === 1 ? "" : "s"}`,
      ),
      this.config.theme.fg("borderMuted", "─".repeat(width)),
    ];
    if (comments.length === 0) {
      lines.push(this.config.theme.fg("dim", "No comments yet."));
      return lines;
    }

    comments.forEach((comment, index) => {
      const target = comment.target;
      const location =
        target.kind === "all"
          ? "Entire diff"
          : target.kind === "file"
            ? target.path
            : `${target.path}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`} (${target.side === "old" ? "deleted" : "added"})`;
      const prefix = index === this.reviewSelection ? "› " : "  ";
      lines.push(
        fit(
          `${this.config.theme.fg("accent", prefix)}${this.config.theme.bold(comment.intent.toUpperCase())} ${location}`,
          width,
        ),
      );
      for (const bodyLine of wrapTextWithAnsi(comment.body, Math.max(1, width - 4))) {
        lines.push(fit(`    ${this.config.theme.fg("muted", bodyLine)}`, width));
      }
    });
    return lines.slice(0, height);
  }

  private renderHelpContent(width: number, height: number): string[] {
    const help = [
      "j/k or ↑/↓       next / previous tree node",
      "n / p            next / previous file",
      "Ctrl+D/U          diff down / up",
      "PageUp/PageDown   diff page",
      "g / G             first / last diff row",
      "t or /            filter files",
      "v                 unified / side-by-side",
      "c                 enter changed-line comments",
      "l / a             file / entire-diff comment",
      "r                 review comments",
      "s                 submit to main editor",
      "e                 toggle file navigator",
      "q / Esc           close",
      "?                 close help",
    ];
    const topPadding = Math.max(0, Math.floor((height - help.length) / 2));
    return [
      ...Array.from({ length: topPadding }, () => ""),
      ...help.map((line) => fit(line, width)),
    ];
  }

  private renderDiffContent(width: number, height: number): string[] {
    if (this.editTarget) {
      const target = this.editTarget;
      const location =
        target.kind === "all"
          ? "Entire diff"
          : target.kind === "file"
            ? target.path
            : `${target.path}:${target.startLine}${target.endLine === target.startLine ? "" : `-${target.endLine}`} (${target.side === "old" ? "deleted" : "added"})`;
      return [
        this.config.theme.bold(`Edit ${this.editIntent.toUpperCase()} comment`),
        this.config.theme.fg("muted", location),
        this.config.theme.fg(
          "dim",
          "Enter save • Shift+Enter newline • Ctrl+O intent • Esc cancel",
        ),
        "",
        ...this.editor.render(Math.max(10, width - 2)).slice(0, Math.max(1, height - 4)),
      ];
    }
    if (this.helpMode) return this.renderHelpContent(width, height);
    const indexes = this.activeFileIndexes();
    if (indexes.length === 0) return [this.config.theme.fg("warning", "No file selected")];

    const bodyHeight = Math.max(1, height - 3);
    const contentWidth = Math.max(1, width - 1);
    const rowWidth = Math.max(1, contentWidth - 2);
    const selectedRow = this.selectedNavigatorRow();
    const rows: VisualDiffRow[] = [];
    let additions = 0;
    let deletions = 0;
    for (const [offset, fileIndex] of indexes.entries()) {
      const file = this.config.diff.files[fileIndex];
      if (!file) continue;
      additions += file.additions;
      deletions += file.deletions;
      if (indexes.length > 1) {
        if (offset > 0) rows.push({ text: "", targets: [] });
        rows.push({
          text: fit(
            this.config.theme.underline(this.config.theme.fg("warning", file.path)),
            rowWidth,
          ),
          targets: [],
        });
        rows.push({
          text: fit(
            `${this.config.theme.fg("success", `+${file.additions}`)} ${this.config.theme.fg(
              "error",
              `-${file.deletions}`,
            )}`,
            rowWidth,
          ),
          targets: [],
        });
      }
      rows.push(...this.renderedRows(fileIndex, rowWidth, this.viewMode));
    }
    this.scheduleAdjacentPrewarm(rowWidth);
    this.diffPageSize = bodyHeight;
    this.diffRowCount = rows.length;
    const maximum = Math.max(0, rows.length - bodyHeight);
    if (this.commentMode && indexes.length === 1) {
      const selected = this.selectedLine();
      const selectedVisual = selected
        ? rows.findIndex((row) =>
            row.targets.some(
              (target) =>
                target.hunkIndex === selected.hunkIndex &&
                target.row === selected.row &&
                target.side === selected.side,
            ),
          )
        : -1;
      if (selectedVisual >= 0 && selectedVisual < this.diffScroll) this.diffScroll = selectedVisual;
      if (selectedVisual >= this.diffScroll + bodyHeight) {
        this.diffScroll = selectedVisual - bodyHeight + 1;
      }
    }
    this.diffScroll = Math.max(0, Math.min(maximum, this.diffScroll));
    const firstRow = rows.length === 0 ? 0 : this.diffScroll + 1;
    const lastRow = Math.min(rows.length, this.diffScroll + bodyHeight);
    const title =
      selectedRow?.kind === "file"
        ? selectedRow.path
        : selectedRow?.kind === "directory"
          ? selectedRow.path
          : "/";
    const summary =
      indexes.length === 1
        ? `${this.config.theme.fg("success", `+${additions}`)} ${this.config.theme.fg(
            "error",
            `-${deletions}`,
          )} • ${this.viewMode} • rows ${firstRow}-${lastRow}/${rows.length}`
        : `${this.config.theme.fg("success", `+${additions}`)} ${this.config.theme.fg(
            "error",
            `-${deletions}`,
          )} • ${indexes.length} files • ${this.viewMode} • rows ${firstRow}-${lastRow}/${rows.length}`;

    return [
      this.config.theme.underline(this.config.theme.fg("warning", title)),
      summary,
      this.config.theme.fg("borderMuted", "─".repeat(width)),
      ...this.addScrollbar(rows, width, bodyHeight),
    ];
  }

  render(width: number): string[] {
    const terminalRows = this.config.tui.terminal.rows;
    const totalHeight = Math.max(8, terminalRows);
    const panelHeight = Math.max(5, totalHeight - 3);
    const showNavigator = this.navigatorVisible && width >= 64;
    const navigatorWidth = showNavigator ? Math.min(36, Math.max(24, Math.floor(width * 0.26))) : 0;
    const diffWidth = showNavigator ? width - navigatorWidth - 1 : width;
    const theme = this.config.theme;
    const header = fit(
      `${theme.bold(theme.fg("accent", "SESSION DIFF"))}  ${this.config.diff.files.length} files  ${theme.fg(
        "success",
        `+${this.config.diff.additions}`,
      )} ${theme.fg("error", `-${this.config.diff.deletions}`)}${
        this.reviewDraft.comments.length > 0
          ? `  ${theme.fg("accent", `${this.reviewDraft.comments.length} comments`)}`
          : ""
      }`,
      width,
    );
    const separator = theme.fg("border", "─".repeat(width));
    const diffPanel = renderPanel(
      this.helpMode
        ? "Help"
        : this.editTarget
          ? `Edit ${this.editIntent.toUpperCase()} comment`
          : this.activeFileIndexes().length === 1
            ? `Diff (${this.activeFile()?.hunks.length ?? 0} hunks)`
            : `Diff (${this.activeFileIndexes().length} files)`,
      diffWidth,
      panelHeight,
      theme,
      this.renderDiffContent(Math.max(1, diffWidth - 2), Math.max(1, panelHeight - 2)),
    );

    let body = diffPanel;
    if (showNavigator) {
      const navigator = renderPanel(
        "Navigator",
        navigatorWidth,
        panelHeight,
        theme,
        this.renderNavigatorContent(Math.max(1, navigatorWidth - 2), Math.max(1, panelHeight - 2)),
      );
      body = navigator.map((line, index) => `${line} ${diffPanel[index] ?? ""}`);
    }

    const selected = this.selectedLine();
    const footerText = this.editTarget
      ? `Editing ${this.editIntent.toUpperCase()} • Enter save • Shift+Enter newline • Ctrl+O intent • Esc cancel`
      : this.confirmDiscard
        ? "Discard review • d discard • Enter/Esc keep reviewing"
        : this.reviewMode
          ? "Review comments • j/k select • Enter edit • x delete • Esc close"
          : this.commentMode
            ? `Comment mode • ${selected?.side === "old" ? "deleted" : "added"} ${selected?.line ?? "-"} • j/k lines • Ctrl+D/U page • ←/→ side • V range • Enter comment • Esc files`
            : this.searchMode
              ? "Type to filter • Enter apply • Esc clear"
              : "j/k tree • n/p files • c line • l file • a all • r review • v view • s submit • ? help • q close";
    let rendered = [header, separator, ...body, fit(theme.fg("dim", footerText), width)];
    if (this.reviewMode && !this.editTarget) {
      const modalWidth = Math.max(24, Math.min(width - 4, Math.floor(width * 0.72)));
      const modalHeight = Math.max(
        6,
        Math.min(totalHeight - 4, 6 + this.reviewDraft.comments.length * 3),
      );
      rendered = renderCenteredOverlay(
        rendered,
        renderPanel(
          "Review",
          modalWidth,
          modalHeight,
          theme,
          this.renderReviewContent(modalWidth - 2, modalHeight - 2),
        ),
        width,
      );
    } else if (this.confirmDiscard) {
      const modalWidth = Math.max(24, Math.min(width - 4, 54));
      const content = [
        theme.bold(`Discard ${this.reviewDraft.comments.length} review comments?`),
        "",
        theme.fg("warning", "d discard and close"),
        theme.fg("muted", "Enter / Esc keep reviewing"),
      ];
      rendered = renderCenteredOverlay(
        rendered,
        renderPanel("Discard review", modalWidth, 7, theme, content),
        width,
      );
    }
    return rendered;
  }
}

export function createDiffViewerComponent(config: DiffViewerConfig): DiffViewer {
  return new DiffViewer(config);
}
