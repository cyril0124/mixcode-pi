import { readFileSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { resolve, relative, join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync, unlinkSync } from "node:fs";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// ╔══════════════════════════════════════════════════════════════════╗
// ║          diff-tracker: Session Change Tracker                    ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                  ║
// ║  Shows file changes made during the current session via /diff.   ║
// ║                                                                  ║
// ║  Strategy: reconstruct each file's initial+final content purely  ║
// ║  from RECORDED session data (edit tool's details.patch and write ║
// ║  tool's content), never by guessing against shared disk:         ║
// ║                                                                  ║
// ║    final   = last recorded write content, else current disk      ║
// ║    initial = reverse this session's recorded patches/writes from  ║
// ║              `final`, locating each hunk by content (re-edits and  ║
// ║              superseded hunks are handled, not double-applied)     ║
// ║                                                                  ║
// ║  This isolates one session's changes from other sessions that    ║
// ║  touched the same file, and avoids the fragile indexOf-based      ║
// ║  reversal that mis-handled duplicate/empty/CRLF/BOM text.         ║
// ║                                                                  ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── Session history types ───────────────────────────────────────────────────

interface EditPair {
  oldText: string;
  newText: string;
}
interface ToolCallBlock {
  type: "toolCall";
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}
interface SessionMessage {
  role: string;
  content: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  details?: unknown;
}
interface SessionEntry {
  type: string;
  message?: SessionMessage;
}

// A single recorded modification to a file, in chronological order.
type Mod =
  | { kind: "write"; content: string }
  | { kind: "edit"; patch: string; edits: EditPair[] };

// ─── Unified-patch line-position engine (self-contained, no deps) ─────────────
//
// The edit tool records `details.patch` as a standard unified diff. We apply it
// by LINE POSITION (hunk @@ headers), which is exact — unlike indexOf, it never
// matches the wrong occurrence, mishandles empty replacements, or trips on
// CRLF/BOM differences in unrelated regions.
//
// IMPORTANT: edit patches are NOT a sequential chain. When the agent re-edits
// the same region, multiple patches share the SAME original base coordinates,
// so reversing by raw line number double-applies and corrupts unrelated
// regions. We therefore reverse by LOCATING each hunk's new-side block in the
// content (search, not fixed offset). A hunk whose new-side is absent was
// superseded by a later edit and is safely skipped.

interface Hunk {
  lines: string[];
}

/** Parse hunks from a unified patch, ignoring file-header lines. */
function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.split("\n")) {
    if (/^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/.test(line)) {
      cur = { lines: [] };
      hunks.push(cur);
    } else if (cur && (line[0] === " " || line[0] === "-" || line[0] === "+")) {
      cur.lines.push(line);
    }
  }
  return hunks;
}

/** Split a hunk into its new-side (context+added) and old-side (context+removed) line blocks. */
function hunkSides(hunk: Hunk): { newSide: string[]; oldSide: string[] } {
  const newSide: string[] = [];
  const oldSide: string[] = [];
  for (const l of hunk.lines) {
    const tag = l[0];
    const text = l.slice(1);
    if (tag === " ") {
      newSide.push(text);
      oldSide.push(text);
    } else if (tag === "+") {
      newSide.push(text);
    } else if (tag === "-") {
      oldSide.push(text);
    }
  }
  return { newSide, oldSide };
}

/**
 * Reverse-apply a patch: reconstruct OLD content from NEW content by LOCATING
 * each hunk's new-side block (not by fixed line number). Hunks are processed
 * bottom-to-top so earlier matches stay valid. A hunk whose new-side block is
 * not found was superseded by a later edit and is skipped.
 */
function reversePatch(newContent: string, hunks: Hunk[]): string {
  let lines = newContent.split("\n");
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const { newSide, oldSide } = hunkSides(hunks[hi]);
    if (newSide.length === 0) continue;
    // Locate the contiguous new-side block.
    let found = -1;
    for (let i = 0; i + newSide.length <= lines.length; i++) {
      let ok = true;
      for (let j = 0; j < newSide.length; j++) {
        if (lines[i + j] !== newSide[j]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        found = i;
        break;
      }
    }
    if (found === -1) continue; // superseded by a later edit
    lines = [...lines.slice(0, found), ...oldSide, ...lines.slice(found + newSide.length)];
  }
  return lines.join("\n");
}

