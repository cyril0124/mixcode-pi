// +---------------------------------------------------------------------------+
// |  permission core                                                          |
// |  Parse permission.json, match wildcard rules, evaluate tool calls.        |
// |                                                                           |
// |  Layers: global -> project -> session, concatenated per key;              |
// |  last matching rule wins. Unmatched calls default to "allow".             |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as path from "node:path";

export const PERMISSION_CONFIG_FILENAME = "permission.json";
export const DOOM_LOOP_THRESHOLD = 3;

export type PermissionAction = "allow" | "ask" | "deny";

export type PermissionRule = {
  pattern: string;
  action: PermissionAction;
};

/** Ordered rules for one config key (tool name, "*", or "external_directory"). */
export type ToolRuleSet = {
  tool: string;
  rules: PermissionRule[];
};

export type PermissionConfig = {
  /** Insertion-ordered key entries; order matters for last-match-wins. */
  entries: ToolRuleSet[];
  /** Absent means the doom-loop guard is off. */
  doomLoop?: PermissionAction;
  /** Editor `$schema` reference; ignored by evaluation, preserved on write. */
  schemaRef?: string;
};

export type PermissionLayer = "global" | "project" | "session";

export type LayeredConfig = {
  layer: PermissionLayer;
  config: PermissionConfig;
};

export type PermissionSource = {
  kind: "tool" | "external_directory" | "doom_loop";
  layer: PermissionLayer;
  /** Matched config key ("bash", "*", "external_directory", "doom_loop"). */
  tool: string;
  pattern: string;
  /** Subject that triggered the rule (command segment, path, pattern, ...). */
  subject: string;
};

export type PermissionDecision = {
  action: PermissionAction;
  /** Undefined only for the implicit unmatched-allow default. */
  source?: PermissionSource;
};

export type ToolCallSubject =
  | { kind: "commands"; segments: string[] }
  | { kind: "path"; path: string }
  | { kind: "pattern"; pattern: string }
  | { kind: "raw"; text: string };

export type ConfigLoadResult =
  | { ok: true; config: PermissionConfig; path: string; missing?: false }
  | { ok: true; config: null; path: string; missing: true }
  | { ok: false; path: string; error: string };

const ACTIONS: ReadonlySet<string> = new Set(["allow", "ask", "deny"]);
const SEVERITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 };

export const DOOM_LOOP_KEY = "doom_loop";
export const EXTERNAL_DIRECTORY_KEY = "external_directory";

// ---------------------------------------------------------------------------
// Config paths / IO
// ---------------------------------------------------------------------------

/** Global config lives at `<agentDir>/permission.json`. */
export function permissionConfigPath(agentDir: string): string {
  return path.join(agentDir, PERMISSION_CONFIG_FILENAME);
}

/** Project config lives at `<cwd>/<configDirName>/permission.json` (e.g. `.pi`). */
export function projectPermissionConfigPath(cwd: string, configDirName: string): string {
  return path.join(cwd, configDirName, PERMISSION_CONFIG_FILENAME);
}

export function loadPermissionConfig(filePath: string): ConfigLoadResult {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, config: null, path: filePath, missing: true };
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
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
  const parsed = parsePermissionConfig(raw);
  if (!parsed.ok) return { ok: false, path: filePath, error: parsed.error };
  return { ok: true, config: parsed.config, path: filePath };
}

