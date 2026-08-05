// +---------------------------------------------------------------------------+
// |  model-skills core                                                        |
// |  Pure helpers: config parse, model match, path/name add refs, env expand, |
// |  rule application, system-prompt skills section replace.                  |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createSyntheticSourceInfo,
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export type ModelLike = {
  id: string;
  provider: string;
  input?: readonly string[];
};

export type ModelSkillsMatch = {
  /** Glob against `provider/modelId`, e.g. `deepseek/*`. */
  model?: string;
  /** Every listed modality must be absent from model.input. */
  missingInput?: string[];
  /** Every listed modality must be present on model.input. */
  hasInput?: string[];
};

export type ModelSkillsRule = {
  match: ModelSkillsMatch;
  add?: string[];
  remove?: string[];
};

export type ModelSkillsConfig = {
  /** When false, rules are not applied. Default true when omitted. */
  enabled?: boolean;
  rules: ModelSkillsRule[];
};

/** Effective enabled flag (missing → true). */
export function isModelSkillsEnabled(config: ModelSkillsConfig | null | undefined): boolean {
  if (!config) return true;
  return config.enabled !== false;
}

export type ConfigLoadResult =
  | { ok: true; config: ModelSkillsConfig; path: string }
  | { ok: true; config: null; path: string; missing: true }
  | { ok: false; path: string; error: string };

export type ApplyWarning = { kind: "add" | "remove" | "path"; message: string };

export type ApplyResult = {
  skills: Skill[];
  warnings: ApplyWarning[];
  matchedRuleIndexes: number[];
};

const SKILLS_SECTION_RE =
  /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const SKILLS_TAG_RE = /\n?<available_skills>[\s\S]*?<\/available_skills>/;
const CWD_MARKER = "\nCurrent working directory: ";

/** Config lives at `<agentDir>/model-skills.json`. */
export function modelSkillsConfigPath(agentDir: string): string {
  return path.join(agentDir, "model-skills.json");
}

/** Usage / config docs for `/model-skills help` (markdown). */
export function formatModelSkillsHelp(configPath: string): string {
  return [
    "# /model-skills",
    "",
    "Per-model skill **add/remove** by rewriting the system prompt skills section.",
    "",
    "## Usage",
    "",
    "- `/model-skills` — show config path, matching rules, effective skills",
    "- `/model-skills help` — this help",
    "- `/model-skills on` — enable rule application (persists to config)",
    "- `/model-skills off` — disable rule application (persists to config)",
    "",
    "## Config",
    "",
    `- **File (global):** \`${configPath}\``,
    "- **Reload:** session start or `/reload` (agent path does not re-read every prompt)",
    "- **enabled:** `true` (default) / `false` — toggled by `/model-skills on|off`",
    "",
    "## Schema",
    "",
    "```json",
    "{",
    '  "enabled": true,',
    '  "rules": [',
    "    {",
    '      "match": {',
    '        "model": "deepseek/*",',
    '        "missingInput": ["image"],',
    '        "hasInput": ["image"]',
    "      },",
    '      "add": ["skill-name", "$HOME/.agents/skills/vision-proxy"],',
    '      "remove": ["other-skill"]',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "### match",
    "",
    "| Field | Meaning |",
    "|-------|---------|",
    "| `model` | Glob on `provider/modelId` (`*`), e.g. `deepseek/*` |",
    "| `missingInput` | All listed modalities must be **absent** from `model.input` |",
    "| `hasInput` | All listed modalities must be **present** on `model.input` |",
    "| `{}` | Matches every model |",
    "",
    "Multiple matching rules apply **in array order**.",
    "",
    "### add (string list)",
    "",
    "| Form | Meaning |",
    "|------|---------|",
    "| `skill-name` | From currently loaded skills |",
    "| `/abs`, `~/…`, `$VAR`, `${VAR}` | Load skill from absolute path (dir or `SKILL.md`) |",
    "",
    "Relative paths are **rejected**. Same name: **add overwrites**.",
    "",
    "### remove",
    "",
    "Skill **names** only. Missing name → warning (idempotent).",
    "",
    "## Example (vision polyfill)",
    "",
    "```json",
    "{",
    '  "rules": [',
    "    {",
    '      "match": { "missingInput": ["image"] },',
    '      "add": ["$HOME/.agents/skills/vision-proxy"]',
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "> **Note:** `$Skill` refs (`mpi-skill-refs`) still use Pi's original skill list, not the rewritten prompt.",
  ].join("\n");
}

/**
 * Path refs start with `/`, `~/`, `~`, or `$` (env). Relative paths are rejected later.
 * Everything else is treated as a loaded skill name.
 */
export function isPathRef(ref: string): boolean {
  return ref.startsWith("/") || ref.startsWith("~/") || ref === "~" || ref.startsWith("$");
}