// ─── Collect per-file modifications from session history ──────────────────────

interface FileMods {
  relPath: string;
  mods: Mod[];
}

/**
 * Walk session entries in order, pairing each assistant toolCall with its
 * toolResult (by toolCallId), and collect successful write/edit modifications
 * per file. Only successful (isError=false) tool results count.
 */
function collectFileMods(entries: SessionEntry[], cwd: string): Map<string, FileMods> {
  // Index toolResults by toolCallId for pairing.
  const resultById = new Map<string, SessionMessage>();
  for (const entry of entries) {
    const msg = entry.message;
    if (entry.type === "message" && msg?.role === "toolResult" && msg.toolCallId) {
      resultById.set(msg.toolCallId, msg);
    }
  }

  const files = new Map<string, FileMods>();
  const keyFor = (filePath: string): string => {
    const abs = resolve(cwd, filePath);
    const rel = relative(cwd, abs);
    return rel.startsWith("..") ? abs : rel;
  };
  const ensure = (relPath: string): FileMods => {
    let fm = files.get(relPath);
    if (!fm) {
      fm = { relPath, mods: [] };
      files.set(relPath, fm);
    }
    return fm;
  };

  for (const entry of entries) {
    const msg = entry.message;
    if (entry.type !== "message" || msg?.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "toolCall") continue;
      const tc = b as unknown as ToolCallBlock;
      if (tc.name !== "write" && tc.name !== "edit") continue;

      // Require a successful matching result when we can pair by id.
      if (tc.id) {
        const res = resultById.get(tc.id);
        if (res?.isError) continue;
      }

      const filePath = tc.arguments?.path as string | undefined;
      if (!filePath) continue;
      const relPath = keyFor(filePath);

      if (tc.name === "write") {
        const content = tc.arguments?.content as string | undefined;
        if (content === undefined) continue;
        ensure(relPath).mods.push({ kind: "write", content });
      } else {
        const edits = tc.arguments?.edits as EditPair[] | undefined;
        const patch = tc.id ? (resultById.get(tc.id)?.details as { patch?: string } | undefined)?.patch : undefined;
        if (!patch && !edits) continue;
        ensure(relPath).mods.push({ kind: "edit", patch: patch ?? "", edits: edits ?? [] });
      }
    }
  }

  return files;
}

function safeReadFile(absPath: string): string | null {
  try {
    return readFileSync(absPath, "utf-8");
  } catch {
    return null;
  }
}

// ─── Reconstruct initial & final content for a file ───────────────────────────

interface FileState {
  initial: string | null;
  final: string | null;
}

/**
 * Reconstruct a file's session-initial and session-final content using only
 * recorded mods (plus current disk as the best "final" when the last mod is an
 * edit, since edits don't record full content).
 */
function reconstructFile(fm: FileMods, cwd: string): FileState {
  const absPath = resolve(cwd, fm.relPath);
  const disk = safeReadFile(absPath);
  const mods = fm.mods;
  const lastMod = mods[mods.length - 1];

  // FINAL: a trailing write gives exact content; otherwise use disk (edit's
  // applied result lives on disk and we will reverse only this session's edits).
  const final: string | null = lastMod?.kind === "write" ? lastMod.content : disk;

  // If the very first mod is a write, the file was (re)created from scratch by
  // this session; treat the pre-session baseline as empty/new.
  const firstMod = mods[0];
  if (firstMod?.kind === "write") {
    return { initial: null, final };
  }

  // First mod is an edit: reverse-chain this session's mods from `final` to
  // recover the pre-session content. Reverse in chronological-reverse order.
  if (final === null) return { initial: null, final };
  let content = final;
  for (let i = mods.length - 1; i >= 0; i--) {
    const mod = mods[i];
    if (mod.kind === "write") {
      // A write fully replaced content; we cannot see what preceded it here,
      // so stop reversing — the pre-write content is unknown. Best effort:
      // treat everything before the write as the baseline boundary.
      content = mod.content;
      // Reversing past a write is undefined; break to avoid corrupting baseline.
      break;
    } else if (mod.patch) {
      content = reversePatch(content, parseHunks(mod.patch));
    }
  }
  return { initial: content, final };
}

