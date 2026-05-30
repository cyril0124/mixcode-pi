import { readFileSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { spawnSync, spawn } from "node:child_process";
import { resolve, relative, join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

// ╔══════════════════════════════════════════════════════════════════╗
// ║          diff-tracker: Session Change Tracker                    ║
// ╠══════════════════════════════════════════════════════════════════╣
// ║                                                                  ║
// ║  Shows file changes made during the current session via /diff.   ║
// ║                                                                  ║
// ║  Strategy: scan session history for edit/write tool calls,       ║
// ║  reconstruct each file's baseline (pre-modification content)     ║
// ║  from tool arguments, then diff against current disk content.    ║
// ║                                                                  ║
// ║  No dependency on git. No dependency on real-time events.        ║
// ║  Works regardless of when the extension was loaded.              ║
// ║                                                                  ║
// ╚══════════════════════════════════════════════════════════════════╝

// ─── Diff viewer detection ───────────────────────────────────────────────────
let _hasDiffnav: boolean | undefined;
function hasDiffnav(): boolean {
  if (_hasDiffnav === undefined) _hasDiffnav = spawnSync("which", ["diffnav"], { stdio: "ignore" }).status === 0;
  return _hasDiffnav;
}

// ─── Session history types ───────────────────────────────────────────────────

interface EditPair { oldText: string; newText: string }
interface ToolCallBlock {
  type: "toolCall";
  name: string;
  arguments: Record<string, unknown>;
}
interface SessionMessage {
  role: string;
  content: unknown;
}
interface SessionEntry {
  type: string;
  message?: SessionMessage;
}

// ─── Baseline reconstruction from session history ────────────────────────────
//
// For each file modified in the session, reconstruct its content BEFORE
// the first modification:
//
//   write tool: baseline = null (new file) or current content with
//               all writes reversed (complex). Simplification: if the
//               first tool call for a file is "write", baseline = null
//               (assume new file) unless the file existed before.
//
//   edit tool:  baseline can be reconstructed by reverse-applying edits
//               from the first edit call's oldText fragments.
//
// Practical approach: for each file, apply all tool calls in order to
// reconstruct the final state, and use the FIRST state as baseline.
// Then diff baseline vs current disk content.

interface FileHistory {
  /** Content before first modification (null = file didn't exist). */
  baseline: string | null;
  /** Path relative to cwd (or absolute if outside cwd). */
  relPath: string;
}

/**
 * Extract file modification history from session entries.
 * Returns a map of relPath -> FileHistory with reconstructed baselines.
 */
function extractFileHistory(entries: SessionEntry[], cwd: string): Map<string, FileHistory> {
  const history = new Map<string, FileHistory>();

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "toolCall") continue;
      const tc = b as unknown as ToolCallBlock;

      if (tc.name === "write") {
        const filePath = tc.arguments?.path as string | undefined;
        if (!filePath) continue;
        const absPath = resolve(cwd, filePath);
        const rel = relative(cwd, absPath);
        const relPath = rel.startsWith("..") ? absPath : rel;

        if (!history.has(relPath)) {
          // First write to this file: baseline is whatever was on disk before
          // Since we can't read the past, we mark baseline as null (new file).
          // This is correct for newly created files. For existing files that
          // were overwritten, we lose the original content — acceptable tradeoff.
          history.set(relPath, { baseline: null, relPath });
        }
      } else if (tc.name === "edit") {
        const filePath = tc.arguments?.path as string | undefined;
        const edits = tc.arguments?.edits as EditPair[] | undefined;
        if (!filePath || !edits) continue;
        const absPath = resolve(cwd, filePath);
        const rel = relative(cwd, absPath);
        const relPath = rel.startsWith("..") ? absPath : rel;

        if (!history.has(relPath)) {
          // First edit to this file: reconstruct baseline by reading current
          // file and reverse-applying all edits from this session.
          const currentContent = safeReadFile(absPath);
          if (currentContent !== null) {
            const baseline = reverseEditsForFile(currentContent, entries, relPath, cwd);
            history.set(relPath, { baseline, relPath });
          } else {
            history.set(relPath, { baseline: null, relPath });
          }
        }
      }
    }
  }

  return history;
}