export function writePermissionConfig(
  filePath: string,
  config: PermissionConfig,
): { ok: true; path: string } | { ok: false; path: string; error: string } {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(serializePermissionConfig(config), null, 2)}\n`, "utf8");
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Parse / serialize
// ---------------------------------------------------------------------------

/**
 * Parse a permission config body. Fail loud on any unknown shape:
 * root is an action string or an object of `key -> action | { pattern -> action }`.
 * `doom_loop` accepts an action string only.
 */
export function parsePermissionConfig(
  raw: unknown,
): { ok: true; config: PermissionConfig } | { ok: false; error: string } {
  if (typeof raw === "string") {
    if (!ACTIONS.has(raw)) return { ok: false, error: `invalid action: ${JSON.stringify(raw)}` };
    return {
      ok: true,
      config: { entries: [{ tool: "*", rules: [{ pattern: "*", action: raw as PermissionAction }] }] },
    };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config root must be an action string or an object" };
  }
  const entries: ToolRuleSet[] = [];
  let doomLoop: PermissionAction | undefined;
  let schemaRef: string | undefined;
  for (const [key, value] of Object.entries(raw)) {
    if (!key.trim()) return { ok: false, error: "config keys must be non-empty" };
    if (key === "$schema") {
      if (typeof value !== "string") return { ok: false, error: "$schema must be a string" };
      schemaRef = value;
      continue;
    }
    if (key === DOOM_LOOP_KEY) {
      if (typeof value !== "string" || !ACTIONS.has(value)) {
        return { ok: false, error: `${DOOM_LOOP_KEY} must be "allow" | "ask" | "deny"` };
      }
      doomLoop = value as PermissionAction;
      continue;
    }
    if (typeof value === "string") {
      if (!ACTIONS.has(value)) {
        return { ok: false, error: `${JSON.stringify(key)}: invalid action ${JSON.stringify(value)}` };
      }
      entries.push({ tool: key, rules: [{ pattern: "*", action: value as PermissionAction }] });
      continue;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: `${JSON.stringify(key)}: value must be an action string or a pattern object` };
    }
    const rules: PermissionRule[] = [];
    for (const [pattern, action] of Object.entries(value)) {
      if (!pattern) return { ok: false, error: `${JSON.stringify(key)}: patterns must be non-empty` };
      if (typeof action !== "string" || !ACTIONS.has(action)) {
        return {
          ok: false,
          error: `${JSON.stringify(key)}[${JSON.stringify(pattern)}]: invalid action ${JSON.stringify(action)}`,
        };
      }
      rules.push({ pattern, action: action as PermissionAction });
    }
    if (rules.length === 0) return { ok: false, error: `${JSON.stringify(key)}: rules object must not be empty` };
    entries.push({ tool: key, rules });
  }
  return {
    ok: true,
    config: {
      entries,
      ...(doomLoop ? { doomLoop } : {}),
      ...(schemaRef !== undefined ? { schemaRef } : {}),
    },
  };
}

/** Inverse of parse: single `*` rule collapses to the string shorthand. */
export function serializePermissionConfig(config: PermissionConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (config.schemaRef !== undefined) out.$schema = config.schemaRef;
  for (const entry of config.entries) {
    if (entry.rules.length === 1 && entry.rules[0]!.pattern === "*") {
      out[entry.tool] = entry.rules[0]!.action;
      continue;
    }
    const rules: Record<string, string> = {};
    for (const rule of entry.rules) rules[rule.pattern] = rule.action;
    out[entry.tool] = rules;
  }
  if (config.doomLoop) out[DOOM_LOOP_KEY] = config.doomLoop;
  return out;
}

export function emptyPermissionConfig(): PermissionConfig {
  return { entries: [] };
}

export function hasAnyRules(config: PermissionConfig): boolean {
  return config.entries.length > 0 || config.doomLoop !== undefined;
}

// ---------------------------------------------------------------------------
// Wildcard matching
// ---------------------------------------------------------------------------

/** Expand a leading `~` or `$HOME` in a pattern to the home directory. */
export function expandHomeInPattern(pattern: string, home: string): string {
  if (pattern === "~" || pattern.startsWith("~/")) return home + pattern.slice(1);
  if (pattern === "$HOME" || pattern.startsWith("$HOME/")) return home + pattern.slice(5);
  return pattern;
}

/** Anchored wildcard match: `*` = zero or more chars, `?` = exactly one. */
export function matchesPattern(pattern: string, subject: string): boolean {
  let regex = "";
  for (const ch of pattern) {
    if (ch === "*") regex += ".*";
    else if (ch === "?") regex += ".";
    else regex += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${regex}$`, "s").test(subject);
}

/**
 * Candidates a path subject is matched under: the absolute path plus its
 * cwd-relative form, so `packages/*` (relative) and `*.env` (bare) both work.
 */
export function pathCandidates(absPath: string, cwd: string): string[] {
  const rel = path.relative(cwd, absPath);
  return [absPath, rel === "" ? "." : rel];
}