// ─── Unified diff output (git-style, diffnav-compatible) ──────────────────────

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Strip a leading slash so absolute paths don't yield `a//abs` labels. */
function labelPath(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

function gitHeader(path: string): string {
  const lp = labelPath(path);
  return `diff --git a/${lp} b/${lp}`;
}

function newFileDiff(path: string, content: string): string {
  const lp = labelPath(path);
  const lines = splitLines(content);
  if (lines.length === 0) {
    return [gitHeader(path), "new file mode 100644", `--- /dev/null`, `+++ b/${lp}`].join("\n");
  }
  return [
    gitHeader(path),
    "new file mode 100644",
    `--- /dev/null`,
    `+++ b/${lp}`,
    `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`),
  ].join("\n");
}

function deletedFileDiff(path: string, content: string): string {
  const lp = labelPath(path);
  const lines = splitLines(content);
  if (lines.length === 0) {
    return [gitHeader(path), "deleted file mode 100644", `--- a/${lp}`, `+++ /dev/null`].join("\n");
  }
  return [
    gitHeader(path),
    "deleted file mode 100644",
    `--- a/${lp}`,
    `+++ /dev/null`,
    `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`),
  ].join("\n");
}

/** Compute a git-style unified diff between two strings via the system `diff`. */
function modifiedFileDiff(path: string, oldContent: string, newContent: string): string {
  const lp = labelPath(path);
  const oldFile = join(tmpdir(), `mixcode-diff-old-${process.pid}-${Date.now()}`);
  const newFile = join(tmpdir(), `mixcode-diff-new-${process.pid}-${Date.now()}`);
  try {
    writeFileSync(oldFile, oldContent);
    writeFileSync(newFile, newContent);
    const result = spawnSync("diff", ["-u", "--label", `a/${lp}`, "--label", `b/${lp}`, oldFile, newFile], {
      encoding: "utf-8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const body = result.stdout || "";
    if (!body) return "";
    // Prepend the git extended header so diffnav's go-gitdiff parser is happy.
    return `${gitHeader(path)}\n${body.replace(/\n$/, "")}`;
  } finally {
    try {
      unlinkSync(oldFile);
    } catch {
      /* best effort */
    }
    try {
      unlinkSync(newFile);
    } catch {
      /* best effort */
    }
  }
}

/** Build the full diff document for all modified files. */
function buildDiff(files: Map<string, FileMods>, cwd: string): string {
  const blocks: string[] = [];
  for (const [, fm] of files) {
    const { initial, final } = reconstructFile(fm, cwd);
    if (initial === null && final === null) continue;
    if (initial === final) continue;

    if (initial === null && final !== null) {
      blocks.push(newFileDiff(fm.relPath, final));
    } else if (initial !== null && final === null) {
      blocks.push(deletedFileDiff(fm.relPath, initial));
    } else {
      const d = modifiedFileDiff(fm.relPath, initial as string, final as string);
      if (d) blocks.push(d);
    }
  }
  return blocks.join("\n");
}

// ─── Turn slicing ─────────────────────────────────────────────────────────────

/** Indices of user messages within the branch. */
function userMessageIndices(entries: SessionEntry[]): number[] {
  const idx: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "message" && entries[i].message?.role === "user") idx.push(i);
  }
  return idx;
}

/** Entries for the Nth-last user turn (1 = last). Empty if out of range. */
function getNthLastTurnEntries(entries: SessionEntry[], n: number): SessionEntry[] {
  const u = userMessageIndices(entries);
  if (n < 1 || n > u.length) return [];
  const startIdx = u[u.length - n];
  const endIdx = n > 1 ? u[u.length - n + 1] : entries.length;
  return entries.slice(startIdx, endIdx);
}

