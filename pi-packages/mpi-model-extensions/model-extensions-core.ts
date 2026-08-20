// +---------------------------------------------------------------------------+
// |  model-extensions core                                                    |
// |  Pure helpers: config parse, model match, path/name resolve, load plan.   |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type ModelLike = {
  id: string;
  provider: string;
  input?: readonly string[];
};

export type ModelExtensionsMatch = {
  /** Glob against `provider/modelId`, e.g. `deepseek/*`. */
  model?: string;
  /** Every listed modality must be absent from model.input. */
  missingInput?: string[];
  /** Every listed modality must be present on model.input. */
  hasInput?: string[];
};

export type ModelExtensionsRule = {
  match: ModelExtensionsMatch;
  add?: string[];
  remove?: string[];
};

export type ModelExtensionsConfig = {
  /** When false, rules are not applied. Default true when omitted. */
  enabled?: boolean;
  rules: ModelExtensionsRule[];
  /** Editor `$schema` reference; ignored by behavior, preserved on write. */
  schemaRef?: string;
};

/** Effective enabled flag (missing → true). */
export function isModelExtensionsEnabled(config: ModelExtensionsConfig | null | undefined): boolean {
  if (!config) return true;
  return config.enabled !== false;
}

export type ConfigLoadResult =
  | { ok: true; config: ModelExtensionsConfig; path: string }
  | { ok: true; config: null; path: string; missing: true }
  | { ok: false; path: string; error: string };

export type PlanWarning = { kind: "add" | "remove" | "path" | "name"; message: string };

export type LoadPlan = {
  /** Absolute extension entry paths to load (order preserved, deduped). */
  paths: string[];
  warnings: PlanWarning[];
  matchedRuleIndexes: number[];
};

/** Config lives at `<agentDir>/mpi-model-extensions.json`. */
export function modelExtensionsConfigPath(agentDir: string): string {
  return path.join(agentDir, "mpi-model-extensions.json");
}

/** Usage / config docs for `/model-extensions help` (markdown). */
export function formatModelExtensionsHelp(configPath: string): string {
  return [
    "# /model-extensions",
    "",
    "Per-model extension **load** by dynamically invoking extension factories.",
    "",
    "## Usage",
    "",
    "- `/model-extensions` — show config path, matching rules, loaded paths",
    "- `/model-extensions help` — this help",
    "- `/model-extensions on` — enable rule application (persists to config)",
    "- `/model-extensions off` — disable rule application (persists to config)",
    "",
    "## Config",
    "",
    `- **File (global):** \`${configPath}\``,
    "- **Reload config:** session start or `/reload`",
    "- **Apply loads:** `session_start` (current model) and `model_select` (add-only)",
    "- **enabled:** `true` (default) / `false` — toggled by `/model-extensions on|off`",
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
    '      "add": ["$HOME/.pi/agent/model-exts/vision-helper", "my-ext"],',
    '      "remove": ["other-ext"]',
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
    "| `/abs`, `~/…`, `$VAR`, `$" + "{VAR}` | Load extension entry from absolute path |",
    "| `name` | Resolve under `<agentDir>/extensions/<name>` (dir or `index.ts`/`index.js`) |",
    "",
    "Relative paths are **rejected**. Same path: load once.",
    "",
    "### remove",
    "",
    "Friendly **names** only (path basename / package dir). Drops matching adds",
    "from this package's load plan. Cannot unload extensions already loaded by Pi.",
    "",
    "## Limits",
    "",
    "- This package **loads** factories; it does not filter Pi's discovery list.",
    "- Keep model-only extensions **out of** always-discovered dirs to avoid double load.",
    "- Switching away from a matching model does **not** unload; use `/reload` or a new session.",
    "- `model_select` only **adds** newly matched paths (missed `session_start` is not replayed).",
  ].join("\n");
}

/**
 * Path refs start with `/`, `~/`, `~`, or `$` (env). Relative paths are rejected later.
 * Everything else is treated as a friendly extension name.
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

export function ruleMatches(match: ModelExtensionsMatch, model: ModelLike): boolean {
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

/** Parse and validate mpi-model-extensions.json body. */
export function parseModelExtensionsConfig(
  raw: unknown,
): { ok: true; config: ModelExtensionsConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config root must be an object" };
  }
  const root = raw as { rules?: unknown; enabled?: unknown; $schema?: unknown };
  if (root.enabled !== undefined && typeof root.enabled !== "boolean") {
    return { ok: false, error: "config.enabled must be a boolean when set" };
  }
  if (root.$schema !== undefined && typeof root.$schema !== "string") {
    return { ok: false, error: "config.$schema must be a string when set" };
  }
  const rulesRaw = root.rules;
  if (!Array.isArray(rulesRaw)) {
    return { ok: false, error: "config.rules must be an array" };
  }

  const rules: ModelExtensionsRule[] = [];
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
    const match: ModelExtensionsMatch = {};
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
  const config: ModelExtensionsConfig = { rules };
  if (typeof root.enabled === "boolean") config.enabled = root.enabled;
  if (typeof root.$schema === "string") config.schemaRef = root.$schema;
  return { ok: true, config };
}

/** On-disk shape: schemaRef goes back under its `$schema` key, first. */
export function serializeModelExtensionsConfig(config: ModelExtensionsConfig): Record<string, unknown> {
  const { schemaRef, ...fields } = config;
  return { ...(schemaRef !== undefined ? { $schema: schemaRef } : {}), ...fields };
}

/** Persist enabled flag; keeps existing rules. Creates file if missing. */
export function setModelExtensionsEnabled(
  agentDir: string,
  enabled: boolean,
): { ok: true; config: ModelExtensionsConfig; path: string } | { ok: false; path: string; error: string } {
  const filePath = modelExtensionsConfigPath(agentDir);
  const current = loadModelExtensionsConfig(agentDir);
  if (!current.ok) {
    return { ok: false, path: current.path, error: current.error };
  }
  const config: ModelExtensionsConfig =
    "missing" in current && current.missing
      ? { enabled, rules: [] }
      : { ...current.config!, enabled };
  try {
    fs.writeFileSync(filePath, `${JSON.stringify(serializeModelExtensionsConfig(config), null, 2)}\n`, "utf8");
    return { ok: true, config, path: filePath };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read config from disk. Missing file is ok (no rules). */
export function loadModelExtensionsConfig(agentDir: string): ConfigLoadResult {
  const filePath = modelExtensionsConfigPath(agentDir);
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
    const parsed = parseModelExtensionsConfig(raw);
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
      // try next
    }
  }
  return { ok: false, error: `no index.ts/js entry in directory: ${absPath}` };
}

/**
 * Friendly name → `<agentDir>/extensions/<name>` (dir or file).
 * Does not search npm package trees — only the agent extensions root.
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
 * Apply matched rules in array order (like model-skills).
 * - remove by friendly name from the planned set (warn if absent)
 * - add by path or name; same path overwrites (keeps latest)
 */
export function planModelExtensionLoads(
  rules: ModelExtensionsRule[],
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
      // Re-insert so later adds win order among duplicates.
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
