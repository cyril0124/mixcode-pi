// +---------------------------------------------------------------------------+
// |  skill-refs core logic                                                    |
// |  Pure helpers: $ref extraction, SKILL.md scanning, skill block rendering, |
// |  and the $ autocomplete wrapper. No ExtensionAPI dependency so everything |
// |  here is directly unit-testable.                                          |
// +---------------------------------------------------------------------------+
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

/** A skill usable for $ref expansion and completion. */
export interface SkillRefEntry {
  name: string;
  filePath?: string;
  baseDir?: string;
  description?: string;
}

/** A fully resolved skill ready to render into the injected block. */
export interface ResolvedSkillRef {
  name: string;
  filePath: string;
  baseDir: string;
  description: string;
}

// Skill names must start with a letter and contain only alphanumeric,
// underscore, hyphen, or colon. A ref must not be glued to a preceding
// word/path character (avoids matching "foo$bar" or "path/$x").
const SKILL_REF_RE = /(?:^|(?<![\w/.-]))\$([A-Za-z][A-Za-z0-9_:-]*)/g;
const FENCED_CODE_RE = /^[ \t]*```[^\n]*\n.*?^[ \t]*```/gms;

// Common environment variable names that should never be treated as skill refs.
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

const INJECTION_INSTRUCTION = [
  "The user explicitly invoked the following skills via `$SkillName`.",
  "1. Read each SKILL.md from its <location>. Read only enough to follow the workflow.",
  "2. When SKILL.md references relative paths, resolve them against the <base> directory.",
  "3. Follow the skill instructions for this request.",
  "4. If a skill file cannot be read, say so briefly and continue with the best fallback.",
].join("\n");

/** Extract unique $SkillName refs in order, skipping fenced code and env vars. */
export function extractSkillRefs(text: string): string[] {
  const withoutCode = text.replace(FENCED_CODE_RE, "");
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const match of withoutCode.matchAll(SKILL_REF_RE)) {
    const name = match[1] as string;
    if (COMMON_ENV_VARS.has(name.toUpperCase()) || seen.has(name)) continue;
    seen.add(name);
    refs.push(name);
  }
  return refs;
}

function escapeXmlText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Render the hidden custom-message content injected alongside the user turn. */
export function buildSkillBlock(skills: ResolvedSkillRef[]): string {
  const xml = skills
    .map(
      (skill) =>
        `<skill name="${escapeXmlText(skill.name)}">\n  <location>${escapeXmlText(skill.filePath)}</location>\n  <description>${escapeXmlText(skill.description)}</description>\n  <base>${escapeXmlText(skill.baseDir)}</base>\n</skill>`,
    )
    .join("\n");
  return `${INJECTION_INSTRUCTION}\n${xml}`;
}

/**
 * Parse a skill description from SKILL.md content without a YAML dependency.
 * Handles single-line values, quoted values, folded/literal block scalars
 * (`>-`, `|`), and falls back to the first body paragraph.
 */
export function parseSkillDescription(content: string): string | undefined {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  let body = normalized;
  if (normalized.startsWith("---\n")) {
    const end = normalized.indexOf("\n---", 4);
    if (end !== -1) {
      const frontmatter = normalized.slice(4, end);
      body = normalized.slice(end + 4).trim();
      const fromFrontmatter = descriptionFromFrontmatter(frontmatter);
      if (fromFrontmatter) return fromFrontmatter;
    }
  }
  const firstParagraph = body
    .split(/\n\n/)
    .map((part) => part.replace(/^#\s+.+\n?/, "").trim())
    .find(Boolean);
  if (!firstParagraph) return undefined;
  return firstParagraph.split("\n").join(" ").slice(0, 300);
}

function descriptionFromFrontmatter(frontmatter: string): string | undefined {
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i]!.match(/^description\s*:\s*(.*)$/);
    if (!match) continue;
    const inline = match[1]!.trim();
    // Block scalar (>- / > / |- / |): join indented continuation lines.
    if (/^[>|][+-]?$/.test(inline)) {
      const parts: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const line = lines[j]!;
        if (!/^\s+\S/.test(line)) break;
        parts.push(line.trim());
      }
      const joined = parts.join(" ").trim();
      return joined || undefined;
    }
    if (!inline) return undefined;
    return stripYamlQuotes(inline);
  }
  return undefined;
}

function stripYamlQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function maybeSkillFile(path: string): Promise<string | undefined> {
  try {
    const info = await stat(path);
    return info.isFile() ? path : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Cold-start filesystem scan over the standard skill directories. Mirrors
 * Pi's native discovery locations so completion works before the first
 * prompt (the authoritative list from before_agent_start replaces this).
 */
export async function scanSkillDirs(
  cwd: string,
  homeDir = homedir(),
): Promise<Map<string, SkillRefEntry>> {
  const dirs = [
    join(cwd, ".agents", "skills"),
    join(homeDir, ".agents", "skills"),
    join(homeDir, ".pi", "agent", "skills"),
  ].map((dir) => resolve(dir));
  const entries = new Map<string, SkillRefEntry>();
  for (const dir of [...new Set(dirs)]) {
    let names: string[] = [];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const flat = await maybeSkillFile(join(dir, name, "SKILL.md"));
      if (flat) {
        await addScannedEntry(entries, name, flat);
        continue;
      }
      // Nested layout: <dir>/<group>/<name>/SKILL.md
      let nestedNames: string[] = [];
      try {
        nestedNames = await readdir(join(dir, name));
      } catch {
        continue;
      }
      for (const nested of nestedNames) {
        if (nested.startsWith(".")) continue;
        const nestedFile = await maybeSkillFile(join(dir, name, nested, "SKILL.md"));
        if (nestedFile) await addScannedEntry(entries, nested, nestedFile);
      }
    }
  }
  return entries;
}

async function addScannedEntry(
  entries: Map<string, SkillRefEntry>,
  name: string,
  filePath: string,
): Promise<void> {
  if (entries.has(name)) return; // earlier dirs win (project before home)
  try {
    const description = parseSkillDescription(await readFile(filePath, "utf8"));
    if (!description) return; // parity with host: skills need a description
    entries.set(name, { name, filePath, baseDir: dirname(filePath), description });
  } catch {
    // Unreadable skill files are simply not offered.
  }
}

/** Extract the current $/@-style token immediately before the cursor. */
function currentToken(lines: string[], cursorLine: number, cursorCol: number): string {
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
  return before.match(/(?:^|\s)(\$[^\s]*)$/)?.[1] ?? "";
}

function fuzzyIncludes(name: string, query: string): boolean {
  // Simple subsequence match keeps this dependency-free; skill lists are small.
  let index = 0;
  const lower = name.toLowerCase();
  for (const ch of query.toLowerCase()) {
    index = lower.indexOf(ch, index);
    if (index === -1) return false;
    index++;
  }
  return true;
}

/**
 * Wrap a base autocomplete provider with `$` skill completion. Non-$ tokens
 * delegate to the base provider untouched.
 */
export function createSkillCompletionWrapper(
  base: AutocompleteProvider,
  getEntries: () => SkillRefEntry[],
): AutocompleteProvider {
  return {
    triggerCharacters: [...new Set([...(base.triggerCharacters ?? []), "$"])],
    async getSuggestions(lines, cursorLine, cursorCol, options) {
      const token = currentToken(lines, cursorLine, cursorCol);
      if (!token.startsWith("$")) {
        return base.getSuggestions(lines, cursorLine, cursorCol, options);
      }
      const query = token.slice(1);
      const items: AutocompleteItem[] = getEntries()
        .filter((entry) => fuzzyIncludes(entry.name, query))
        .map((entry) => ({
          value: `$${entry.name}`,
          label: entry.name,
          description: entry.description ? `[Skill] ${entry.description}` : "[Skill]",
        }));
      if (items.length === 0) return null;
      return { prefix: token, items };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const token = currentToken(lines, cursorLine, cursorCol);
      if (!token.startsWith("$")) {
        return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
      }
      // Replace the whole $query token with the chosen value.
      const line = lines[cursorLine] ?? "";
      const start = cursorCol - token.length;
      const nextLine = `${line.slice(0, start)}${item.value}${line.slice(cursorCol)}`;
      const nextLines = lines.slice();
      nextLines[cursorLine] = nextLine;
      return { lines: nextLines, cursorLine, cursorCol: start + item.value.length };
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      if (currentToken(lines, cursorLine, cursorCol).startsWith("$")) return true;
      return base.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? false;
    },
  };
}