/** True when the resolved path escapes the working directory. */
export function isOutsideCwd(absPath: string, cwd: string): boolean {
  const rel = path.relative(cwd, absPath);
  if (rel === "") return false;
  return rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

/**
 * Match one pattern against subject candidates. Absolute patterns (after home
 * expansion) only match the absolute candidate; relative patterns match any.
 */
function patternMatchesCandidates(pattern: string, candidates: readonly string[], home: string): boolean {
  const expanded = expandHomeInPattern(pattern, home);
  const pool = path.isAbsolute(expanded)
    ? candidates.filter((candidate) => path.isAbsolute(candidate))
    : candidates;
  return pool.some((candidate) => matchesPattern(expanded, candidate));
}

// ---------------------------------------------------------------------------
// Bash command normalization
// ---------------------------------------------------------------------------

const TRANSPARENT_BASH_PREFIXES: ReadonlySet<string> = new Set([
  "sudo",
  "env",
  "command",
  "builtin",
  "exec",
]);

/**
 * Split a bash command into normalized segments for rule matching:
 * heredoc bodies and comments are stripped, the script is split on
 * `\n ; | && ||`, each segment is tokenized (quotes removed) and rejoined
 * with single spaces, and leading env assignments / transparent wrappers are dropped.
 */
export function splitBashCommand(command: string): string[] {
  const segments: string[] = [];
  for (const piece of stripComments(stripHeredocs(command)).split(/\n|&&|\|\||[|;]/)) {
    const tokens = tokenize(piece.trim());
    let start = 0;
    while (
      start < tokens.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[start]!) || TRANSPARENT_BASH_PREFIXES.has(tokens[start]!))
    ) {
      start++;
    }
    const rest = tokens.slice(start);
    if (rest.length > 0) segments.push(rest.join(" "));
  }
  return segments;
}

/** Heredoc delimiters outside quotes and comments, in shell consumption order. */
function heredocDelimiters(line: string): string[] {
  const delimiters: string[] = [];
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (inSingle || inDouble) continue;
    if (ch === "#" && (i === 0 || /\s/.test(line[i - 1]!))) break;
    if (ch !== "<" || line[i - 1] === "<") continue;
    const match = line.slice(i).match(/^<<-?\s*['"]?(\w+)['"]?/);
    if (!match) continue; // Includes `<<<` here-strings.
    delimiters.push(match[1]!);
    i += match[0].length - 1;
  }
  return delimiters;
}

/** Strip heredoc bodies (`<< DELIM ... DELIM`) so they are not seen as commands. */
function stripHeredocs(input: string): string {
  const lines = input.split("\n");
  const result: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    result.push(line);
    i++;
    for (const delimiter of heredocDelimiters(line)) {
      while (i < lines.length && lines[i]!.trim() !== delimiter) i++;
      if (i < lines.length) i++; // Skip the delimiter line itself.
    }
  }
  return result.join("\n");
}

/** Remove `#` comments outside quotes (only when preceded by start/whitespace). */
function stripComments(input: string): string {
  return input
    .split("\n")
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      let esc = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]!;
        if (esc) {
          esc = false;
          continue;
        }
        if (ch === "\\" && !inSingle) {
          esc = true;
          continue;
        }
        if (ch === "'" && !inDouble) inSingle = !inSingle;
        else if (ch === '"' && !inSingle) inDouble = !inDouble;
        else if (ch === "#" && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]!))) {
          return line.slice(0, i);
        }
      }
      return line;
    })
    .join("\n");
}

/** Minimal shell tokenizer: splits on whitespace, respects quotes and escapes. */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let esc = false;
  for (const ch of input) {
    if (esc) {
      cur += ch;
      esc = false;
      continue;
    }
    if (ch === "\\" && !inSingle) {
      esc = true;
      continue;
    }
    if (ch === "'" && !inDouble) {
      if (!inSingle && cur.endsWith("$")) cur = cur.slice(0, -1);
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }
    if (/\s/.test(ch) && !inSingle && !inDouble) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

// ---------------------------------------------------------------------------
// Subject extraction
// ---------------------------------------------------------------------------

/** What a tool call is matched by. Unknown tools match their JSON input. */
export function extractSubject(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): ToolCallSubject {
  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    return { kind: "commands", segments: splitBashCommand(command) };
  }
  if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls") {
    const raw = typeof input.path === "string" && input.path.trim() ? input.path : ".";
    return { kind: "path", path: path.resolve(cwd, raw) };
  }
  if (toolName === "grep" || toolName === "find") {
    return { kind: "pattern", pattern: typeof input.pattern === "string" ? input.pattern : "" };
  }
  return { kind: "raw", text: JSON.stringify(input) };
}

