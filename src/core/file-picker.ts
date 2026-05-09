import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fuzzyMatchBatch } from "./fuzzy.js";

const EXCLUDED_DIRS = new Set([".git", "node_modules", ".cache", ".venv", "dist", "coverage"]);
const execFileAsync = promisify(execFile);

export async function scanProjectFiles(root: string, maxFiles = 2000): Promise<string[]> {
  if (maxFiles <= 0) return [];
  const gitFiles = await gitVisibleProjectFiles(root);
  if (gitFiles) return withParentDirectories(gitFiles).slice(0, maxFiles);
  const result: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (result.length >= maxFiles) return;
    for (const entry of await readdir(dir)) {
      if (EXCLUDED_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      const info = await stat(full);
      if (info.isDirectory()) {
        result.push(`${normalizeProjectPath(relative(root, full))}/`);
        if (result.length >= maxFiles) return;
        await walk(full);
      } else if (info.isFile()) {
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

async function gitVisibleProjectFiles(root: string): Promise<string[] | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", "."],
      { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 },
    );
    return stdout
      .split("\0")
      .filter(Boolean)
      .map(normalizeProjectPath)
      .filter((path) => path && !path.startsWith("../"))
      .sort((a, b) => a.localeCompare(b));
  } catch (error) {
    const code = (error as { code?: string | number }).code;
    if (code === 128 || code === "ENOENT") return undefined;
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

function directChildren(prefix: string, files: string[], limit: number): string[] {
  return files
    .filter((file) => {
      if (file === prefix || !file.startsWith(prefix)) return false;
      const rest = file.slice(prefix.length);
      const directName = rest.endsWith("/") ? rest.slice(0, -1) : rest;
      return directName.length > 0 && !directName.includes("/");
    })
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

function trimTrailingSlash(path: string): string {
  return path.endsWith("/") ? path.slice(0, -1) : path;
}
