// +---------------------------------------------------------------------------+
// |  model-attach core                                                        |
// |  Pure helpers: config parse, model match, skill apply, extension plan.    |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";

export type ModelLike = {
  id: string;
  provider: string;
  input?: readonly string[];
};

export type ModelAttachMatch = {
  /** Glob against `provider/modelId`, e.g. `deepseek/*`. */
  model?: string;
  /** Every listed modality must be absent from model.input. */
  missingInput?: string[];
  /** Every listed modality must be present on model.input. */
  hasInput?: string[];
};

export type ModelAttachRule = {
  match: ModelAttachMatch;
  add?: string[];
  remove?: string[];
};

export type ModelAttachSection = {
  /** When false, this section's rules are not applied. Default true when omitted. */
  enabled?: boolean;
  rules: ModelAttachRule[];
};

export type ModelAttachConfig = {
  skills?: ModelAttachSection;
  extensions?: ModelAttachSection;
  /** Editor `$schema` reference; ignored by behavior, preserved on write. */
  schemaRef?: string;
};

export type ConfigSectionName = "skills" | "extensions";

/** Effective enabled flag (missing section or omitted enabled → true). */
export function isSectionEnabled(section: ModelAttachSection | null | undefined): boolean {
  if (!section) return true;
  return section.enabled !== false;
}

export type ConfigLoadResult =
  | { ok: true; config: ModelAttachConfig; path: string }
  | { ok: true; config: null; path: string; missing: true }
  | { ok: false; path: string; error: string };

export type ApplyWarning = { kind: "add" | "remove" | "path"; message: string };

export type ApplyResult = {
  skills: Skill[];
  warnings: ApplyWarning[];
  matchedRuleIndexes: number[];
};

export type PlanWarning = { kind: "add" | "remove" | "path" | "name"; message: string };

export type LoadPlan = {
  /** Absolute extension entry paths to load (order preserved, deduped). */
  paths: string[];
  warnings: PlanWarning[];
  matchedRuleIndexes: number[];
};

const SKILLS_SECTION_RE =
  /\n\nThe following skills provide specialized instructions for specific tasks\.[\s\S]*?<\/available_skills>/;
const SKILLS_TAG_RE = /\n?<available_skills>[\s\S]*?<\/available_skills>/;
const CWD_MARKER = "\nCurrent working directory: ";

/** Config lives at `<agentDir>/mpi-model-attach.json`. */
export function modelAttachConfigPath(agentDir: string): string {
  return path.join(agentDir, "mpi-model-attach.json");
}

