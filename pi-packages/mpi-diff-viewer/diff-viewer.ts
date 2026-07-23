import {
  type ExtensionCommandContext,
  getLanguageFromPath,
  highlightCode,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  sliceByColumn,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { DiffFile, DiffRow, SessionDiff } from "./session-diff.js";

interface ViewerTui {
  terminal: { columns: number; rows: number };
  requestRender(): void;
}

export interface DiffViewerConfig {
  tui: ViewerTui;
  theme: Theme;
  diff: SessionDiff;
  done: () => void;
  highlight?: (text: string, path: string) => string;
}

type ViewMode = "unified" | "side-by-side";
type Tone = "context" | "added" | "removed";

interface HighlightedRow {
  oldText: string;
  newText: string;
}

interface PreparedFile {
  highlightedRows: Map<DiffRow, HighlightedRow>;
  views: Map<string, string[]>;
}

interface PrewarmTask {
  key: string;
  fileIndex: number;
  width: number;
  viewMode: ViewMode;
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
  | { kind: "root"; depth: number; label: string }
  | { kind: "directory"; depth: number; label: string }
  | { kind: "file"; depth: number; label: string; fileIndex: number };

function fit(text: string, width: number): string {
  if (width <= 0) return "";
  return truncateToWidth(text, width, "", true);
}

function statusLabel(status: DiffFile["status"]): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  return "M";
}

function statusIcon(status: DiffFile["status"]): string {
  if (status === "added") return "";
  if (status === "deleted") return "";
  return "";
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

  const rows: NavigatorRow[] = [{ kind: "root", depth: 0, label: "/" }];
  const appendNode = (node: FileTreeNode, depth: number): void => {
    if (node.kind === "file") {
      rows.push({ kind: "file", depth, label: node.name, fileIndex: node.fileIndex });
      return;
    }

    const names = [node.name];
    let directory = node;
    while (directory.children.length === 1 && directory.children[0]?.kind === "directory") {
      directory = directory.children[0];
      names.push(directory.name);
    }
    rows.push({ kind: "directory", depth, label: names.join("/") });
    for (const child of directory.children) appendNode(child, depth + 1);
  };

  for (const child of root.children) appendNode(child, 1);
  return rows;
}

function fuzzyScore(query: string, candidate: string): number {
  const needle = query.trim().toLowerCase().replace(/\s+/g, "");
  const haystack = candidate.toLowerCase();
  if (!needle) return 0;
  const exactIndex = haystack.indexOf(needle);
  if (exactIndex >= 0) return 1_000 - exactIndex;

  let needleIndex = 0;
  let score = 0;
  let previousMatch = -2;
  for (let index = 0; index < haystack.length && needleIndex < needle.length; index++) {
    if (haystack[index] !== needle[needleIndex]) continue;
    score += index === previousMatch + 1 ? 8 : 2;
    if (index === 0 || "/_.-".includes(haystack[index - 1] ?? "")) score += 5;
    previousMatch = index;
    needleIndex++;
  }
  return needleIndex === needle.length ? score : -1;
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

type IntraLineDiffKind = "equal" | "added" | "removed";

interface IntraLineDiffPart {
  kind: IntraLineDiffKind;
  value: string;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter("en", { granularity: "word" });
const hanPattern = /\p{Script=Han}/u;
const trailingAnsiPattern = /(?:\x1b\[[0-?]*[ -/]*[@-~])+$/;

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
  let column = 0;
  let rendered = "";
  for (const part of parts) {
    if ((side === "old" && part.kind === "added") || (side === "new" && part.kind === "removed")) {
      continue;
    }
    const width = visibleWidth(part.value);
    const text = sliceByColumn(highlighted, column, width, true);
    const changed = side === "old" ? part.kind === "removed" : part.kind === "added";
    if (changed) {
      const color = side === "old" ? "error" : "success";
      const plainText = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
      rendered += theme.bold(theme.underline(theme.fg(color, plainText)));
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

export class DiffViewer {
  private selectedFileIndex = 0;
  private viewMode: ViewMode;
  private navigatorVisible = true;
  private navigatorScroll = 0;
  private diffScroll = 0;
  private diffPageSize = 1;
  private diffRowCount = 0;
  private searchMode = false;
  private searchQuery = "";
  private helpMode = false;
  private preparedFiles = new Map<number, PreparedFile>();
  private prewarmQueue: PrewarmTask[] = [];
  private prewarmKeys = new Set<string>();
  private prewarmHandle: ReturnType<typeof setImmediate> | undefined;
  private prewarmContext = "";
  private disposed = false;

  constructor(private readonly config: DiffViewerConfig) {
    this.viewMode = config.tui.terminal.columns >= 96 ? "side-by-side" : "unified";
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
    const prepared = { highlightedRows, views: new Map<string, string[]>() };
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
    const rankedIndexes = this.config.diff.files
      .map((file, index) => {
        const pathScore = fuzzyScore(this.searchQuery, file.path);
        const baseScore = fuzzyScore(this.searchQuery, file.path.split("/").pop() ?? file.path);
        return { index, score: Math.max(pathScore, baseScore < 0 ? -1 : baseScore + 20) };
      })
      .filter((entry) => entry.score >= 0)
      .sort((left, right) => right.score - left.score || left.index - right.index)
      .map((entry) => entry.index);
    return buildNavigatorRows(this.config.diff.files, rankedIndexes).flatMap((row) =>
      row.kind === "file" ? [row.fileIndex] : [],
    );
  }

  private activeFile(): DiffFile | undefined {
    return this.config.diff.files[this.selectedFileIndex];
  }

  private selectFirstVisibleFile(): void {
    const first = this.visibleFileIndexes()[0];
    this.selectedFileIndex = first ?? -1;
    this.diffScroll = 0;
  }

  private moveFile(delta: number): void {
    const indexes = this.visibleFileIndexes();
    if (indexes.length === 0) return;
    const current = indexes.indexOf(this.selectedFileIndex);
    const next = Math.max(0, Math.min(indexes.length - 1, (current < 0 ? 0 : current) + delta));
    this.selectedFileIndex = indexes[next]!;
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
      this.config.done();
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
    if (data === "s" || data === "v") {
      this.viewMode = this.viewMode === "unified" ? "side-by-side" : "unified";
      this.diffScroll = 0;
      this.requestRender();
      return;
    }
    if (data === "j" || data === "n" || matchesKey(data, Key.down)) {
      this.moveFile(1);
      return;
    }
    if (data === "k" || data === "p" || data === "N" || matchesKey(data, Key.up)) {
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
    if (tone === "added") {
      return this.config.theme.bg("toolSuccessBg", this.config.theme.bold(line));
    }
    if (tone === "removed") {
      return this.config.theme.bg("toolErrorBg", this.config.theme.bold(line));
    }
    return line;
  }

  private wrappedLine(width: number, prefix: string, highlighted: string, tone: Tone): string[] {
    const prefixWidth = visibleWidth(prefix);
    const contentWidth = Math.max(1, width - prefixWidth);
    const wrapped = wrapTextWithAnsi(highlighted, contentWidth);
    const parts = wrapped.length > 0 ? wrapped : [""];
    return parts.map((part, index) =>
      this.applyTone(fit(`${index === 0 ? prefix : " ".repeat(prefixWidth)}${part}`, width), tone),
    );
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
    width: number,
    numberWidth: number,
    prepared: PreparedFile,
  ): string[] {
    const oldNumber = side === "old" || side === "context" ? row.oldLineNumber : undefined;
    const newNumber = side === "new" || side === "context" ? row.newLineNumber : undefined;
    const sign = side === "old" ? "-" : side === "new" ? "+" : " ";
    const tone: Tone = side === "old" ? "removed" : side === "new" ? "added" : "context";
    const highlighted = this.highlightedRow(prepared, row);
    const text = side === "old" ? highlighted.oldText : highlighted.newText;
    const gutter = `${oldNumber === undefined ? " ".repeat(numberWidth) : String(oldNumber).padStart(numberWidth)} ${
      newNumber === undefined ? " ".repeat(numberWidth) : String(newNumber).padStart(numberWidth)
    } `;
    const coloredSign = this.config.theme.fg(
      sign === "+" ? "success" : sign === "-" ? "error" : "toolDiffContext",
      sign,
    );
    return this.wrappedLine(
      width,
      `${this.config.theme.fg("borderMuted", gutter)}${coloredSign} `,
      text,
      tone,
    );
  }

  private renderUnifiedRows(file: DiffFile, width: number, prepared: PreparedFile): string[] {
    const lines: string[] = [];
    const numberWidth = this.lineNumberWidth(file);
    for (const hunk of file.hunks) {
      lines.push(fit(this.config.theme.fg("accent", hunk.header), width));
      for (const row of hunk.rows) {
        if (row.kind === "equal") {
          lines.push(...this.renderUnifiedLine(row, "context", width, numberWidth, prepared));
        } else if (row.kind === "delete") {
          lines.push(...this.renderUnifiedLine(row, "old", width, numberWidth, prepared));
        } else if (row.kind === "insert") {
          lines.push(...this.renderUnifiedLine(row, "new", width, numberWidth, prepared));
        } else {
          lines.push(...this.renderUnifiedLine(row, "old", width, numberWidth, prepared));
          lines.push(...this.renderUnifiedLine(row, "new", width, numberWidth, prepared));
        }
        if (row.oldNoNewline || row.newNoNewline) {
          lines.push(fit(this.config.theme.fg("muted", "\\ No newline at end of file"), width));
        }
      }
    }
    if (lines.length === 0) lines.push(fit(this.config.theme.fg("muted", "Empty file"), width));
    return lines;
  }

  private renderSideCell(
    width: number,
    lineNumber: number | undefined,
    sign: " " | "+" | "-",
    text: string,
    tone: Tone,
    numberWidth: number,
  ): string[] {
    if (lineNumber === undefined) return [" ".repeat(width)];
    const coloredSign = this.config.theme.fg(
      sign === "+" ? "success" : sign === "-" ? "error" : "toolDiffContext",
      sign,
    );
    const gutter = this.config.theme.fg("borderMuted", String(lineNumber).padStart(numberWidth));
    return this.wrappedLine(width, `${gutter} ${coloredSign} `, text, tone);
  }

  private renderSideBySideRows(file: DiffFile, width: number, prepared: PreparedFile): string[] {
    const separator = this.config.theme.fg("borderMuted", "│");
    const oldWidth = Math.max(1, Math.floor((width - 1) / 2));
    const newWidth = Math.max(1, width - 1 - oldWidth);
    const numberWidth = this.lineNumberWidth(file);
    const lines = [
      `${fit(this.config.theme.fg("muted", "Deleted / Old"), oldWidth)}${separator}${fit(
        this.config.theme.fg("muted", "Added / New"),
        newWidth,
      )}`,
    ];

    for (const hunk of file.hunks) {
      lines.push(fit(this.config.theme.fg("accent", hunk.header), width));
      for (const row of hunk.rows) {
        const oldTone: Tone = row.kind === "equal" ? "context" : "removed";
        const newTone: Tone = row.kind === "equal" ? "context" : "added";
        const highlighted = this.highlightedRow(prepared, row);
        const oldLines = this.renderSideCell(
          oldWidth,
          row.oldLineNumber,
          row.kind === "equal" ? " " : "-",
          highlighted.oldText,
          oldTone,
          numberWidth,
        );
        const newLines = this.renderSideCell(
          newWidth,
          row.newLineNumber,
          row.kind === "equal" ? " " : "+",
          highlighted.newText,
          newTone,
          numberWidth,
        );
        const rowHeight = Math.max(oldLines.length, newLines.length);
        for (let index = 0; index < rowHeight; index++) {
          lines.push(
            `${oldLines[index] ?? " ".repeat(oldWidth)}${separator}${newLines[index] ?? " ".repeat(newWidth)}`,
          );
        }
        if (row.oldNoNewline || row.newNoNewline) {
          lines.push(fit(this.config.theme.fg("muted", "\\ No newline at end of file"), width));
        }
      }
    }
    if (file.hunks.length === 0)
      lines.push(fit(this.config.theme.fg("muted", "Empty file"), width));
    return lines;
  }

  private viewCacheKey(viewMode: ViewMode, width: number): string {
    return `${viewMode}:${width}`;
  }

  private renderedRows(fileIndex: number, width: number, viewMode: ViewMode): string[] {
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
    const current = indexes.indexOf(this.selectedFileIndex);
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

  private addScrollbar(rows: string[], width: number, pageSize: number): string[] {
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
    return visible.map((line, index) => {
      const inThumb = index >= thumbStart && index < thumbStart + thumbSize;
      const marker = this.config.theme.fg(inThumb ? "accent" : "borderMuted", inThumb ? "┃" : "│");
      return `${fit(line, contentWidth)}${marker}`;
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
    const treeRows = buildNavigatorRows(this.config.diff.files, indexes);
    const pageSize = Math.max(1, height - lines.length);
    const selectedRow = treeRows.findIndex(
      (row) => row.kind === "file" && row.fileIndex === this.selectedFileIndex,
    );
    const activePosition = Math.max(0, selectedRow);
    if (activePosition < this.navigatorScroll) this.navigatorScroll = activePosition;
    if (activePosition >= this.navigatorScroll + pageSize) {
      this.navigatorScroll = activePosition - pageSize + 1;
    }
    const maximumScroll = Math.max(0, treeRows.length - pageSize);
    this.navigatorScroll = Math.min(this.navigatorScroll, maximumScroll);

    for (const row of treeRows.slice(this.navigatorScroll, this.navigatorScroll + pageSize)) {
      if (row.kind === "root") {
        lines.push(fit(this.config.theme.bold(this.config.theme.fg("accent", " /")), width));
        continue;
      }

      const connector = this.config.theme.fg("borderMuted", "│".repeat(row.depth));
      if (row.kind === "directory") {
        lines.push(fit(`${connector}${this.config.theme.fg("accent", ` ${row.label}`)}`, width));
        continue;
      }

      const file = this.config.diff.files[row.fileIndex];
      if (!file) continue;
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
      const suffix = stats ? ` ${stats}` : "";
      const nameWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
      const name = truncateToWidth(row.label, nameWidth, "…", true);
      const rendered = fit(`${prefix}${this.config.theme.fg(tone, name)}${suffix}`, width);
      lines.push(
        row.fileIndex === this.selectedFileIndex
          ? this.config.theme.bg("selectedBg", rendered)
          : rendered,
      );
    }

    if (indexes.length === 0) lines.push(this.config.theme.fg("warning", "No matching files"));
    return lines;
  }

  private renderHelpContent(width: number, height: number): string[] {
    const help = [
      "j/k or ↑/↓       next / previous file",
      "n / p            next / previous file",
      "Ctrl+D/U          diff down / up",
      "PageUp/PageDown   diff page",
      "g / G             first / last diff row",
      "t or /            filter files",
      "s or v            unified / side-by-side",
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
    if (this.helpMode) return this.renderHelpContent(width, height);
    const file = this.activeFile();
    if (!file) return [this.config.theme.fg("warning", "No file selected")];

    const bodyHeight = Math.max(1, height - 3);
    const contentWidth = Math.max(1, width - 1);
    const rows = this.renderedRows(this.selectedFileIndex, contentWidth, this.viewMode);
    this.scheduleAdjacentPrewarm(contentWidth);
    this.diffPageSize = bodyHeight;
    this.diffRowCount = rows.length;
    const maximum = Math.max(0, rows.length - bodyHeight);
    this.diffScroll = Math.max(0, Math.min(maximum, this.diffScroll));
    const firstRow = rows.length === 0 ? 0 : this.diffScroll + 1;
    const lastRow = Math.min(rows.length, this.diffScroll + bodyHeight);

    return [
      this.config.theme.bold(`${statusLabel(file.status)} ${file.path}`),
      `${this.config.theme.fg("success", `+${file.additions}`)} ${this.config.theme.fg(
        "error",
        `-${file.deletions}`,
      )} • ${this.viewMode} • rows ${firstRow}-${lastRow}/${rows.length}`,
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
      )} ${theme.fg("error", `-${this.config.diff.deletions}`)}`,
      width,
    );
    const separator = theme.fg("border", "─".repeat(width));
    const diffPanel = renderPanel(
      this.helpMode ? "Help" : `Diff (${this.activeFile()?.hunks.length ?? 0} hunks)`,
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

    const footerText = this.searchMode
      ? "Type to filter • Enter apply • Esc clear"
      : "j/k files • Ctrl+D/U scroll • s view • e files • t filter • ? help • q close";
    return [header, separator, ...body, fit(theme.fg("dim", footerText), width)];
  }
}

export function createDiffViewerComponent(config: DiffViewerConfig): DiffViewer {
  return new DiffViewer(config);
}

export async function openDiffViewer(
  diff: SessionDiff,
  ctx: Pick<ExtensionCommandContext, "ui">,
): Promise<void> {
  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => createDiffViewerComponent({ tui, theme, diff, done }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "100%",
        maxHeight: "100%",
        minWidth: 40,
        margin: 1,
      },
    },
  );
}