/** Expand `~`, `${VAR}`, and `$VAR`. Unknown vars → error (caller skips that add). */
export function expandEnvPath(input: string): { ok: true; path: string } | { ok: false; error: string } {
  let s = input;
  if (s === "~") {
    s = os.homedir();
  } else if (s.startsWith("~/")) {
    s = path.join(os.homedir(), s.slice(2));
  }

  const missing: string[] = [];
  s = s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) missing.push(name);
    return v ?? "";
  });
  s = s.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = process.env[name];
    if (v === undefined) missing.push(name);
    return v ?? "";
  });

  if (missing.length > 0) {
    return { ok: false, error: `unknown environment variable(s): ${[...new Set(missing)].join(", ")}` };
  }

  if (!path.isAbsolute(s)) {
    return { ok: false, error: `path must resolve to an absolute path (got ${JSON.stringify(s)})` };
  }
  return { ok: true, path: s };
}

/** Simple glob: `*` matches any run of characters (including `/`). */
export function matchGlob(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(value);
}

export function modelKey(model: ModelLike): string {
  return `${model.provider}/${model.id}`;
}

export function ruleMatches(match: ModelSkillsMatch, model: ModelLike): boolean {
  if (match.model !== undefined) {
    if (!matchGlob(match.model, modelKey(model))) return false;
  }
  const inputs = new Set(model.input ?? []);
  if (match.missingInput) {
    for (const m of match.missingInput) {
      if (inputs.has(m)) return false;
    }
  }
  if (match.hasInput) {
    for (const m of match.hasInput) {
      if (!inputs.has(m)) return false;
    }
  }
  return true;
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Parse and validate model-skills.json body. */
export function parseModelSkillsConfig(raw: unknown): { ok: true; config: ModelSkillsConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config root must be an object" };
  }
  const root = raw as { rules?: unknown; enabled?: unknown };
  if (root.enabled !== undefined && typeof root.enabled !== "boolean") {
    return { ok: false, error: "config.enabled must be a boolean when set" };
  }
  const rulesRaw = root.rules;
  if (!Array.isArray(rulesRaw)) {
    return { ok: false, error: "config.rules must be an array" };
  }

  const rules: ModelSkillsRule[] = [];
  for (let i = 0; i < rulesRaw.length; i++) {
    const r = rulesRaw[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return { ok: false, error: `rules[${i}] must be an object` };
    }
    const rec = r as Record<string, unknown>;
    if (!rec.match || typeof rec.match !== "object" || Array.isArray(rec.match)) {
      return { ok: false, error: `rules[${i}].match must be an object` };
    }
    const m = rec.match as Record<string, unknown>;
    const match: ModelSkillsMatch = {};
    if (m.model !== undefined) {
      if (typeof m.model !== "string" || !m.model.trim()) {
        return { ok: false, error: `rules[${i}].match.model must be a non-empty string` };
      }
      match.model = m.model;
    }
    if (m.missingInput !== undefined) {
      if (!isStringArray(m.missingInput)) {
        return { ok: false, error: `rules[${i}].match.missingInput must be a string array` };
      }
      match.missingInput = m.missingInput;
    }
    if (m.hasInput !== undefined) {
      if (!isStringArray(m.hasInput)) {
        return { ok: false, error: `rules[${i}].match.hasInput must be a string array` };
      }
      match.hasInput = m.hasInput;
    }
    if (rec.add !== undefined && !isStringArray(rec.add)) {
      return { ok: false, error: `rules[${i}].add must be a string array` };
    }
    if (rec.remove !== undefined && !isStringArray(rec.remove)) {
      return { ok: false, error: `rules[${i}].remove must be a string array` };
    }
    rules.push({
      match,
      add: rec.add as string[] | undefined,
      remove: rec.remove as string[] | undefined,
    });
  }
  const config: ModelSkillsConfig = { rules };
  if (typeof root.enabled === "boolean") config.enabled = root.enabled;
  return { ok: true, config };
}