/** Usage / config docs for `/model-attach help` (markdown). */
export function formatModelAttachHelp(configPath: string): string {
  return [
    "# /model-attach",
    "",
    "Adds or removes skills for the current model by rewriting the system prompt skills section.",
    "Loads extra extensions by calling their factories.",
    "",
    "## Usage",
    "",
    "- `/model-attach` status: config path, matching rules, effective skills, loaded extensions",
    "- `/model-attach help` this help",
    "- `/model-attach skills on` enable skill rules (writes config)",
    "- `/model-attach skills off` disable skill rules (writes config)",
    "- `/model-attach extensions on` enable extension rules (writes config)",
    "- `/model-attach extensions off` disable extension rules (writes config)",
    "",
    "## Config",
    "",
    `- File (global): \`${configPath}\``,
    "- Reload: session start or `/reload`. The agent path does not re-read this file every prompt.",
    "- Extension loads: `session_start` (current model) and `model_select` (newly matched paths only)",
    "- `enabled`: per section, `true` (default) / `false`. Toggle with `/model-attach skills|extensions on|off`.",
    "",
    "## Schema",
    "",
    "```json",
    "{",
    '  "skills": {',
    '    "enabled": true,',
    '    "rules": [',
    "      {",
    '        "match": { "model": "deepseek/*", "missingInput": ["image"] },',
    '        "add": ["skill-name", "$HOME/.agents/skills/vision-proxy"],',
    '        "remove": ["other-skill"]',
    "      }",
    "    ]",
    "  },",
    '  "extensions": {',
    '    "enabled": true,',
    '    "rules": [',
    "      {",
    '        "match": { "model": "deepseek/*" },',
    '        "add": ["$HOME/.pi/agent/model-exts/vision-helper", "my-ext"],',
    '        "remove": ["other-ext"]',
    "      }",
    "    ]",
    "  }",
    "}",
    "```",
    "",
    "Leave out `skills` or `extensions` if you do not want that half to run.",
    "",
    "### match",
    "",
    "| Field | Meaning |",
    "|-------|---------|",
    "| `model` | Glob on `provider/modelId` (`*`), e.g. `deepseek/*` |",
    "| `missingInput` | Every listed modality is absent from `model.input` |",
    "| `hasInput` | Every listed modality is present on `model.input` |",
    "| `{}` | Matches every model |",
    "",
    "Matching rules run in array order.",
    "",
    "### skills.add",
    "",
    "| Form | Meaning |",
    "|------|---------|",
    "| `skill-name` | From currently loaded skills |",
    "| `/abs`, `~/…`, `$VAR`, `$" + "{VAR}` | Load skill from absolute path (dir or `SKILL.md`) |",
    "",
    "Relative paths are rejected. A later add with the same name replaces the earlier one.",
    "",
    "### skills.remove",
    "",
    "Skill names only. A missing name warns and is otherwise a no-op.",
    "",
    "### extensions.add",
    "",
    "| Form | Meaning |",
    "|------|---------|",
    "| `/abs`, `~/…`, `$VAR`, `$" + "{VAR}` | Load extension entry from absolute path |",
    "| `name` | Resolve under `<agentDir>/extensions/<name>` (dir or `index.ts`/`index.js`) |",
    "",
    "Relative paths are rejected. The same path loads once.",
    "",
    "### extensions.remove",
    "",
    "Friendly names only (path basename / package dir). Drops matching adds",
    "from this package's load plan. Does not unload extensions Pi already loaded.",
    "",
    "## Example",
    "",
    "```json",
    "{",
    '  "skills": {',
    '    "rules": [',
    "      {",
    '        "match": { "missingInput": ["image"] },',
    '        "add": ["$HOME/.agents/skills/vision-proxy"]',
    "      }",
    "    ]",
    "  },",
    '  "extensions": {',
    '    "rules": [',
    "      {",
    '        "match": { "model": "deepseek/*" },',
    '        "add": ["$HOME/.pi/agent/model-exts/vision-helper"]',
    "      }",
    "    ]",
    "  }",
    "}",
    "```",
    "",
    "## Limits",
    "",
    "- This package calls factories. It does not filter Pi's discovery list.",
    "- Keep model-only extensions out of always-discovered dirs or they load twice.",
    "- Switching to a model that no longer matches does not unload. Use `/reload` or a new session.",
    "- `model_select` only adds newly matched paths. Missed `session_start` is not replayed.",
    "- `$Skill` refs (`mpi-skill-refs`) still use Pi's original skill list, not the rewritten prompt.",
  ].join("\n");
}

/**
 * Path refs start with `/`, `~/`, `~`, or `$` (env). Relative paths are rejected later.
 * Everything else is treated as a loaded skill name or friendly extension name.
 */
export function isPathRef(ref: string): boolean {
  return ref.startsWith("/") || ref.startsWith("~/") || ref === "~" || ref.startsWith("$");
}

