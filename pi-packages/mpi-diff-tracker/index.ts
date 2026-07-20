import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
  /** 1-based new-file start from `@@ -old +new @@`; 0 means empty new file. */
  newStart: number;
  lines: string[];
}

/** Parse hunks from a unified patch, ignoring file-header lines. */
export function parseHunks(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      cur = { newStart: Number(header[1]), lines: [] };
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
 *
 * Pure deletions have an empty new-side (only `-` lines). Those cannot be
 * located by content search, so we re-insert oldSide at the hunk's +newStart.
 */
export function reversePatch(newContent: string, hunks: Hunk[]): string {
  let lines = newContent.split("\n");
  for (let hi = hunks.length - 1; hi >= 0; hi--) {
    const hunk = hunks[hi];
    const { newSide, oldSide } = hunkSides(hunk);
    if (newSide.length === 0) {
      // Pure deletion: +N,0 means insert oldSide at index N (0 for empty file).
      if (oldSide.length === 0) continue;
      const at = hunk.newStart;
      lines = [...lines.slice(0, at), ...oldSide, ...lines.slice(at)];
      continue;
    }
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

// ─── Diff viewer + optional diffnav/delta install ─────────────────────────────
// Install both from GitHub releases into ~/.local/bin when PATH has no diffnav.

const GH_UA = { Accept: "application/vnd.github+json", "User-Agent": "mixcode-mpi-diff-tracker" };

let askedInstall = false;
let cachedDiffnav: string | null | undefined;

export function resetDiffnavInstallStateForTests(): void {
  askedInstall = false;
  cachedDiffnav = undefined;
}

export function defaultLocalBinDir(home = homedir()): string {
  return join(home, ".local", "bin");
}
export function defaultDiffnavBinaryPath(home = homedir()): string {
  return join(defaultLocalBinDir(home), "diffnav");
}
export function defaultDeltaBinaryPath(home = homedir()): string {
  return join(defaultLocalBinDir(home), "delta");
}

/** diffnav asset triple: Linux_x86_64 / Darwin_arm64 / … */
export function platformAssetName(platform: NodeJS.Platform = process.platform, arch = process.arch): string | null {
  const os = platform === "darwin" ? "Darwin" : platform === "linux" ? "Linux" : null;
  const cpu = arch === "arm64" ? "arm64" : arch === "x64" ? "x86_64" : null;
  return os && cpu ? `${os}_${cpu}` : null;
}

/** delta rustc target: x86_64-unknown-linux-gnu / … */
export function deltaAssetTarget(platform: NodeJS.Platform = process.platform, arch = process.arch): string | null {
  if (platform === "linux" && arch === "x64") return "x86_64-unknown-linux-gnu";
  if (platform === "linux" && arch === "arm64") return "aarch64-unknown-linux-gnu";
  if (platform === "darwin" && arch === "x64") return "x86_64-apple-darwin";
  if (platform === "darwin" && arch === "arm64") return "aarch64-apple-darwin";
  return null;
}

export function isAllowedAssetUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "github.com") return false;
    const m = /^\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/([^/]+)$/.exec(u.pathname);
    const file = m?.[1] ?? "";
    return file.endsWith(".tar.gz") && !/windows/i.test(file);
  } catch {
    return false;
  }
}

