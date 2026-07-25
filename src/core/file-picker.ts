import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { fuzzyMatchBatch } from "./fuzzy.js";

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".cache", ".venv", "dist", "coverage"]);
const execFileAsync = promisify(execFile);

export async function scanProjectFiles(root: string, maxFiles = 2000): Promise<string[]> {
  if (maxFiles <= 0) return [];
  const gitFiles = await gitVisibleProjectFiles(root);
  if (gitFiles) return withParentDirectories(gitFiles).slice(0, maxFiles);
  const result: string[] = [];
  // Use withFileTypes so each entry's kind is known without a follow-up stat().
  // The previous await stat(full) per child serialized all filesystem metadata
  // and made cold @ completion multi-second on medium trees without git/fd.
  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip (same as abandoning that branch).
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        result.push(`${normalizeProjectPath(relative(root, full))}/`);
        if (result.length >= maxFiles) return;
        await walk(full);
      } else if (entry.isFile()) {
        result.push(normalizeProjectPath(relative(root, full)));
      }
      if (result.length >= maxFiles) return;
    }
  }
  await walk(root);
  return result.sort();
}

export function searchProjectFiles(query: string, files: string[], limit = 20): string[] {
  if (!query.trim()) return files.slice(0, limit);
  if (query.endsWith("/")) return directChildren(query, files, limit);
  const byFullPath = fuzzyMatchBatch(query, files, limit * 2);
  const byBasename = fuzzyMatchBatch(
    normalizePathQuery(query),
    files.map((file) => displayBasename(file)),
    limit * 2,
  );
  const scores = new Map<string, number>();
  for (const [score, file] of byFullPath)
    scores.set(
      file,
      Math.min(scores.get(file) ?? Number.POSITIVE_INFINITY, rankFileMatch(score + 2, file, query)),
    );
  for (const [score, basename] of byBasename) {
    for (const file of files) {
      if (displayBasename(file) === basename) {
        scores.set(
          file,
          Math.min(scores.get(file) ?? Number.POSITIVE_INFINITY, rankFileMatch(score, file, query)),
        );
      }
    }
  }
  return [...scores.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([file]) => file);
}

function displayBasename(path: string): string {
  const normalized = path.endsWith("/") ? path.slice(0, -1) : path;
  return normalized.split("/").pop() ?? normalized;
}

function normalizePathQuery(query: string): string {
  return query.endsWith("/") ? query.slice(0, -1) : query;
}

/** Cap git ls-files so a hung/slow repo cannot block startup or @ completion forever. */
const GIT_LS_FILES_TIMEOUT_MS = 5_000;

/**
 * Errors where scanProjectFiles should abandon git listing and walk the tree.
 * Node timeout shapes vary: timedOut, ETIMEDOUT, or killed+SIGTERM with null code.
 */
export function isGitListFallbackError(error: unknown): boolean {
  const err = error as {
    code?: string | number | null;
    timedOut?: boolean;
    killed?: boolean;
    signal?: NodeJS.Signals | null;
  };
  // 128 = not a git repo; ENOENT = no git binary
  if (err.code === 128 || err.code === "ENOENT") return true;
  if (err.timedOut || err.code === "ETIMEDOUT") return true;
  // promisified execFile timeout on current Node: code null, killed, SIGTERM
  if (err.killed && err.code == null && (err.signal === "SIGTERM" || err.signal === "SIGKILL"))
    return true;
  return false;
}

async function gitVisibleProjectFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024, timeout: GIT_LS_FILES_TIMEOUT_MS },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeProjectPath)
      .filter((path) => path && !path.startsWith("../"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    if (isGitListFallbackError(error)) return undefined;
    throw error;
  }
}

function withParentDirectories(files: string[]): string[] {
  const paths = new Set<string>();
  for (const file of files) {
    const normalized = normalizeProjectPath(file);
    const parts = normalized.split("/");
    for (let index = 1; index < parts.length; index++) {
      paths.add(`${parts.slice(0, index).join("/")}/`);
    }
    paths.add(normalized);
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

function normalizeProjectPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function rankFileMatch(score: number, file: string, query: string): number {
  if (query.includes("/")) return score;
  return score + pathDepth(file) * 3;
}

function pathDepth(path: string): number {
  return trimTrailingSlash(path).split("/").length - 1;
}

function directChildren(query: string, files: string[], limit: number): string[] {
  // `query` ends with "/" and may be a partial trailing path (e.g. "core/" for
  // the real directory "src/core/"), so resolve it by matching directory
  // entries whose path is the query or ends with "/<query>" before listing
  // their direct children. This mirrors pi's `fd --full-path` behavior, which
  // matches a directory anywhere in the tree rather than only at the root.
  const matchingDirs = files.filter(
    (file) => file.endsWith("/") && (file === query || file.endsWith(`/${query}`)),
  );
  const children = new Set<string>();
  for (const dir of matchingDirs) {
    for (const file of files) {
      if (file === dir || !file.startsWith(dir)) continue;
      const rest = file.slice(dir.length);
      const directName = rest.endsWith("/") ? rest.slice(0, -1) : rest;
      if (directName.length > 0 && !directName.includes("/")) children.add(file);
    }
  }
  return [...children].sort((a, b) => a.localeCompare(b)).slice(0, limit);
}

function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