/** Expand `~`, `${VAR}`, and `$VAR`. Unknown vars → error (caller skips that add). */
export function expandEnvPath(
  input: string,
): { ok: true; path: string } | { ok: false; error: string } {
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
    return {
      ok: false,
      error: `unknown environment variable(s): ${[...new Set(missing)].join(", ")}`,
    };
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

export function ruleMatches(match: ModelAttachMatch, model: ModelLike): boolean {
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

function unknownKeys(
  rec: object,
  allowed: readonly string[],
  label: string,
): { ok: false; error: string } | undefined {
  const extra = Object.keys(rec).filter((k) => !allowed.includes(k));
  if (extra.length === 0) return undefined;
  return { ok: false, error: `${label} has unknown key(s): ${extra.join(", ")}` };
}

function parseSection(
  raw: unknown,
  label: ConfigSectionName,
): { ok: true; section: ModelAttachSection } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `config.${label} must be an object` };
  }
  const rec = raw as { rules?: unknown; enabled?: unknown };
  const sectionExtra = unknownKeys(rec, ["rules", "enabled"], `config.${label}`);
  if (sectionExtra) return sectionExtra;
  if (rec.enabled !== undefined && typeof rec.enabled !== "boolean") {
    return { ok: false, error: `config.${label}.enabled must be a boolean when set` };
  }
  const rulesRaw = rec.rules;
  if (!Array.isArray(rulesRaw)) {
    return { ok: false, error: `config.${label}.rules must be an array` };
  }

  const rules: ModelAttachRule[] = [];
  for (let i = 0; i < rulesRaw.length; i++) {
    const r = rulesRaw[i];
    if (!r || typeof r !== "object" || Array.isArray(r)) {
      return { ok: false, error: `${label}.rules[${i}] must be an object` };
    }
    const rule = r as Record<string, unknown>;
    if (!rule.match || typeof rule.match !== "object" || Array.isArray(rule.match)) {
      return { ok: false, error: `${label}.rules[${i}].match must be an object` };
    }
    const m = rule.match as Record<string, unknown>;
    const ruleExtra = unknownKeys(rule, ["match", "add", "remove"], `${label}.rules[${i}]`);
    if (ruleExtra) return ruleExtra;
    const matchExtra = unknownKeys(
      m,
      ["model", "missingInput", "hasInput"],
      `${label}.rules[${i}].match`,
    );
    if (matchExtra) return matchExtra;
    const match: ModelAttachMatch = {};
    if (m.model !== undefined) {
      if (typeof m.model !== "string" || !m.model.trim()) {
        return { ok: false, error: `${label}.rules[${i}].match.model must be a non-empty string` };
      }
      match.model = m.model;
    }
    if (m.missingInput !== undefined) {
      if (!isStringArray(m.missingInput)) {
        return {
          ok: false,
          error: `${label}.rules[${i}].match.missingInput must be a string array`,
        };
      }
      match.missingInput = m.missingInput;
    }
    if (m.hasInput !== undefined) {
      if (!isStringArray(m.hasInput)) {
        return { ok: false, error: `${label}.rules[${i}].match.hasInput must be a string array` };
      }
      match.hasInput = m.hasInput;
    }
    if (rule.add !== undefined && !isStringArray(rule.add)) {
      return { ok: false, error: `${label}.rules[${i}].add must be a string array` };
    }
    if (rule.remove !== undefined && !isStringArray(rule.remove)) {
      return { ok: false, error: `${label}.rules[${i}].remove must be a string array` };
    }
    rules.push({
      match,
      add: rule.add as string[] | undefined,
      remove: rule.remove as string[] | undefined,
    });
  }
  const section: ModelAttachSection = { rules };
  if (typeof rec.enabled === "boolean") section.enabled = rec.enabled;
  return { ok: true, section };
}

/** Parse and validate mpi-model-attach.json body. */
export function parseModelAttachConfig(
  raw: unknown,
): { ok: true; config: ModelAttachConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config root must be an object" };
  }
  const root = raw as {
    skills?: unknown;
    extensions?: unknown;
    enabled?: unknown;
    rules?: unknown;
    $schema?: unknown;
  };
  if (root.rules !== undefined) {
    return {
      ok: false,
      error: "config.rules is not valid here; put rules under skills or extensions",
    };
  }
  if (root.enabled !== undefined) {
    return {
      ok: false,
      error: "config.enabled is not valid here; put enabled under skills or extensions",
    };
  }
  const rootExtra = unknownKeys(root, ["$schema", "skills", "extensions"], "config");
  if (rootExtra) return rootExtra;
  if (root.$schema !== undefined && typeof root.$schema !== "string") {
    return { ok: false, error: "config.$schema must be a string when set" };
  }

  const config: ModelAttachConfig = {};
  if (typeof root.$schema === "string") config.schemaRef = root.$schema;
  if (root.skills !== undefined) {
    const skills = parseSection(root.skills, "skills");
    if (!skills.ok) return skills;
    config.skills = skills.section;
  }
  if (root.extensions !== undefined) {
    const extensions = parseSection(root.extensions, "extensions");
    if (!extensions.ok) return extensions;
    config.extensions = extensions.section;
  }
  return { ok: true, config };
}