export function formatDownloadProgress(downloaded: number, total: number | null, label = "diffnav"): string {
  const w = 10;
  if (total && total > 0) {
    const f = Math.round(Math.min(1, downloaded / total) * w);
    const mb = (n: number) => (n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / (1024 * 1024)).toFixed(1)}MB`);
    return `${label} [${"█".repeat(f)}${"░".repeat(w - f)}] ${Math.round((downloaded / total) * 100)}% ${mb(downloaded)}/${mb(total)}`;
  }
  const spin = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"[Math.floor(downloaded / 65536) % 10] ?? "⠋";
  return `${label} [${spin}] ${(downloaded / 1024).toFixed(1)}KB`;
}

export type ReleaseAsset = { tag: string; assetName: string; size: number; url: string };

export function pickReleaseAsset(
  release: { tag_name?: string; assets?: Array<{ name?: string; size?: number; browser_download_url?: string }> },
  triple: string,
): ReleaseAsset | null {
  const tag = release.tag_name?.trim();
  if (!tag) return null;
  const ver = tag.replace(/^v/, "");
  const want = new Set([`diffnav_${ver}_${triple}.tar.gz`, `diffnav_${triple}.tar.gz`]);
  const a = (release.assets ?? []).find((x) => x.name && want.has(x.name));
  return a?.browser_download_url && a.name
    ? { tag, assetName: a.name, size: Number(a.size) || 0, url: a.browser_download_url }
    : null;
}

export function pickDeltaReleaseAsset(
  release: { tag_name?: string; assets?: Array<{ name?: string; size?: number; browser_download_url?: string }> },
  target: string,
): ReleaseAsset | null {
  const tag = release.tag_name?.trim();
  if (!tag) return null;
  const name = `delta-${tag.replace(/^v/, "")}-${target}.tar.gz`;
  const a = (release.assets ?? []).find((x) => x.name === name);
  return a?.browser_download_url && a.name
    ? { tag, assetName: a.name, size: Number(a.size) || 0, url: a.browser_download_url }
    : null;
}

function which(name: string): string | null {
  const r = spawnSync("which", [name], { encoding: "utf-8" });
  return r.status === 0 ? (r.stdout ?? "").trim().split("\n")[0]?.trim() || null : null;
}

export function detectDiffnavCommand(opts: { whichPath?: string | null; installedPath?: string; useCache?: boolean } = {}): string | null {
  if (opts.useCache !== false && cachedDiffnav !== undefined) return cachedDiffnav;
  const p = opts.whichPath !== undefined ? opts.whichPath : which("diffnav");
  if (p) return (cachedDiffnav = p);
  const inst = opts.installedPath ?? defaultDiffnavBinaryPath();
  try {
    if (existsSync(inst) && statSync(inst).isFile()) return (cachedDiffnav = inst);
  } catch {
    /* ignore */
  }
  return (cachedDiffnav = null);
}

export function resolveDeltaBinary(diffnavCmd?: string | null): string | null {
  const w = which("delta");
  if (w) return w;
  for (const p of [diffnavCmd ? join(dirname(diffnavCmd), "delta") : "", defaultDeltaBinaryPath()]) {
    if (!p) continue;
    try {
      if (existsSync(p) && statSync(p).isFile()) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

export function viewerPathEnv(diffnavCmd: string, basePath = process.env.PATH ?? ""): string {
  return [dirname(diffnavCmd), defaultLocalBinDir(), basePath].filter(Boolean).join(":");
}

function findInTree(dir: string, name: string): string | null {
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    for (const ent of readdirSync(cur)) {
      const full = join(cur, ent);
      try {
        const st = statSync(full);
        if (st.isDirectory()) stack.push(full);
        else if (st.isFile() && ent === name) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

export function parseDiffnavVersionOutput(raw: string): string {
  const text = raw.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const m = /\bversion\s+(v?\d+(?:\.\d+)*)\b/i.exec(text);
  if (m?.[1]) return m[1].startsWith("v") ? m[1] : `v${m[1]}`;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t && !/[▜▟▐▌▞▚▔▁]/.test(t)) return /^v?\d/.test(t) ? (t.startsWith("v") ? t : `v${t}`) : t.slice(0, 40);
  }
  return "ok";
}

async function download(url: string, dest: string, onProgress?: (n: number, total: number | null) => void): Promise<void> {
  const res = await fetch(url, { redirect: "follow", headers: { "User-Agent": GH_UA["User-Agent"] } });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    n += value.byteLength;
    const now = Date.now();
    if (onProgress && (now - last >= 100 || (total && n >= total))) {
      last = now;
      onProgress(n, total && total > 0 ? total : null);
    }
  }
  onProgress?.(n, total && total > 0 ? total : null);
  writeFileSync(dest, Buffer.concat(chunks.map((c) => Buffer.from(c))));
}

/** Download GitHub .tar.gz asset and install `binaryName` to installPath. */
export async function installTarGzBinary(
  url: string,
  binaryName: string,
  installPath: string,
  onProgress?: (n: number, total: number | null) => void,
): Promise<void> {
  if (!isAllowedAssetUrl(url)) throw new Error("invalid github release tar.gz URL");
  const work = join(tmpdir(), `mixcode-${binaryName}-${process.pid}-${Date.now()}`);
  mkdirSync(join(work, "x"), { recursive: true });
  try {
    const archive = join(work, "a.tar.gz");
    await download(url, archive, onProgress);
    const tar = spawnSync("tar", ["-xzf", archive, "-C", join(work, "x")], { encoding: "utf-8" });
    if (tar.status !== 0) throw new Error(`tar: ${(tar.stderr || tar.stdout || "").trim() || tar.status}`);
    const bin = findInTree(join(work, "x"), binaryName);
    if (!bin) throw new Error(`archive missing ${binaryName}`);
    mkdirSync(dirname(installPath), { recursive: true });
    copyFileSync(bin, installPath);
    chmodSync(installPath, 0o755);
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

async function latestAsset(
  repo: string,
  pick: (j: unknown) => ReleaseAsset | null,
): Promise<ReleaseAsset | null> {
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, { headers: GH_UA });
    if (!res.ok) return null;
    return pick(await res.json());
  } catch {
    return null;
  }
}

type Ui = {
  notify: (msg: string, level?: string) => void;
  select?: (title: string, options: string[]) => Promise<string | undefined>;
  input?: (title: string, placeholder?: string) => Promise<string | undefined>;
};

async function ensureDelta(ui: Ui, diffnavCmd: string): Promise<void> {
  if (resolveDeltaBinary(diffnavCmd)) return;
  const target = deltaAssetTarget();
  if (!target) return;
  const meta = await latestAsset("dandavison/delta", (j) => pickDeltaReleaseAsset(j as never, target));
  if (!meta) {
    ui.notify("Could not fetch delta release (dandavison/delta)", "warning");
    return;
  }
  ui.notify(`Installing delta ${meta.tag}…`, "info");
  try {
    await installTarGzBinary(meta.url, "delta", defaultDeltaBinaryPath(), (n, t) =>
      ui.notify(formatDownloadProgress(n, t, "delta"), "info"),
    );
    ui.notify(`Installed delta ${meta.tag}`, "info");
  } catch (e) {
    ui.notify(`delta install failed: ${e instanceof Error ? e.message : String(e)}`, "error");
  }
}

async function installDiffnavUrl(ui: Ui, url: string): Promise<string | null> {
  try {
    await installTarGzBinary(url, "diffnav", defaultDiffnavBinaryPath(), (n, t) =>
      ui.notify(formatDownloadProgress(n, t, "diffnav"), "info"),
    );
    const ver = parseDiffnavVersionOutput(
      `${spawnSync(defaultDiffnavBinaryPath(), ["--version"], { encoding: "utf-8" }).stdout ?? ""}`,
    );
    ui.notify(`Installed diffnav ${ver}`, "info");
    cachedDiffnav = undefined;
    const cmd = detectDiffnavCommand({ useCache: false }) ?? defaultDiffnavBinaryPath();
    await ensureDelta(ui, cmd);
    return cmd;
  } catch (e) {
    ui.notify(`diffnav install failed: ${e instanceof Error ? e.message : String(e)}`, "error");
    return null;
  }
}

async function ensureDiffnav(ui: Ui): Promise<string | null> {
  const existing = detectDiffnavCommand();
  if (existing) {
    await ensureDelta(ui, existing);
    return existing;
  }
  if (askedInstall) return null;
  askedInstall = true;

  const triple = platformAssetName();
  if (!triple || !ui.select) {
    if (!ui.select) ui.notify("diffnav missing; UI select unavailable — using pager", "warning");
    return null;
  }

  const meta = triple
    ? await latestAsset("dlvhdr/diffnav", (j) => pickReleaseAsset(j as never, triple))
    : null;
  const installLabel = meta ? `Install ${meta.tag} (${meta.assetName}, ${(meta.size / (1024 * 1024)).toFixed(1)}MB)` : null;
  const pasteLabel = "Paste GitHub asset URL…";
  const skipLabel = "Skip (use pager)";
  const options = installLabel ? [installLabel, pasteLabel, skipLabel] : [pasteLabel, skipLabel];
  if (!meta) ui.notify("Could not fetch diffnav release metadata; paste URL or skip", "warning");

  const choice = await ui.select("diffnav not found", options);
  if (!choice || choice === skipLabel) return null;

  let url = meta?.url ?? "";
  if (choice === pasteLabel || !url) {
    const pasted = ui.input
      ? await ui.input("GitHub release asset URL", "https://github.com/.../releases/download/...")
      : undefined;
    if (!pasted?.trim()) return null;
    url = pasted.trim();
  }
  return installDiffnavUrl(ui, url);
}

function spawnPager(tmpFile: string): ReturnType<typeof spawn> {
  const pager = process.env.PAGER?.trim();
  return spawn("sh", ["-c", `${pager || "less -R"} "${tmpFile}"; rm -f "${tmpFile}"`], { stdio: "inherit" });
}

function spawnDiffnav(command: string, tmpFile: string): ReturnType<typeof spawn> {
  const esc = command.replace(/'/g, "'\\''");
  return spawn("sh", ["-c", `'${esc}' < "${tmpFile}" 2>"${tmpFile}.err"; ec=$?; rm -f "${tmpFile}"; exit $ec`], {
    stdio: "inherit",
    env: { ...process.env, PATH: viewerPathEnv(command) },
  });
}

interface Ctx {
  cwd: string;
  ui: Ui & {
    custom: <T>(
      fn: (
        tui: unknown,
        theme: unknown,
        keybindings: unknown,
        done: () => void,
      ) => { render: () => string[]; invalidate: () => void; handleInput: () => void },
    ) => Promise<T>;
  };
  sessionManager: { getBranch: () => unknown };
}

async function renderDiff(scopeEntries: SessionEntry[], cwd: string, ctx: Ctx): Promise<void> {
  if (scopeEntries.length === 0) {
    ctx.ui.notify("No entries found for the specified range.", "info");
    return;
  }
  const files = collectFileMods(scopeEntries, cwd);
  if (files.size === 0) {
    ctx.ui.notify("No file modifications found in this session.", "info");
    return;
  }
  const diffContent = buildDiff(files, cwd);
  if (!diffContent) {
    ctx.ui.notify("Files were modified but have no effective changes.", "info");
    return;
  }

  const diffnavCmd = await ensureDiffnav(ctx.ui);
  let viewerError: string | undefined;
  let usedDiffnav = false;

  const runViewer = async (useDiffnav: boolean) => {
    viewerError = undefined;
    usedDiffnav = useDiffnav;
    await ctx.ui.custom<void>((tui, _theme, _kb, done) => {
      const t = tui as { stop: () => void; start: () => void; requestRender: (f?: boolean) => void };
      t.stop();
      const tmpFile = join(tmpdir(), `mixcode-diff-${process.pid}-${Date.now()}.diff`);
      const errFile = `${tmpFile}.err`;
      writeFileSync(tmpFile, `${diffContent}\n`);
      const child =
        useDiffnav && diffnavCmd ? spawnDiffnav(diffnavCmd, tmpFile) : spawnPager(tmpFile);
      let doneOnce = false;
      const finish = (code: number | null, err?: Error) => {
        if (doneOnce) return;
        doneOnce = true;
        if (err) viewerError = err.message;
        else if (code !== 0 && code !== null) {
          try {
            viewerError = readFileSync(errFile, "utf-8").trim() || `viewer exited ${code}`;
          } catch {
            viewerError = `viewer exited ${code}`;
          }
        }
        for (const f of [tmpFile, errFile]) {
          try {
            unlinkSync(f);
          } catch {
            /* ignore */
          }
        }
        t.start();
        t.requestRender(true);
        done();
      };
      child.on("exit", (c) => finish(c));
      child.on("error", (e) => finish(1, e));
      return { render: () => [], invalidate: () => {}, handleInput: () => {} };
    });
  };

  await runViewer(Boolean(diffnavCmd));
  if (usedDiffnav && viewerError) {
    ctx.ui.notify(`diffnav failed: ${viewerError}; opening less`, "warning");
    await runViewer(false);
  } else if (viewerError) {
    ctx.ui.notify(`diff viewer failed: ${viewerError}`, "error");
  }
}


const extension: ExtensionFactory = (pi) => {
  pi.registerCommand("diff", {
    description: "Show session file changes (diffnav if available, else pager)",
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

      await renderDiff(scope, cwd, ctx as unknown as Ctx);
    },
  });

  pi.registerCommand("dl", {
    description: "Show file changes from the last turn (alias for /diff last)",
    handler: async (_args, ctx) => {
      const entries = ctx.sessionManager.getBranch() as unknown as SessionEntry[];
      const scope = getNthLastTurnEntries(entries, 1);
      await renderDiff(scope, ctx.cwd, ctx as unknown as Ctx);
    },
  });
};

export default extension;
