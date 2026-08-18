// +---------------------------------------------------------------------------+
// |  skill-refs core logic                                                    |
// |  Pure helpers: $ref extraction, skill loading via Pi, skill block         |
// |  rendering, and the $ autocomplete wrapper.                               |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, type AutocompleteProvider, fuzzyMatch } from "@earendil-works/pi-tui";

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

async function isDirectory(dirPath: string): Promise<boolean> {
  try {
    return (await fs.stat(dirPath)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the Pi agent dir. Env overrides apply only when the caller did not
 * pass an explicit agentDir (tests pass a synthetic home tree).
 */
function resolveAgentDir(homeDir: string, agentDir?: string): string {
  if (agentDir) return path.resolve(agentDir);
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return path.resolve(fromEnv);
  return path.resolve(path.join(homeDir, ".pi", "agent"));
}

/**
 * Package-contributed skill roots under a Pi agent dir.
 */
export async function listPackageSkillDirs(agentDir: string): Promise<string[]> {
  const roots: string[] = [];
  await collectPackageSkillDirs(path.join(agentDir, "npm", "node_modules"), roots);
  await collectPackageSkillDirs(path.join(agentDir, "extensions"), roots);
  await collectGitPackageSkillDirs(path.join(agentDir, "git"), roots, 0);
  return roots;
}

async function collectPackageSkillDirs(packagesDir: string, roots: string[]): Promise<void> {
  let names: string[] = [];
  try {
    names = await fs.readdir(packagesDir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      let scoped: string[] = [];
      try {
        scoped = await fs.readdir(path.join(packagesDir, name));
      } catch {
        continue;
      }
      for (const pkg of scoped) {
        if (pkg.startsWith(".")) continue;
        const skillsDir = path.join(packagesDir, name, pkg, "skills");
        if (await isDirectory(skillsDir)) roots.push(skillsDir);
      }
      continue;
    }
    const skillsDir = path.join(packagesDir, name, "skills");
    if (await isDirectory(skillsDir)) roots.push(skillsDir);
  }
}

const GIT_PACKAGE_MAX_DEPTH = 6;

async function collectGitPackageSkillDirs(
  dir: string,
  roots: string[],
  depth: number,
): Promise<void> {
  if (depth > GIT_PACKAGE_MAX_DEPTH) return;
  const skillsDir = path.join(dir, "skills");
  if (await isDirectory(skillsDir)) {
    roots.push(skillsDir);
    return;
  }
  let names: string[] = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(".") || name === "node_modules") continue;
    const full = path.join(dir, name);
    if (await isDirectory(full)) await collectGitPackageSkillDirs(full, roots, depth + 1);
  }
}

/**
 * Cold-start filesystem scan over standard skill directories plus package-
 * contributed skill roots using Pi's loadSkillsFromDir parser.
 */
export async function scanSkillDirs(
  cwd: string,
  homeDir = (process.env.HOME || os.homedir()),
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Map<string, SkillRefEntry>> {
  const resolvedAgentDir = resolveAgentDir(homeDir, agentDir);
  const projectSkillsDir = path.join(cwd, ".agents", "skills");
  const rawProjectOnly = env.MIXCODE_PROJECT_SKILLS_ONLY?.trim().toLowerCase();
  const projectOnly =
    rawProjectOnly !== undefined &&
    rawProjectOnly !== "" &&
    rawProjectOnly !== "0" &&
    rawProjectOnly !== "false" &&
    rawProjectOnly !== "off" &&
    rawProjectOnly !== "no";
  const dirs = (projectOnly
    ? [projectSkillsDir]
    : [
        projectSkillsDir,
        path.join(homeDir, ".agents", "skills"),
        path.join(resolvedAgentDir, "skills"),
        ...(await listPackageSkillDirs(resolvedAgentDir)),
      ]
  ).map((dir) => path.resolve(dir));

  const entries = new Map<string, SkillRefEntry>();
  for (const dir of [...new Set(dirs)]) {
    if (!(await isDirectory(dir))) continue;
    const loaded = loadSkillsFromDir({ dir, source: "path" });
    for (const skill of loaded.skills) {
      if (!entries.has(skill.name)) {
        entries.set(skill.name, {
          name: skill.name,
          filePath: skill.filePath,
          baseDir: skill.baseDir,
          description: skill.description,
        });
      }
    }
  }
  return entries;
}

/** Extract the current $/@-style token immediately before the cursor. */
function currentToken(lines: string[], cursorLine: number, cursorCol: number): string {
  const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
  return before.match(/(?:^|\s)(\$[^\s]*)$/)?.[1] ?? "";
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
        .filter((entry) => fuzzyMatch(query, entry.name).matches)
        .map((entry) => ({
          value: `$${entry.name}`,
          label: `$${entry.name}`,
          description: entry.description,
        }));
      return {
        items,
        prefix: token,
      };
    },
    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (item.value.startsWith("$")) {
        const line = lines[cursorLine] ?? "";
        const start = cursorCol - prefix.length;
        const updated = line.slice(0, start) + item.value + line.slice(cursorCol);
        return {
          lines: lines.map((l, i) => (i === cursorLine ? updated : l)),
          cursorLine,
          cursorCol: start + item.value.length,
        };
      }
      return base.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
    },
    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      const token = currentToken(lines, cursorLine, cursorCol);
      if (token.startsWith("$")) return true;
      if (base.shouldTriggerFileCompletion) {
        return base.shouldTriggerFileCompletion(lines, cursorLine, cursorCol);
      }
      return true;
    },
  };
}