/** Reverse-apply all edit tool calls for a file to reconstruct its baseline. */
function reverseEditsForFile(
  currentContent: string, entries: SessionEntry[], relPath: string, cwd: string,
): string {
  // Collect all edits for this file in order
  const allEdits: EditPair[][] = [];

  for (const entry of entries) {
    if (entry.type !== "message" || !entry.message) continue;
    const msg = entry.message;
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      const b = block as Record<string, unknown>;
      if (b.type !== "toolCall") continue;
      const tc = b as unknown as ToolCallBlock;
      if (tc.name !== "edit") continue;

      const filePath = tc.arguments?.path as string | undefined;
      const edits = tc.arguments?.edits as EditPair[] | undefined;
      if (!filePath || !edits) continue;

      const absPath = resolve(cwd, filePath);
      const rel = relative(cwd, absPath);
      const thisRelPath = rel.startsWith("..") ? absPath : rel;
      if (thisRelPath !== relPath) continue;

      allEdits.push(edits);
    }
  }

  // Reverse-apply edits from last to first to get baseline
  let content = currentContent;
  for (let i = allEdits.length - 1; i >= 0; i--) {
    const edits = allEdits[i];
    // Reverse each edit pair: replace newText with oldText
    for (let j = edits.length - 1; j >= 0; j--) {
      const { oldText, newText } = edits[j];
      const idx = content.indexOf(newText);
      if (idx !== -1) {
        content = content.slice(0, idx) + oldText + content.slice(idx + newText.length);
      }
    }
  }

  return content;
}

function safeReadFile(absPath: string): string | null {
  try { return readFileSync(absPath, "utf-8"); } catch { return null; }
}

// ─── Unified diff generation ─────────────────────────────────────────────────

function generateUnifiedDiff(fileHistories: Map<string, FileHistory>, cwd: string): string {
  const diffs: string[] = [];

  for (const [, fh] of fileHistories) {
    const absPath = resolve(cwd, fh.relPath);
    const current = safeReadFile(absPath);

    if (fh.baseline === null && current === null) continue;
    if (fh.baseline === current) continue;

    if (fh.baseline === null && current !== null) {
      diffs.push(newFileDiff(fh.relPath, current));
    } else if (fh.baseline !== null && current === null) {
      diffs.push(deletedFileDiff(fh.relPath, fh.baseline));
    } else {
      const d = computeUnifiedDiff(fh.relPath, fh.baseline!, current!);
      if (d) diffs.push(d);
    }
  }

  return diffs.join("\n");
}