function realpathExisting(absPath: string): string {
  let candidate = path.resolve(absPath);
  const missingSegments: string[] = [];
  for (;;) {
    try {
      return path.resolve(fs.realpathSync(candidate), ...missingSegments.reverse());
    } catch (err) {
      const parent = path.dirname(candidate);
      if (parent === candidate) {
        // The filesystem root itself is unavailable; preserve the lexical path
        // so the caller still performs a deterministic containment check.
        return path.resolve(absPath);
      }
      if (!(err instanceof Error)) throw err;
      missingSegments.push(path.basename(candidate));
      candidate = parent;
    }
  }
}

/**
 * Path this call touches for the external-directory guard, or null.
 * Existing ancestors are realpathed so a symlink inside cwd cannot hide an
 * external target; missing trailing segments are appended after resolution.
 * Bash commands are not inspected for paths (documented limitation).
 */
export function externalPathOf(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
): string | null {
  let raw: string | undefined;
  if (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls") {
    raw = typeof input.path === "string" && input.path.trim() ? input.path : ".";
  } else if (toolName === "grep" || toolName === "find") {
    raw = typeof input.path === "string" && input.path.trim() ? input.path : undefined;
  }
  if (raw === undefined) return null;
  const realCwd = realpathExisting(cwd);
  const abs = realpathExisting(path.resolve(cwd, raw));
  return isOutsideCwd(abs, realCwd) ? abs : null;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

type LayeredRule = { layer: PermissionLayer; tool: string; rule: PermissionRule };

/** All rules for one key, in layer order (global -> project -> session). */
function rulesForKey(layers: readonly LayeredConfig[], key: string): LayeredRule[] {
  const out: LayeredRule[] = [];
  for (const { layer, config } of layers) {
    for (const entry of config.entries) {
      if (entry.tool !== key) continue;
      for (const rule of entry.rules) out.push({ layer, tool: key, rule });
    }
  }
  return out;
}

/** Last matching rule wins. Returns null when nothing matches. */
function lastMatch(
  rules: readonly LayeredRule[],
  candidates: readonly string[],
  home: string,
): LayeredRule | null {
  let matched: LayeredRule | null = null;
  for (const layered of rules) {
    if (patternMatchesCandidates(layered.rule.pattern, candidates, home)) matched = layered;
  }
  return matched;
}

/** Tool rules first; the `*` key is the fallback when the tool key has no match. */
function evaluateKey(
  layers: readonly LayeredConfig[],
  key: string,
  candidates: readonly string[],
  subject: string,
  home: string,
  kind: PermissionSource["kind"],
): PermissionDecision {
  const specific = lastMatch(rulesForKey(layers, key), candidates, home);
  const winner =
    specific ?? (kind === "tool" ? lastMatch(rulesForKey(layers, "*"), candidates, home) : null);
  if (!winner) return { action: "allow" };
  return {
    action: winner.rule.action,
    source: { kind, layer: winner.layer, tool: winner.tool, pattern: winner.rule.pattern, subject },
  };
}

/** Doom-loop action comes from the last layer that sets it. */
export function doomLoopAction(layers: readonly LayeredConfig[]): {
  action: PermissionAction;
  layer: PermissionLayer;
} | null {
  let found: { action: PermissionAction; layer: PermissionLayer } | null = null;
  for (const { layer, config } of layers) {
    if (config.doomLoop) found = { action: config.doomLoop, layer };
  }
  return found;
}

function moreSevere(a: PermissionDecision, b: PermissionDecision): PermissionDecision {
  return SEVERITY[b.action] > SEVERITY[a.action] ? b : a;
}

/**
 * Evaluate one tool call against the layered config.
 * Combines the per-tool rule, the external-directory guard, and the doom-loop
 * guard by taking the most severe action (deny > ask > allow). `doomCount` is
 * the number of consecutive identical calls including this one.
 */
export function evaluateToolCall(args: {
  layers: readonly LayeredConfig[];
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  home: string;
  doomCount?: number;
}): PermissionDecision {
  const { layers, toolName, input, cwd, home } = args;
  const subject = extractSubject(toolName, input, cwd);

  let decision: PermissionDecision = { action: "allow" };
  if (subject.kind === "commands") {
    for (const segment of subject.segments) {
      decision = moreSevere(decision, evaluateKey(layers, toolName, [segment], segment, home, "tool"));
    }
  } else if (subject.kind === "path") {
    const candidates = pathCandidates(subject.path, cwd);
    decision = evaluateKey(layers, toolName, candidates, subject.path, home, "tool");
  } else {
    const text = subject.kind === "pattern" ? subject.pattern : subject.text;
    decision = evaluateKey(layers, toolName, [text], text, home, "tool");
  }

  const externalPath = externalPathOf(toolName, input, cwd);
  if (externalPath !== null) {
    decision = moreSevere(
      decision,
      evaluateKey(
        layers,
        EXTERNAL_DIRECTORY_KEY,
        pathCandidates(externalPath, cwd),
        externalPath,
        home,
        "external_directory",
      ),
    );
  }

  const doom = doomLoopAction(layers);
  if (doom && (args.doomCount ?? 0) >= DOOM_LOOP_THRESHOLD) {
    decision = moreSevere(decision, {
      action: doom.action,
      source: {
        kind: "doom_loop",
        layer: doom.layer,
        tool: DOOM_LOOP_KEY,
        pattern: DOOM_LOOP_KEY,
        subject: toolName,
      },
    });
  }
  return decision;
}

/** Consecutive-identical-call counter for the doom-loop guard. */
export function createDoomLoopTracker(): {
  record(toolName: string, input: unknown): number;
  reset(): void;
} {
  let lastSignature: string | null = null;
  let count = 0;
  return {
    record(toolName, input) {
      let serialized: string;
      try {
        serialized = JSON.stringify(input) ?? "";
      } catch {
        // Non-serializable input cannot repeat verbatim; treat as unique.
        serialized = `unique:${Date.now()}:${Math.random()}`;
      }
      const signature = `${toolName}\u0000${serialized}`;
      count = signature === lastSignature ? count + 1 : 1;
      lastSignature = signature;
      return count;
    },
    reset() {
      lastSignature = null;
      count = 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Mutation helpers (overlay editing)
// ---------------------------------------------------------------------------

const ACTION_CYCLE: PermissionAction[] = ["allow", "ask", "deny"];

export function cycleAction(action: PermissionAction): PermissionAction {
  return ACTION_CYCLE[(ACTION_CYCLE.indexOf(action) + 1) % ACTION_CYCLE.length]!;
}

/** Append a rule to a key (created at the end when missing). Appending wins. */
export function addRule(
  config: PermissionConfig,
  tool: string,
  pattern: string,
  action: PermissionAction,
): PermissionConfig {
  const entries = config.entries.map((entry) =>
    entry.tool === tool ? { tool: entry.tool, rules: [...entry.rules, { pattern, action }] } : entry,
  );
  if (!config.entries.some((entry) => entry.tool === tool)) {
    entries.push({ tool, rules: [{ pattern, action }] });
  }
  return { ...config, entries };
}

/** Remove one rule; a key with no rules left disappears entirely. */
export function removeRule(config: PermissionConfig, tool: string, index: number): PermissionConfig {
  const entries = config.entries
    .map((entry) =>
      entry.tool === tool
        ? { tool: entry.tool, rules: entry.rules.filter((_, i) => i !== index) }
        : entry,
    )
    .filter((entry) => entry.rules.length > 0);
  return { ...config, entries };
}

export function cycleRuleAction(config: PermissionConfig, tool: string, index: number): PermissionConfig {
  const entries = config.entries.map((entry) =>
    entry.tool === tool
      ? {
          tool: entry.tool,
          rules: entry.rules.map((rule, i) =>
            i === index ? { pattern: rule.pattern, action: cycleAction(rule.action) } : rule,
          ),
        }
      : entry,
  );
  return { ...config, entries };
}

/** Cycle doom_loop through off -> ask -> deny -> allow -> off. */
export function cycleDoomLoop(config: PermissionConfig): PermissionConfig {
  const next: PermissionAction | undefined =
    config.doomLoop === undefined
      ? "ask"
      : config.doomLoop === "ask"
        ? "deny"
        : config.doomLoop === "deny"
          ? "allow"
          : undefined;
  // Rest spread keeps schemaRef and entries intact.
  const { doomLoop: _dropped, ...rest } = config;
  return next ? { ...rest, doomLoop: next } : { ...rest };
}
