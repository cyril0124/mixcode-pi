import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";

export interface EditPair {
  oldText: string;
  newText: string;
}

interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface SessionMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}

export interface SessionEntry {
  type: string;
  message?: SessionMessage;
}

type Mod = { kind: "write"; content: string } | { kind: "edit"; patch: string; edits: EditPair[] };

interface FileMods {
  path: string;
  mods: Mod[];
}

export interface ReversePatchHunk {
  newStart: number;
  lines: string[];
}

export type DiffRowKind = "equal" | "insert" | "delete" | "replace";

export interface DiffRow {
  kind: DiffRowKind;
  oldLineNumber?: number;
  newLineNumber?: number;
  oldText: string;
  newText: string;
  oldNoNewline?: boolean;
  newNoNewline?: boolean;
}

export interface DiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  rows: DiffRow[];
}

export interface DiffFile {
  path: string;
  status: "added" | "deleted" | "modified";
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface SessionDiff {
  files: DiffFile[];
  additions: number;
  deletions: number;
  trackedFiles: number;
}

interface FileState {
  initial: string | null;
  final: string | null;
}

interface RawDiffLine {
  kind: "equal" | "insert" | "delete";
  text: string;
  oldLineNumber?: number;
  newLineNumber?: number;
  noNewline?: boolean;
}

interface PendingHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  oldLineNumber: number;
  newLineNumber: number;
  lines: RawDiffLine[];
}

export function parseHunks(patch: string): ReversePatchHunk[] {
  const hunks: ReversePatchHunk[] = [];
  let current: ReversePatchHunk | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      current = { newStart: Number(header[1]), lines: [] };
      hunks.push(current);
    } else if (current && (line[0] === " " || line[0] === "-" || line[0] === "+")) {
      current.lines.push(line);
    }
  }
  return hunks;
}

function hunkSides(hunk: ReversePatchHunk): { newSide: string[]; oldSide: string[] } {
  const newSide: string[] = [];
  const oldSide: string[] = [];
  for (const line of hunk.lines) {
    const text = line.slice(1);
    if (line[0] === " ") {
      newSide.push(text);
      oldSide.push(text);
    } else if (line[0] === "+") {
      newSide.push(text);
    } else if (line[0] === "-") {
      oldSide.push(text);
    }
  }
  return { newSide, oldSide };
}

export function reversePatch(newContent: string, hunks: ReversePatchHunk[]): string {
  let lines = newContent.split("\n");
  for (let hunkIndex = hunks.length - 1; hunkIndex >= 0; hunkIndex--) {
    const hunk = hunks[hunkIndex]!;
    const { newSide, oldSide } = hunkSides(hunk);
    if (newSide.length === 0) {
      if (oldSide.length > 0) {
        lines = [...lines.slice(0, hunk.newStart), ...oldSide, ...lines.slice(hunk.newStart)];
      }
      continue;
    }

    let matchIndex = -1;
    for (let lineIndex = 0; lineIndex + newSide.length <= lines.length; lineIndex++) {
      if (newSide.every((line, offset) => lines[lineIndex + offset] === line)) {
        matchIndex = lineIndex;
        break;
      }
    }
    if (matchIndex === -1) continue;
    lines = [
      ...lines.slice(0, matchIndex),
      ...oldSide,
      ...lines.slice(matchIndex + newSide.length),
    ];
  }
  return lines.join("\n");
}

function collectFileMods(entries: SessionEntry[], cwd: string): Map<string, FileMods> {
  const resultById = new Map<string, SessionMessage>();
  for (const entry of entries) {
    const message = entry.message;
    if (entry.type === "message" && message?.role === "toolResult" && message.toolCallId) {
      resultById.set(message.toolCallId, message);
    }
  }

  const files = new Map<string, FileMods>();
  const normalizedPath = (filePath: string): string => {
    const absolute = resolve(cwd, filePath);
    const local = relative(cwd, absolute);
    return local.startsWith("..") ? absolute : local;
  };
  const ensureFile = (path: string): FileMods => {
    let file = files.get(path);
    if (!file) {
      file = { path, mods: [] };
      files.set(path, file);
    }
    return file;
  };

  for (const entry of entries) {
    const message = entry.message;
    if (
      entry.type !== "message" ||
      message?.role !== "assistant" ||
      !Array.isArray(message.content)
    ) {
      continue;
    }

    for (const block of message.content) {
      const candidate = block as Record<string, unknown>;
      if (candidate.type !== "toolCall") continue;
      const call = candidate as unknown as ToolCallBlock;
      if (call.name !== "write" && call.name !== "edit") continue;
      if (call.id && resultById.get(call.id)?.isError) continue;

      const filePath = call.arguments?.path as string | undefined;
      if (!filePath) continue;
      const file = ensureFile(normalizedPath(filePath));

      if (call.name === "write") {
        const content = call.arguments?.content as string | undefined;
        if (content !== undefined) file.mods.push({ kind: "write", content });
        continue;
      }

      const edits = call.arguments?.edits as EditPair[] | undefined;
      const details = call.id
        ? (resultById.get(call.id)?.details as { patch?: string } | undefined)
        : undefined;
      if (!details?.patch && !edits) continue;
      file.mods.push({ kind: "edit", patch: details?.patch ?? "", edits: edits ?? [] });
    }
  }

  return files;
}

function readCurrentFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function reconstructFile(file: FileMods, cwd: string): FileState {
  const diskContent = readCurrentFile(resolve(cwd, file.path));
  const lastMod = file.mods[file.mods.length - 1];
  const final = lastMod?.kind === "write" ? lastMod.content : diskContent;
  const firstMod = file.mods[0];

  if (firstMod?.kind === "write") return { initial: null, final };
  if (final === null) return { initial: null, final };

  let initial = final;
  for (let index = file.mods.length - 1; index >= 0; index--) {
    const mod = file.mods[index]!;
    if (mod.kind === "write") {
      initial = mod.content;
      break;
    }
    if (mod.patch) initial = reversePatch(initial, parseHunks(mod.patch));
  }
  return { initial, final };
}

function alignHunkLines(lines: RawDiffLine[]): DiffRow[] {
  const rows: DiffRow[] = [];
  let deletions: RawDiffLine[] = [];
  let insertions: RawDiffLine[] = [];

  const flushChanges = () => {
    const count = Math.max(deletions.length, insertions.length);
    for (let index = 0; index < count; index++) {
      const deleted = deletions[index];
      const inserted = insertions[index];
      if (deleted && inserted) {
        rows.push({
          kind: "replace",
          oldLineNumber: deleted.oldLineNumber,
          newLineNumber: inserted.newLineNumber,
          oldText: deleted.text,
          newText: inserted.text,
          oldNoNewline: deleted.noNewline,
          newNoNewline: inserted.noNewline,
        });
      } else if (deleted) {
        rows.push({
          kind: "delete",
          oldLineNumber: deleted.oldLineNumber,
          oldText: deleted.text,
          newText: "",
          oldNoNewline: deleted.noNewline,
        });
      } else if (inserted) {
        rows.push({
          kind: "insert",
          newLineNumber: inserted.newLineNumber,
          oldText: "",
          newText: inserted.text,
          newNoNewline: inserted.noNewline,
        });
      }
    }
    deletions = [];
    insertions = [];
  };

  for (const line of lines) {
    if (line.kind === "delete") {
      deletions.push(line);
    } else if (line.kind === "insert") {
      insertions.push(line);
    } else {
      flushChanges();
      rows.push({
        kind: "equal",
        oldLineNumber: line.oldLineNumber,
        newLineNumber: line.newLineNumber,
        oldText: line.text,
        newText: line.text,
        oldNoNewline: line.noNewline,
        newNoNewline: line.noNewline,
      });
    }
  }
  flushChanges();
  return rows;
}

export function parseUnifiedPatch(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: PendingHunk | null = null;

  const finishHunk = () => {
    if (!current) return;
    hunks.push({
      header: current.header,
      oldStart: current.oldStart,
      oldCount: current.oldCount,
      newStart: current.newStart,
      newCount: current.newCount,
      rows: alignHunkLines(current.lines),
    });
    current = null;
  };

  for (const line of patch.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      finishHunk();
      const oldStart = Number(header[1]);
      const newStart = Number(header[3]);
      current = {
        header: line,
        oldStart,
        oldCount: header[2] === undefined ? 1 : Number(header[2]),
        newStart,
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        oldLineNumber: oldStart,
        newLineNumber: newStart,
        lines: [],
      };
      continue;
    }
    if (!current) continue;

    if (line === "\\ No newline at end of file") {
      const previous = current.lines[current.lines.length - 1];
      if (previous) previous.noNewline = true;
      continue;
    }

    const text = line.slice(1).replace(/\r$/, "").replace(/\t/g, "    ");
    if (line[0] === " ") {
      current.lines.push({
        kind: "equal",
        text,
        oldLineNumber: current.oldLineNumber++,
        newLineNumber: current.newLineNumber++,
      });
    } else if (line[0] === "-") {
      current.lines.push({
        kind: "delete",
        text,
        oldLineNumber: current.oldLineNumber++,
      });
    } else if (line[0] === "+") {
      current.lines.push({
        kind: "insert",
        text,
        newLineNumber: current.newLineNumber++,
      });
    }
  }
  finishHunk();
  return hunks;
}

export function buildSessionDiff(entries: SessionEntry[], cwd: string): SessionDiff {
  const tracked = collectFileMods(entries, cwd);
  const files: DiffFile[] = [];

  for (const file of tracked.values()) {
    const { initial, final } = reconstructFile(file, cwd);
    if ((initial === null && final === null) || initial === final) continue;

    const oldContent = initial ?? "";
    const newContent = final ?? "";
    const hunks = parseUnifiedPatch(generateUnifiedPatch(file.path, oldContent, newContent, 3));
    const additions = hunks.reduce(
      (count, hunk) =>
        count + hunk.rows.filter((row) => row.kind === "insert" || row.kind === "replace").length,
      0,
    );
    const deletions = hunks.reduce(
      (count, hunk) =>
        count + hunk.rows.filter((row) => row.kind === "delete" || row.kind === "replace").length,
      0,
    );

    files.push({
      path: file.path,
      status: initial === null ? "added" : final === null ? "deleted" : "modified",
      additions,
      deletions,
      hunks,
    });
  }

  return {
    files,
    additions: files.reduce((count, file) => count + file.additions, 0),
    deletions: files.reduce((count, file) => count + file.deletions, 0),
    trackedFiles: tracked.size,
  };
}