function newFileDiff(path: string, content: string): string {
  const lines = splitLines(content);
  return [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`,
    ...lines.map((l) => `+${l}`)].join("\n");
}

function deletedFileDiff(path: string, content: string): string {
  const lines = splitLines(content);
  return [`--- a/${path}`, `+++ /dev/null`, `@@ -1,${lines.length} +0,0 @@`,
    ...lines.map((l) => `-${l}`)].join("\n");
}

function splitLines(text: string): string[] {
  const lines = text.split("\n");
  if (text.endsWith("\n") && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Compute unified diff between two strings using the external diff command. */
function computeUnifiedDiff(path: string, oldContent: string, newContent: string): string {
  // Use system diff command for reliable output
  const oldFile = join(tmpdir(), `mixcode-diff-old-${Date.now()}`);
  const newFile = join(tmpdir(), `mixcode-diff-new-${Date.now()}`);
  try {
    writeFileSync(oldFile, oldContent);
    writeFileSync(newFile, newContent);
    const result = spawnSync("diff", ["-u", "--label", `a/${path}`, "--label", `b/${path}`, oldFile, newFile], {
      encoding: "utf-8", maxBuffer: 10 * 1024 * 1024,
    });
    // diff exits 1 when files differ (not an error)
    return result.stdout || "";
  } finally {
    try { unlinkSync(oldFile); } catch {}
    try { unlinkSync(newFile); } catch {}
  }
}

// ─── Turn splitting ──────────────────────────────────────────────────────────

/** Get entries from the Nth-last user message onward (1 = last). */
function getNthLastTurnEntries(entries: SessionEntry[], n: number): SessionEntry[] {
  const userIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "message" && entries[i].message?.role === "user") {
      userIndices.push(i);
    }
  }
  if (n < 1 || n > userIndices.length) return [];
  const startIdx = userIndices[userIndices.length - n];
  // End at the next user message (or end of entries)
  const endIdx = n > 1 ? userIndices[userIndices.length - n + 1] : entries.length;
  return entries.slice(startIdx, endIdx);
}

/** Get entries spanning from Nth-last to Mth-last user messages (inclusive). */
function getRangeTurnEntries(entries: SessionEntry[], from: number, to: number): SessionEntry[] {
  const userIndices: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].type === "message" && entries[i].message?.role === "user") {
      userIndices.push(i);
    }
  }
  // from=larger number (further back), to=smaller number (more recent)
  const [far, near] = from > to ? [from, to] : [to, from];
  if (far < 1 || far > userIndices.length) return [];
  const startIdx = userIndices[userIndices.length - far];
  const endIdx = near > 1 ? userIndices[userIndices.length - near + 1] : entries.length;
  return entries.slice(startIdx, endIdx);
}

// ─── Extension Entry Point ──────────────────────────────────────────────────

const extension: ExtensionFactory = (pi) => {
  pi.registerCommand("diff", {
    description: "Show file changes made during this session (via diffnav)",
    getArgumentCompletions: (prefix: string) => {
      const items = [
        { value: "last", label: "last", description: "Show diff from the last turn (= /diff 1)" },
        { value: "1", label: "1", description: "Last turn" },
        { value: "2", label: "2", description: "2nd-to-last turn" },
        { value: "3", label: "3", description: "3rd-to-last turn" },
      ];
      return items.filter((item) => item.value.startsWith(prefix));
    },
    handler: async (args, ctx) => {
      const cwd = ctx.cwd;
      const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
      const trimmedArgs = (args ?? "").trim();

      // Parse arguments: /diff, /diff last, /diff N, /diff N-M
      let entriesToScan: SessionEntry[];

      if (!trimmedArgs) {
        entriesToScan = entries;
      } else if (trimmedArgs === "last") {
        entriesToScan = getNthLastTurnEntries(entries, 1);
      } else if (/^\d+$/.test(trimmedArgs)) {
        entriesToScan = getNthLastTurnEntries(entries, parseInt(trimmedArgs, 10));
      } else if (/^\d+-\d+$/.test(trimmedArgs)) {
        const [a, b] = trimmedArgs.split("-").map(Number);
        entriesToScan = getRangeTurnEntries(entries, a, b);
      } else {
        ctx.ui.notify("Usage: /diff, /diff last, /diff N, /diff N-M", "info");
        return;
      }

      if (entriesToScan.length === 0) {
        ctx.ui.notify("No entries found for the specified range.", "info");
        return;
      }

      // Extract file history with reconstructed baselines
      const fileHistories = extractFileHistory(entriesToScan, cwd);
      if (fileHistories.size === 0) {
        ctx.ui.notify("No file modifications found in this session.", "info");
        return;
      }

      // Generate unified diff
      const diffContent = generateUnifiedDiff(fileHistories, cwd);
      if (!diffContent) {
        ctx.ui.notify("Files were modified but have no effective changes.", "info");
        return;
      }

      // Open diff viewer: pause TUI, spawn diffnav or fallback, resume TUI
      await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
        const t = tui as unknown as { stop: () => void; start: () => void; requestRender: (f?: boolean) => void };
        t.stop();

        const tmpFile = join(tmpdir(), `mixcode-diff-${Date.now()}.diff`);
        writeFileSync(tmpFile, diffContent + "\n", "utf-8");

        let child: ReturnType<typeof spawn>;
        if (hasDiffnav()) {
          child = spawn("sh", ["-c", `diffnav < "${tmpFile}"; rm -f "${tmpFile}"`], { stdio: "inherit" });
        } else {
          const viewer = process.env.EDITOR || process.env.VISUAL || "less";
          child = spawn(viewer, [tmpFile], { stdio: "inherit" });
          child.on("exit", () => { try { unlinkSync(tmpFile); } catch {} });
        }

        const resume = () => { t.start(); t.requestRender(true); done(); };
        child.on("exit", resume);
        child.on("error", resume);

        return { render: () => [], invalidate: () => {}, handleInput: () => {} };
      });
    },
  });
};

export default extension;