/** On-disk shape: schemaRef goes back under its `$schema` key, first. */
export function serializeModelAttachConfig(config: ModelAttachConfig): Record<string, unknown> {
  const { schemaRef, skills, extensions } = config;
  return {
    ...(schemaRef !== undefined ? { $schema: schemaRef } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

/** Persist one section's enabled flag; keeps existing rules. Creates file if missing. */
export function setSectionEnabled(
  agentDir: string,
  section: ConfigSectionName,
  enabled: boolean,
):
  | { ok: true; config: ModelAttachConfig; path: string }
  | { ok: false; path: string; error: string } {
  const filePath = modelAttachConfigPath(agentDir);
  const current = loadModelAttachConfig(agentDir);
  if (!current.ok) {
    return { ok: false, path: current.path, error: current.error };
  }
  const base: ModelAttachConfig =
    "missing" in current && current.missing ? {} : { ...current.config! };
  const existing = base[section];
  base[section] = existing ? { ...existing, enabled } : { enabled, rules: [] };
  try {
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(serializeModelAttachConfig(base), null, 2)}\n`,
      "utf8",
    );
    return { ok: true, config: base, path: filePath };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read config from disk. Missing file is ok (no rules). */
export function loadModelAttachConfig(agentDir: string): ConfigLoadResult {
  const filePath = modelAttachConfigPath(agentDir);
  try {
    const text = fs.readFileSync(filePath, "utf8");
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (err) {
      return {
        ok: false,
        path: filePath,
        error: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const parsed = parseModelAttachConfig(raw);
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
export function loadSkillFromAbsolutePath(
  absPath: string,
): { ok: true; skill: Skill } | { ok: false; error: string } {
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

  const result = loadSkillsFromDir({ dir: skillDir, source: "model-attach" });
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
  const rooted = result.skills.find((s) => path.resolve(s.baseDir) === path.resolve(skillDir));
  if (rooted) return { ok: true, skill: rooted };
  return {
    ok: false,
    error: `ambiguous skills at ${absPath}: ${result.skills.map((s) => s.name).join(", ")}`,
  };
}

/**
 * Apply matched rules in array order.
 * - remove by name (warn if absent)
 * - add by name (from pool) or path (load); same name overwrites
 */
export function applyModelSkillRules(
  rules: ModelAttachRule[],
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
          warnings.push({
            kind: "path",
            message: `add path ${JSON.stringify(ref)}: ${expanded.error}`,
          });
          continue;
        }
        const loaded = loadSkillFromAbsolutePath(expanded.path);
        if (!loaded.ok) {
          warnings.push({
            kind: "path",
            message: `add path ${JSON.stringify(ref)}: ${loaded.error}`,
          });
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
export function replaceSkillsInSystemPrompt(
  systemPrompt: string,
  skills: readonly Skill[],
): string {
  const block = formatSkillsForPrompt(skills as Skill[]);

  if (SKILLS_SECTION_RE.test(systemPrompt)) {
    return systemPrompt.replace(SKILLS_SECTION_RE, () => block);
  }
  if (SKILLS_TAG_RE.test(systemPrompt)) {
    return systemPrompt.replace(SKILLS_TAG_RE, () => block);
  }
  if (!block) return systemPrompt;

  const idx = systemPrompt.lastIndexOf(CWD_MARKER);
  if (idx >= 0) {
    return systemPrompt.slice(0, idx) + block + systemPrompt.slice(idx);
  }
  return systemPrompt + block;
}

const ENTRY_CANDIDATES = ["index.ts", "index.js", "index.mjs", "index.cjs"] as const;

/**
 * Resolve a filesystem location to an extension entry file.
 * Accepts a file path, or a directory containing index.ts/js.
 */
export function resolveExtensionEntry(
  absPath: string,
): { ok: true; path: string } | { ok: false; error: string } {
  let st: fs.Stats;
  try {
    st = fs.statSync(absPath);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  if (st.isFile()) {
    return { ok: true, path: path.resolve(absPath) };
  }
  if (!st.isDirectory()) {
    return { ok: false, error: `not a file or directory: ${absPath}` };
  }

  for (const name of ENTRY_CANDIDATES) {
    const candidate = path.join(absPath, name);
    try {
      if (fs.statSync(candidate).isFile()) {
        return { ok: true, path: path.resolve(candidate) };
      }
    } catch {
      // Missing candidate (ENOENT or not a file); try the next index.*.
    }
  }
  return { ok: false, error: `no index.ts/js entry in directory: ${absPath}` };
}

/**
 * Friendly name → `<agentDir>/extensions/<name>` (dir or file).
 * Resolves only under the agent extensions root, not npm package trees.
 */
export function resolveExtensionName(
  agentDir: string,
  name: string,
): { ok: true; path: string } | { ok: false; error: string } {
  const trimmed = name.trim();
  if (!trimmed) return { ok: false, error: "empty extension name" };
  if (trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("..")) {
    return { ok: false, error: `invalid extension name: ${JSON.stringify(name)}` };
  }
  const base = path.join(agentDir, "extensions", trimmed);
  return resolveExtensionEntry(base);
}

/** Resolve an add ref (path or name) to an absolute entry path. */
export function resolveExtensionRef(
  agentDir: string,
  ref: string,
): { ok: true; path: string } | { ok: false; error: string } {
  if (isPathRef(ref)) {
    const expanded = expandEnvPath(ref);
    if (!expanded.ok) return expanded;
    return resolveExtensionEntry(expanded.path);
  }
  return resolveExtensionName(agentDir, ref);
}

/** Friendly name for an entry path (dir name, or parent of index.*). */
export function friendlyExtensionName(entryPath: string): string {
  const resolved = path.resolve(entryPath);
  const base = path.basename(resolved);
  if (/^index\.[a-z]+$/i.test(base)) {
    return path.basename(path.dirname(resolved));
  }
  return base.replace(/\.[a-z]+$/i, "") || base;
}

/**
 * Apply matched extension rules in array order.
 * - remove by friendly name from the planned set (warn if absent)
 * - add by path or name; same path overwrites (keeps latest)
 */
export function planModelExtensionLoads(
  rules: ModelAttachRule[],
  model: ModelLike,
  agentDir: string,
): LoadPlan {
  // path -> true; Map keeps insertion order. Re-add deletes then sets to move to end.
  const planned = new Map<string, true>();
  const warnings: PlanWarning[] = [];
  const matchedRuleIndexes: number[] = [];

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]!;
    if (!ruleMatches(rule.match, model)) continue;
    matchedRuleIndexes.push(i);

    for (const name of rule.remove ?? []) {
      let removed = false;
      for (const p of [...planned.keys()]) {
        if (friendlyExtensionName(p) === name) {
          planned.delete(p);
          removed = true;
        }
      }
      if (!removed) {
        warnings.push({ kind: "remove", message: `remove: extension not in load plan: ${name}` });
      }
    }

    for (const ref of rule.add ?? []) {
      const resolved = resolveExtensionRef(agentDir, ref);
      if (!resolved.ok) {
        warnings.push({
          kind: isPathRef(ref) ? "path" : "name",
          message: `add ${JSON.stringify(ref)}: ${resolved.error}`,
        });
        continue;
      }
      planned.delete(resolved.path);
      planned.set(resolved.path, true);
    }
  }

  return {
    paths: [...planned.keys()],
    warnings,
    matchedRuleIndexes,
  };
}
