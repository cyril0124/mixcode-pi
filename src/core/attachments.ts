import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import type { KnownSkill } from "./skill-command.js";

export interface SkillMeta {
  name: string;
  description: string;
  location: string;
}

export interface PromptPart {
  type: "text";
  text: string;
}

export interface BuiltPrompt {
  text: string;
  parts: PromptPart[];
  skills: SkillMeta[];
  files: string[];
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

// Skill names must start with a letter and contain only alphanumeric, underscore, hyphen, or colon.
const SKILL_REF_RE = /(?:^|(?<![\w/.-]))\$([A-Za-z][A-Za-z0-9_:-]*)/g;
const FENCED_CODE_RE = /^[ \t]*```[^\n]*\n.*?^[ \t]*```/gms;

// Common environment variable names that should never be treated as skill references.
const COMMON_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "PWD",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "TERM",
  "XDG_CONFIG_HOME",
  "GOPATH",
  "GOROOT",
  "JAVA_HOME",
  "NODE_PATH",
  "PYTHONPATH",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "EDITOR",
  "VISUAL",
  "DISPLAY",
  "HOSTNAME",
  "LOGNAME",
  "OLDPWD",
  "SHLVL",
  "LC_ALL",
  "LC_CTYPE",
]);

function isCommonEnvVar(name: string): boolean {
  return COMMON_ENV_VARS.has(name.toUpperCase());
}

// Marker used to separate user input from injected skill content in the prompt.
// This allows history restoration to strip the injected portion.
export const SKILL_INJECTION_SEPARATOR = "\n\n<!-- mixcode-pi:skills -->\n";

export const FORCE_SKILLS_INSTRUCTION = [
  "The user explicitly invoked the following skills via `$SkillName`.",
  "1. Read each SKILL.md from its <location>. Read only enough to follow the workflow.",
  "2. When SKILL.md references relative paths, resolve them against the <base> directory.",
  "3. Follow the skill instructions for this request.",
  "4. If a skill file cannot be read, say so briefly and continue with the best fallback.",
].join("\n");

/**
 * Strip injected skill content from a prompt, returning only the user's original input.
 * Used by history restoration to avoid showing expanded skill content in Up/Down recall.
 */
export function stripSkillInjection(text: string): string {
  const index = text.indexOf(SKILL_INJECTION_SEPARATOR);
  return index === -1 ? text : text.slice(0, index);
}