/** Entries spanning the Nth-last through Mth-last user turns (inclusive). */
function getRangeTurnEntries(entries: SessionEntry[], a: number, b: number): SessionEntry[] {
  const u = userMessageIndices(entries);
  const far = Math.max(a, b);
  const near = Math.min(a, b);
  if (near < 1 || far < 1 || far > u.length) return [];
  const startIdx = u[u.length - far];
  const endIdx = near > 1 ? u[u.length - near + 1] : entries.length;
  return entries.slice(startIdx, endIdx);
}

// ─── Diff viewer detection ────────────────────────────────────────────────────

let _hasDiffnav: boolean | undefined;
function hasDiffnav(): boolean {
  if (_hasDiffnav === undefined) {
    _hasDiffnav = spawnSync("which", ["diffnav"], { stdio: "ignore" }).status === 0;
  }
  return _hasDiffnav;
}

// ─── Extension Entry Point ────────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  pi.registerCommand("diff", {
    description: "Show file changes made during this session (via diffnav)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "last", label: "last", description: "Last turn (= /diff 1)" },
        { value: "1", label: "1", description: "Last turn" },
        { value: "2", label: "2", description: "2nd-to-last turn" },
        { value: "3", label: "3", description: "3rd-to-last turn" },
      ];
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
      const trimmed = (args ?? "").trim();

      // Parse: /diff | /diff last | /diff N | /diff N-M
      let scope: SessionEntry[];
      if (!trimmed) {
        scope = entries;
      } else if (trimmed === "last") {
        scope = getNthLastTurnEntries(entries, 1);
      } else if (/^\d+$/.test(trimmed)) {
        scope = getNthLastTurnEntries(entries, Number(trimmed));
      } else if (/^\d+-\d+$/.test(trimmed)) {
        const [a, b] = trimmed.split("-").map(Number);
        scope = getRangeTurnEntries(entries, a, b);
      } else {
        ctx.ui.notify("Usage: /diff, /diff last, /diff N, /diff N-M", "info");
        return;
      }

      if (scope.length === 0) {
        ctx.ui.notify("No entries found for the specified range.", "info");
        return;
      }

      const files = collectFileMods(scope, cwd);
      if (files.size === 0) {
        ctx.ui.notify("No file modifications found in this session.", "info");
        return;
      }

      const diffContent = buildDiff(files, cwd);
      if (!diffContent) {
        ctx.ui.notify("Files were modified but have no effective changes.", "info");
        return;
      }

      // Open viewer: pause TUI, spawn diffnav (or $EDITOR/less), resume on exit.
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        const t = tui as unknown as { stop: () => void; start: () => void; requestRender: (f?: boolean) => void };
        t.stop();

        const tmpFile = join(tmpdir(), `mixcode-diff-${process.pid}-${Date.now()}.diff`);
        writeFileSync(tmpFile, `${diffContent}\n`, "utf-8");

        const cleanup = () => {
          try {
            unlinkSync(tmpFile);
          } catch {
            /* best effort */
          }
        };

        let child: ReturnType<typeof spawn>;
        if (hasDiffnav()) {
          // diffnav reads the diff on stdin but needs /dev/tty for keys;
          // shell redirection gives it both. `;` ensures rm runs regardless.
          child = spawn("sh", ["-c", `diffnav < "${tmpFile}"; rm -f "${tmpFile}"`], { stdio: "inherit" });
        } else {
          const viewer = process.env.EDITOR || process.env.VISUAL || "less";
          child = spawn(viewer, [tmpFile], { stdio: "inherit" });
        }

        // Idempotent resume: Node may emit both error and exit; guard so the
        // TUI is only restarted once (a double start leaks a resize listener).
        let resumed = false;
        const resume = () => {
          if (resumed) return;
          resumed = true;
          cleanup();
          t.start();
          t.requestRender(true);
          done();
        };
        child.on("exit", resume);
        child.on("error", resume);

        return { render: () => [], invalidate: () => {}, handleInput: () => {} };
      });
    },
  });
};

export default extension;