/** Persist enabled flag; keeps existing rules. Creates file if missing. */
export function setModelSkillsEnabled(
  agentDir: string,
  enabled: boolean,
): { ok: true; config: ModelSkillsConfig; path: string } | { ok: false; path: string; error: string } {
  const filePath = modelSkillsConfigPath(agentDir);
  const current = loadModelSkillsConfig(agentDir);
  if (!current.ok) {
    return { ok: false, path: current.path, error: current.error };
  }
  const config: ModelSkillsConfig =
    "missing" in current && current.missing
      ? { enabled, rules: [] }
      : { ...current.config!, enabled };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { ok: true, config, path: filePath };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read config from disk. Missing file is ok (no rules). */
export function loadModelSkillsConfig(agentDir: string): ConfigLoadResult {
  const filePath = modelSkillsConfigPath(agentDir);
  try {
    const text = fs.readFileSync(filePath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return { ok: false, path: filePath, error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}` };
    }
    const parsed = parseModelSkillsConfig(raw);
    if (!parsed.ok) return { ok: false, path: filePath, error: parsed.error };
    return { ok: true, config: parsed.config, path: filePath };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: true, config: null, path: filePath, missing: true };
    }
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Load a single skill from an absolute path (skill dir or SKILL.md / .md file). */
export function loadSkillFromAbsolutePath(absPath: string): { ok: true; skill: Skill } | { ok: false; error: string } {
  let skillDir = absPath;
  try {
    const st = fs.statSync(absPath);
    if (st.isFile()) {
      skillDir = path.dirname(absPath);
    } else if (!st.isDirectory()) {
      return { ok: false, error: `not a file or directory: ${absPath}` };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const result = loadSkillsFromDir({ dir: skillDir, source: "model-skills" });
  if (result.skills.length === 0) {
    return { ok: false, error: `no skill found at ${absPath}` };
  }
  // Prefer skill whose filePath matches when a file was specified.
  if (absPath !== skillDir) {
    const hit = result.skills.find((s) => path.resolve(s.filePath) === path.resolve(absPath));
    if (hit) return { ok: true, skill: hit };
  }
  if (result.skills.length === 1) {
    return { ok: true, skill: result.skills[0]! };
  }
  // Directory that is a skill root should yield one; if multiple, take the one
  // whose baseDir equals skillDir.
  const rooted = result.skills.find((s) => path.resolve(s.baseDir) === path.resolve(skillDir));
  if (rooted) return { ok: true, skill: rooted };
  return { ok: false, error: `ambiguous skills at ${absPath}: ${result.skills.map((s) => s.name).join(", ")}` };
}

/**
 * Apply matched rules in array order.
 * - remove by name (warn if absent)
 * - add by name (from pool) or path (load); same name overwrites
 */
export function applyModelSkillRules(
  rules: ModelSkillsRule[],
  model: ModelLike,
  baseSkills: readonly Skill[],
  loadedByName: ReadonlyMap<string, Skill>,
): ApplyResult {
  const byName = new Map<string, Skill>();
  for (const s of baseSkills) byName.set(s.name, s);

  const warnings: ApplyWarning[] = [];
  const matchedRuleIndexes: number[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (!ruleMatches(rule.match, model)) continue;
    matchedRuleIndexes.push(i);

    for (const name of rule.remove ?? []) {
      if (!byName.has(name)) {
        warnings.push({ kind: "remove", message: `remove: skill not present: ${name}` });
        continue;
      }
      byName.delete(name);
    }

    for (const ref of rule.add ?? []) {
      if (isPathRef(ref)) {
        const expanded = expandEnvPath(ref);
        if (!expanded.ok) {
          warnings.push({ kind: "path", message: `add path ${JSON.stringify(ref)}: ${expanded.error}` });
          continue;
        }
        const loaded = loadSkillFromAbsolutePath(expanded.path);
        if (!loaded.ok) {
          warnings.push({ kind: "path", message: `add path ${JSON.stringify(ref)}: ${loaded.error}` });
          continue;
        }
        byName.set(loaded.skill.name, loaded.skill);
        continue;
      }

      const fromPool = loadedByName.get(ref) ?? byName.get(ref);
      if (!fromPool) {
        warnings.push({ kind: "add", message: `add: skill not found: ${ref}` });
        continue;
      }
      byName.set(fromPool.name, fromPool);
    }
  }

  return {
    skills: [...byName.values()],
    warnings,
    matchedRuleIndexes,
  };
}

/**
 * Replace or remove the skills section in a system prompt.
 * When the section is absent and `skills` is non-empty, insert before the cwd line.
 */
export function replaceSkillsInSystemPrompt(systemPrompt: string, skills: readonly Skill[]): string {
  const block = formatSkillsForPrompt(skills as Skill[]);

  if (SKILLS_SECTION_RE.test(systemPrompt)) {
    return systemPrompt.replace(SKILLS_SECTION_RE, block);
  }
  if (SKILLS_TAG_RE.test(systemPrompt)) {
    return systemPrompt.replace(SKILLS_TAG_RE, block);
  }
  if (!block) return systemPrompt;

  const idx = systemPrompt.lastIndexOf(CWD_MARKER);
  if (idx >= 0) {
    return systemPrompt.slice(0, idx) + block + systemPrompt.slice(idx);
  }
  return systemPrompt + block;
}

/** Build a minimal Skill for tests without touching disk. */
export function syntheticSkill(name: string, description = `${name} skill`, filePath?: string): Skill {
  const fp = filePath ?? `/virtual/skills/${name}/SKILL.md`;
  return {
    name,
    description,
    filePath: fp,
    baseDir: path.dirname(fp),
    sourceInfo: createSyntheticSourceInfo(fp, { source: "model-skills-test" }),
    disableModelInvocation: false,
  };
}