function withoutFencedCode(text: string): string {
  return text.replace(FENCED_CODE_RE, "");
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

export function extractSkillRefs(text: string): string[] {
  return uniqueInOrder(
    [...withoutFencedCode(text).matchAll(SKILL_REF_RE)]
      .map((match) => match[1] as string)
      .filter((name) => !isCommonEnvVar(name)),
  );
}

export function extractFileRefs(text: string): string[] {
  return uniqueInOrder(scanFileRefs(withoutFencedCode(text)));
}

function scanFileRefs(text: string): string[] {
  const refs: string[] = [];
  for (let index = 0; index < text.length; index++) {
    if (text[index] !== "@" || !isFileRefBoundary(text[index - 1])) continue;
    if (text[index + 1] === '"') {
      const quoted = readQuotedFileRef(text, index + 2);
      if (!quoted) continue;
      refs.push(quoted.value);
      index = quoted.end;
      continue;
    }
    const plain = readPlainFileRef(text, index + 1);
    if (!plain) continue;
    refs.push(plain.value);
    index = plain.end;
  }
  return refs;
}

function isFileRefBoundary(previous: string | undefined): boolean {
  return previous === undefined || !/[\w/.-]/.test(previous);
}

function readQuotedFileRef(
  text: string,
  start: number,
): { value: string; end: number } | undefined {
  let value = "";
  for (let index = start; index < text.length; index++) {
    const ch = text[index];
    if (ch === "\\") {
      const next = text[index + 1];
      if (next === '"' || next === "\\") {
        value += next;
        index++;
        continue;
      }
      value += ch;
      continue;
    }
    if (ch === '"') {
      return value ? { value, end: index } : undefined;
    }
    value += ch;
  }
  return undefined;
}

function readPlainFileRef(text: string, start: number): { value: string; end: number } | undefined {
  let end = start;
  while (end < text.length && !/[\s"'`<>]/.test(text[end]!)) end++;
  const value = text.slice(start, end).replace(/[!?;:)}\]"']+$/g, "");
  return value ? { value, end: end - 1 } : undefined;
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

export async function resolveSkillFile(
  name: string,
  baseWorkdir: string,
  homeDir = homedir(),
): Promise<string> {
  for (const dir of resolveSkillDirs(baseWorkdir, homeDir)) {
    const flat = await maybeSkillFile(join(dir, name, "SKILL.md"));
    if (flat) return flat;
    let entries: string[] = [];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const nested = await maybeSkillFile(join(dir, entry, name, "SKILL.md"));
      if (nested) return nested;
    }
  }
  throw new SkillError(`Unknown skill: ${name}`);
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
  const parsed = parseYaml(yaml);
  return {
    frontmatter: isRecord(parsed) ? parsed : {},
    body: content.slice(endIndex + 4).trim(),
  };
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

export async function resolveSkills(
  names: string[],
  baseWorkdir: string,
  homeDir = homedir(),
  knownSkills?: KnownSkill[],
): Promise<SkillMeta[]> {
  const skills: SkillMeta[] = [];
  for (const name of names) {
    try {
      // Try resource loader skills first (includes extension-contributed skills)
      const known = knownSkills?.find((s) => s.name === name);
      let location: string;
      if (known) {
        location = known.filePath;
      } else {
        location = await resolveSkillFile(name, baseWorkdir, homeDir);
      }
      const content = await readFile(location, "utf8");
      skills.push({ name, description: parseSkillDescription(content), location });
    } catch {}
  }
  return skills;
}

export async function scanSkillNames(baseWorkdir: string, homeDir = homedir()): Promise<string[]> {
  return (await scanSkillEntries(baseWorkdir, homeDir)).map((skill) => skill.name);
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
        if (!entriesByName.has(entry)) entriesByName.set(entry, await skillEntry(entry, flatPath));
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
        if (nestedPath && !entriesByName.has(nested))
          entriesByName.set(nested, await skillEntry(nested, nestedPath));
      }
    }
  }
  return [...entriesByName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function skillEntry(name: string, path: string): Promise<SkillEntry> {
  const content = await readFile(path, "utf8");
  return { name, path, description: parseSkillDescription(content) };
}

export function resolvePromptPath(ref: string, baseWorkdir: string): string {
  if (ref.startsWith("~/")) return resolve(join(homedir(), ref.slice(2)));
  if (isAbsolute(ref)) return resolve(ref);
  return resolve(baseWorkdir, ref);
}

export async function buildPrompt(
  text: string,
  baseWorkdir: string,
  homeDir = homedir(),
  knownSkills?: KnownSkill[],
): Promise<BuiltPrompt> {
  const skillNames = extractSkillRefs(text);
  const skills = await resolveSkills(skillNames, baseWorkdir, homeDir, knownSkills);
  const files = extractFileRefs(text).map((ref) => resolvePromptPath(ref, baseWorkdir));
  const parts: PromptPart[] = [{ type: "text", text }];
  if (skills.length > 0) {
    const skillXml = skills
      .map(
        (skill) =>
          `<skill name="${escapeXmlText(skill.name)}">\n  <location>${escapeXmlText(skill.location)}</location>\n  <description>${escapeXmlText(skill.description)}</description>\n  <base>${escapeXmlText(dirname(skill.location))}</base>\n</skill>`,
      )
      .join("\n");
    parts.push({
      type: "text",
      text: `${FORCE_SKILLS_INSTRUCTION}\n${skillXml}`,
    });
  }
  return { text, parts, skills, files };
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
