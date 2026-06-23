import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";

/**
 * Live `@` file completion backed by `fd`, ported from pi-tui's
 * CombinedAutocompleteProvider (node_modules/@earendil-works/pi-tui/dist/autocomplete.js).
 *
 * Why this exists: the static-scan picker (`scanProjectFiles`) caps results at
 * 2000 entries and snapshots the tree, so newly created files and deep trees
 * are invisible until a rescan. pi instead queries `fd` on every keystroke,
 * which is fast, respects `.gitignore`, and always reflects the current disk
 * state. This module reproduces that behavior so mixcode's completion matches
 * pi when `fd` is available; the caller falls back to the static list otherwise.
 */

export interface FdFileMatch {
  /** Project/display-relative path; directories keep a trailing "/". */
  displayPath: string;
  isDirectory: boolean;
}

function toDisplayPath(value: string): string {
  return value.replace(/\\/g, "/");
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Translate a user query into an fd pattern. A flat query (no "/") is matched
 * by filename; a query containing "/" becomes a path regex where each segment
 * is anchored by a separator class, so "core/file" matches ".../core/file...".
 */
function buildFdPathQuery(query: string): string {
  const normalized = toDisplayPath(query);
  if (!normalized.includes("/")) return normalized;
  const hasTrailingSeparator = normalized.endsWith("/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  if (!trimmed) return normalized;
  const separatorPattern = "[\\\\/]";
  const segments = trimmed
    .split("/")
    .filter(Boolean)
    .map((segment) => escapeRegex(segment));
  if (segments.length === 0) return normalized;
  let pattern = segments.join(separatorPattern);
  if (hasTrailingSeparator) pattern += separatorPattern;
  return pattern;
}

/** Expand a leading "~/" (or bare "~") to the user's home directory. */
function expandHomePath(path: string): string {
  if (path.startsWith("~/")) {
    const expanded = join(homedir(), path.slice(2));
    return path.endsWith("/") && !expanded.endsWith("/") ? `${expanded}/` : expanded;
  }
  if (path === "~") return homedir();
  return path;
}

interface ScopedQuery {
  baseDir: string;
  query: string;
  displayBase: string;
}

/**
 * When the query contains a directory portion (e.g. "src/co"), resolve the
 * base directory to search inside and the remaining fuzzy term. Returns null
 * for flat queries or when the base directory does not exist, in which case
 * the caller searches the whole tree from `basePath`.
 */
function resolveScopedFuzzyQuery(rawQuery: string, basePath: string): ScopedQuery | null {
  const normalizedQuery = toDisplayPath(rawQuery);
  const slashIndex = normalizedQuery.lastIndexOf("/");
  if (slashIndex === -1) return null;
  const displayBase = normalizedQuery.slice(0, slashIndex + 1);
  const query = normalizedQuery.slice(slashIndex + 1);
  let baseDir: string;
  if (displayBase.startsWith("~/")) baseDir = expandHomePath(displayBase);
  else if (displayBase.startsWith("/")) baseDir = displayBase;
  else baseDir = join(basePath, displayBase);
  try {
    if (!statSync(baseDir).isDirectory()) return null;
  } catch {
    return null;
  }
  return { baseDir, query, displayBase };
}

function scopedPathForDisplay(displayBase: string, relativePath: string): string {
  const normalized = toDisplayPath(relativePath);
  if (displayBase === "/") return `/${normalized}`;
  return `${toDisplayPath(displayBase)}${normalized}`;
}

/** Score an entry against the query; directories get a bonus to sort first. */
function scoreEntry(filePath: string, query: string, isDirectory: boolean): number {
  // basename() strips a trailing slash, so directory paths like "src/core/"
  // still score on their final segment ("core") rather than an empty string.
  const fileName = basename(filePath);
  const lowerFileName = fileName.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let score = 0;
  if (lowerFileName === lowerQuery) score = 100;
  else if (lowerFileName.startsWith(lowerQuery)) score = 80;
  else if (lowerFileName.includes(lowerQuery)) score = 50;
  else if (filePath.toLowerCase().includes(lowerQuery)) score = 30;
  if (isDirectory && score > 0) score += 10;
  return score;
}

interface FdRawEntry {
  path: string;
  isDirectory: boolean;
}

/** Walk a directory tree with fd (fast, respects .gitignore). */
function walkDirectoryWithFd(
  baseDir: string,
  fdPath: string,
  query: string,
  maxResults: number,
  signal: AbortSignal,
): Promise<FdRawEntry[]> {
  const args = [
    "--base-directory",
    baseDir,
    "--max-results",
    String(maxResults),
    "--type",
    "f",
    "--type",
    "d",
    "--follow",
    "--hidden",
    "--exclude",
    ".git",
    "--exclude",
    ".git/*",
    "--exclude",
    ".git/**",
  ];
  if (toDisplayPath(query).includes("/")) args.push("--full-path");
  if (query) args.push(buildFdPathQuery(query));

  return new Promise<FdRawEntry[]>((resolve) => {
    if (signal.aborted) {
      resolve([]);
      return;
    }
    const child = spawn(fdPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let resolved = false;
    const onAbort = () => {
      if (child.exitCode === null) child.kill("SIGKILL");
    };
    const finish = (results: FdRawEntry[]) => {
      if (resolved) return;
      resolved = true;
      signal.removeEventListener("abort", onAbort);
      resolve(results);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.on("error", () => finish([]));
    child.on("close", (code) => {
      if (signal.aborted || code !== 0 || !stdout) {
        finish([]);
        return;
      }
      const results: FdRawEntry[] = [];
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const displayLine = toDisplayPath(line);
        const isDirectory = displayLine.endsWith("/");
        const normalized = isDirectory ? displayLine.slice(0, -1) : displayLine;
        if (
          normalized === ".git" ||
          normalized.startsWith(".git/") ||
          normalized.includes("/.git/")
        ) {
          continue;
        }
        results.push({ path: displayLine, isDirectory });
      }
      finish(results);
    });
  });
}

/**
 * Fuzzy file search using fd. `rawQuery` is the text after `@` (already
 * stripped of any leading quote). Returns up to `limit` matches with display
 * paths relative to the original query base, directories first.
 */
export async function fdFileSuggestions(
  rawQuery: string,
  options: { workdir: string; fdPath: string; signal: AbortSignal; limit?: number },
): Promise<FdFileMatch[]> {
  const { workdir, fdPath, signal } = options;
  const limit = options.limit ?? 20;
  if (signal.aborted) return [];
  const expandedQuery = rawQuery.startsWith("~") ? expandHomePath(rawQuery) : rawQuery;
  const scoped = resolveScopedFuzzyQuery(expandedQuery, workdir);
  const fdBaseDir = scoped?.baseDir ?? workdir;
  const fdQuery = scoped?.query ?? expandedQuery;
  const entries = await walkDirectoryWithFd(fdBaseDir, fdPath, fdQuery, 100, signal);
  if (signal.aborted) return [];
  const scored = entries
    .map((entry) => ({
      ...entry,
      score: fdQuery ? scoreEntry(entry.path, fdQuery, entry.isDirectory) : 1,
    }))
    .filter((entry) => entry.score > 0);
  scored.sort((a, b) => b.score - a.score);
  const matches: FdFileMatch[] = [];
  for (const { path: entryPath, isDirectory } of scored.slice(0, limit)) {
    const pathWithoutSlash = isDirectory ? entryPath.slice(0, -1) : entryPath;
    const displayBody = scoped
      ? scopedPathForDisplay(scoped.displayBase, pathWithoutSlash)
      : pathWithoutSlash;
    const displayPath = isDirectory ? `${displayBody}/` : displayBody;
    matches.push({ displayPath, isDirectory });
  }
  return matches;
}
