import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

function uniqueInOrder(values: Iterable<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}

export function resolveSkillDirs(baseWorkdir: string, homeDir = homedir()): string[] {
  const dirs = [
    join(baseWorkdir, ".agents", "skills"),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".pi", "agent", "skills"),
  ];
  return uniqueInOrder(dirs.map((dir) => resolve(dir)));
}

async function maybeSkillFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

export function parseSkillDescription(content: string): string {
  const normalized = normalizeNewlines(content);
  const { frontmatter, body } = parseFrontmatter(normalized);
  const frontmatterDescription = stringValue(frontmatter.description ?? frontmatter.desc);
  if (frontmatterDescription) return frontmatterDescription;
  const lines = body.split("\n");
  for (let index = 0; index < Math.min(lines.length, 40); index++) {
    const parsed = parseInlineDescription(lines[index] ?? "");
    if (parsed) return parsed;
  }
  const firstParagraph = body
    .split(/\n\n/)
    .map((part) => part.replace(/^#\s+.+\r?\n?/, "").trim())
    .find(Boolean);
  if (!firstParagraph) throw new SkillError("Skill is missing a description");
  return firstParagraph.split("\n").join(" ").slice(0, 300);
}

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  if (!content.startsWith("---\n")) return { frontmatter: {}, body: content };
  const endIndex = content.indexOf("\n---", 4);
  if (endIndex === -1) return { frontmatter: {}, body: content };
  const yaml = content.slice(4, endIndex);
  try {
    const parsed = parseYaml(yaml);
    return {
      frontmatter: isRecord(parsed) ? parsed : {},
      body: content.slice(endIndex + 4).trim(),
    };
  } catch {
    return { frontmatter: {}, body: content.slice(endIndex + 4).trim() };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim().replace(/\s+/g, " ") : undefined;
}

function parseInlineDescription(line: string): string | undefined {
  const match = line.match(/^\s*(?:description|desc)\s*:\s*(.+)$/i);
  if (!match?.[1]?.trim()) return undefined;
  return stringValue(match[1]);
}

export interface SkillEntry {
  name: string;
  path: string;
  description?: string;
}

export async function scanSkillEntries(
  baseWorkdir: string,
  homeDir = homedir(),
): Promise<SkillEntry[]> {
  const entriesByName = new Map<string, SkillEntry>();
  for (const dir of resolveSkillDirs(baseWorkdir, homeDir)) {
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const flatPath = await maybeSkillFile(join(dir, entry, "SKILL.md"));
      if (flatPath) {
        if (!entriesByName.has(entry)) {
          const skill = await maybeSkillEntry(entry, flatPath);
          if (skill) entriesByName.set(entry, skill);
        }
        continue;
      }
      let nestedEntries: string[] = [];
      try {
        nestedEntries = await readdir(join(dir, entry));
      } catch {
        continue;
      }
      for (const nested of nestedEntries) {
        if (nested.startsWith(".")) continue;
        const nestedPath = await maybeSkillFile(join(dir, entry, nested, "SKILL.md"));
        if (nestedPath && !entriesByName.has(nested)) {
          const skill = await maybeSkillEntry(nested, nestedPath);
          if (skill) entriesByName.set(nested, skill);
        }
      }
    }
  }
  return [...entriesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function maybeSkillEntry(name: string, path: string): Promise<SkillEntry | undefined> {
  try {
    const content = await readFile(path, "utf8");
    return { name, path, description: parseSkillDescription(content) };
  } catch {
    return undefined;
  }
}
