// +---------------------------------------------------------------------------+
// |  tool-block core                                                          |
// |  Parse config files (global + project union; session replaces),           |
// |  plan active set.                                                         |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_BLOCK_CONFIG_FILENAME = "mpi-tool-block.json";

/** Config used for a layer that has no file yet. */
export const EMPTY_TOOL_BLOCK_CONFIG: ToolBlockConfig = { enabled: true, hidden: [] };

export type ToolBlockConfig = {
  /** `false` keeps `hidden` and makes this layer contribute no hides. */
  enabled: boolean;
  /** Tool names removed from the active set while enabled. Names are globally unique. */
  hidden: string[];
  /** Editor `$schema` reference; ignored by behavior, preserved on write. */
  schemaRef?: string;
};

export type ToolRef = {
  name: string;
  plugin: string;
};

export type SourceLike = {
  source?: string;
  path?: string;
};

export type ToolBlockLayer = "global" | "project" | "session";

export type ToolBlockRow =
  | { kind: "layer" }
  | { kind: "enabled" }
  | { kind: "header"; label: string }
  | { kind: "tool"; name: string; plugin: string; hidden: boolean; inactive?: boolean };

export type ToolBlockToolState = "hidden" | "visible" | "inactive";

export type ConfigLoadResult =
  | { ok: true; config: ToolBlockConfig; path: string; missing?: false }
  | { ok: true; config: null; path: string; missing: true }
  | { ok: false; path: string; error: string };

const ALLOWED_ROOT_KEYS = new Set(["enabled", "hidden", "$schema"]);

/** Header for hidden names that are no longer registered (renamed or removed plugin). */
const ORPHAN_HIDDEN_LABEL = "not registered";

/** Config lives at `<agentDir>/mpi-tool-block.json`. */
export function toolBlockConfigPath(agentDir: string): string {
  return path.join(agentDir, TOOL_BLOCK_CONFIG_FILENAME);
}

/** Project config lives at `<cwd>/<configDirName>/mpi-tool-block.json` (e.g. `.pi`). */
export function projectToolBlockConfigPath(cwd: string, configDirName: string): string {
  return path.join(cwd, configDirName, TOOL_BLOCK_CONFIG_FILENAME);
}

/** Missing config or `enabled !== false` means rules apply. */
export function isToolBlockEnabled(config: ToolBlockConfig | null | undefined): boolean {
  if (!config) return true;
  return config.enabled !== false;
}

/**
 * Union of the hidden names of every enabled layer.
 * A layer with `enabled: false` contributes nothing, so it never cancels another layer.
 */
export function mergeToolBlockConfigs(layers: readonly ToolBlockConfig[]): ToolBlockConfig {
  const hidden = new Set<string>();
  for (const layer of layers) {
    if (!isToolBlockEnabled(layer)) continue;
    for (const name of layer.hidden) hidden.add(name);
  }
  return { enabled: true, hidden: sortHidden([...hidden]) };
}

/**
 * Extension label for overlay grouping / persist.
 * Only `npm:<pkg>` and `.../extensions/<name>/`. Everything else is untagged.
 */
export function pluginTag(info: SourceLike): string {
  const src = (info.source ?? "").trim();
  if (src.startsWith("npm:")) {
    const pkg = src.slice(4).trim();
    if (pkg) return pkg;
  }
  const extMatch = (info.path ?? "").match(/[/\\]extensions[/\\]([^/\\]+)[/\\]/);
  return extMatch?.[1] ?? "";
}

export function toToolRefs(
  tools: ReadonlyArray<{ name: string; sourceInfo?: SourceLike }>,
): ToolRef[] {
  return tools.map((tool) => ({
    name: tool.name,
    plugin: pluginTag(tool.sourceInfo ?? {}),
  }));
}

/** Parse and validate mpi-tool-block.json body. Unknown keys fail loud. */
export function parseToolBlockConfig(
  raw: unknown,
): { ok: true; config: ToolBlockConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "config root must be an object" };
  }
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) {
    if (!ALLOWED_ROOT_KEYS.has(key)) {
      return { ok: false, error: `unknown key: ${key}` };
    }
  }
  if (root.enabled !== undefined && typeof root.enabled !== "boolean") {
    return { ok: false, error: "config.enabled must be a boolean when set" };
  }
  if (root.$schema !== undefined && typeof root.$schema !== "string") {
    return { ok: false, error: "config.$schema must be a string when set" };
  }
  if (root.hidden !== undefined && !Array.isArray(root.hidden)) {
    return { ok: false, error: "config.hidden must be an array when set" };
  }

  const hidden: string[] = [];
  const seen = new Set<string>();
  const hiddenRaw = (root.hidden ?? []) as unknown[];
  for (let i = 0; i < hiddenRaw.length; i++) {
    const rawName = hiddenRaw[i];
    if (typeof rawName !== "string" || !rawName.trim()) {
      return { ok: false, error: `hidden[${i}] must be a non-empty tool name` };
    }
    const tool = rawName.trim();
    if (seen.has(tool)) {
      return { ok: false, error: `duplicate hidden tool: ${tool}` };
    }
    seen.add(tool);
    hidden.push(tool);
  }

  return {
    ok: true,
    config: {
      enabled: root.enabled !== false,
      hidden: sortHidden(hidden),
      ...(typeof root.$schema === "string" ? { schemaRef: root.$schema } : {}),
    },
  };
}

export function loadToolBlockConfig(filePath: string): ConfigLoadResult {
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
    const parsed = parseToolBlockConfig(raw);
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

export function writeToolBlockConfig(
  filePath: string,
  config: ToolBlockConfig,
):
  | { ok: true; path: string; config: ToolBlockConfig }
  | { ok: false; path: string; error: string } {
  const normalized: ToolBlockConfig = {
    enabled: config.enabled !== false,
    hidden: sortHidden(config.hidden),
    ...(config.schemaRef !== undefined ? { schemaRef: config.schemaRef } : {}),
  };
  // Serialize explicitly so schemaRef is written under its on-disk `$schema` key.
  const out = {
    ...(normalized.schemaRef !== undefined ? { $schema: normalized.schemaRef } : {}),
    enabled: normalized.enabled,
    hidden: normalized.hidden,
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(out, null, 2)}\n`, "utf8");
    return { ok: true, path: filePath, config: normalized };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hidden tool names when rules apply; empty when disabled or missing. */
export function deniedToolNames(config: ToolBlockConfig | null | undefined): string[] {
  if (!isToolBlockEnabled(config) || !config) return [];
  return [...config.hidden];
}

/**
 * A session config replaces both file layers while it exists. Global and project
 * merge: the hidden set is their union, so a project file adds hides without
 * restating the global list. `project` is null unless the project is trusted.
 */
export function effectiveToolBlockConfig(input: {
  global: ToolBlockConfig | null;
  project?: ToolBlockConfig | null;
  session?: ToolBlockConfig | null;
}): ToolBlockConfig | null {
  if (input.session) return input.session;
  const layers = [input.global, input.project ?? null].filter(
    (layer): layer is ToolBlockConfig => layer !== null,
  );
  return layers.length > 0 ? mergeToolBlockConfigs(layers) : null;
}

/**
 * Compute the next active tool list.
 * Only restores names previously removed by this package; never activates
 * unrelated registered tools (e.g. inactive goal tools).
 */
export function planActiveTools(input: {
  active: readonly string[];
  registered: readonly string[];
  denied: readonly string[];
  previouslyRemoved: readonly string[];
}): { next: string[]; removed: string[] } {
  const registered = new Set(input.registered);
  const denied = [...input.denied].filter((name) => registered.has(name));
  const deniedSet = new Set(denied);
  const wasActive = new Set(input.active);
  const previouslyRemoved = new Set(input.previouslyRemoved);
  const next = input.active.filter((name) => !deniedSet.has(name));
  const have = new Set(next);
  for (const name of previouslyRemoved) {
    if (!deniedSet.has(name) && registered.has(name) && !have.has(name)) {
      next.push(name);
      have.add(name);
    }
  }
  // Only names we actually took off the active set (this turn or earlier).
  // Do not claim inactive registered tools — unhide must not activate them.
  const removed = denied.filter((name) => wasActive.has(name) || previouslyRemoved.has(name));
  return { next, removed };
}

export function sameToolNames(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((name, index) => name === right[index]);
}

/** Overlay display state. Hidden wins over active/inactive. */
export function toolBlockRowState(
  row: Extract<ToolBlockRow, { kind: "tool" }>,
): ToolBlockToolState {
  if (row.hidden) return "hidden";
  if (row.inactive) return "inactive";
  return "visible";
}

/**
 * Overlay rows: layer, enabled, then registered tools grouped by live plugin tag,
 * then hidden names that are no longer registered (orphans).
 * Tool names are globally unique in the Pi registry, so hiding is keyed by name alone;
 * the plugin tag is only a display label, never part of the persisted config.
 */
export function buildToolBlockRows(
  tools: readonly ToolRef[],
  config: ToolBlockConfig,
  active: readonly string[],
): ToolBlockRow[] {
  const hiddenByName = new Set(config.hidden);
  const activeSet = new Set(active);
  const rows: ToolBlockRow[] = [{ kind: "layer" }, { kind: "enabled" }];
  const seen = new Set<string>();
  const ungrouped: ToolRef[] = [];
  const grouped = new Map<string, ToolRef[]>();
  const sortedTools = [...tools].sort((a, b) => {
    const pluginCmp = a.plugin.localeCompare(b.plugin);
    return pluginCmp !== 0 ? pluginCmp : a.name.localeCompare(b.name);
  });
  for (const tool of sortedTools) {
    seen.add(tool.name);
    if (!tool.plugin) {
      ungrouped.push(tool);
      continue;
    }
    const list = grouped.get(tool.plugin) ?? [];
    list.push(tool);
    grouped.set(tool.plugin, list);
  }
  for (const tool of ungrouped) {
    rows.push(toolRow(tool.name, "", hiddenByName, activeSet));
  }
  for (const [plugin, pluginTools] of grouped) {
    rows.push({ kind: "header", label: plugin });
    for (const tool of pluginTools) {
      rows.push(toolRow(tool.name, tool.plugin, hiddenByName, activeSet));
    }
  }
  const orphans = config.hidden
    .filter((name) => !seen.has(name))
    .sort((a, b) => a.localeCompare(b));
  if (orphans.length > 0) {
    rows.push({ kind: "header", label: ORPHAN_HIDDEN_LABEL });
    for (const name of orphans) {
      rows.push({ kind: "tool", name, plugin: "", hidden: true, inactive: false });
    }
  }
  return rows;
}

/** Keep matching tools and their plugin headers. Empty query returns all rows. Layer stays visible. */
export function filterToolBlockRows(rows: readonly ToolBlockRow[], query: string): ToolBlockRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const out: ToolBlockRow[] = [];
  let header: Extract<ToolBlockRow, { kind: "header" }> | undefined;
  for (const row of rows) {
    if (row.kind === "layer") {
      out.push(row);
      continue;
    }
    if (row.kind === "enabled") {
      if ("enabled".includes(q)) out.push(row);
      header = undefined;
      continue;
    }
    if (row.kind === "header") {
      header = row;
      continue;
    }
    const state = toolBlockRowState(row);
    if (
      row.name.toLowerCase().includes(q) ||
      row.plugin.toLowerCase().includes(q) ||
      state.includes(q)
    ) {
      if (header) {
        out.push(header);
        header = undefined;
      }
      out.push(row);
    }
  }
  return out;
}

/** Flip enabled or one tool's hidden flag. */
export function toggleToolBlockRow(
  config: ToolBlockConfig,
  row: { kind: "enabled" } | { kind: "tool"; name: string },
): ToolBlockConfig {
  if (row.kind === "enabled") {
    return { ...config, enabled: !config.enabled, hidden: [...config.hidden] };
  }
  if (config.hidden.includes(row.name)) {
    return { ...config, hidden: config.hidden.filter((name) => name !== row.name) };
  }
  return {
    ...config,
    hidden: sortHidden([...config.hidden, row.name]),
  };
}

function toolRow(
  name: string,
  plugin: string,
  hiddenByName: Set<string>,
  activeSet: Set<string>,
): Extract<ToolBlockRow, { kind: "tool" }> {
  const hidden = hiddenByName.has(name);
  return { kind: "tool", name, plugin, hidden, inactive: !hidden && !activeSet.has(name) };
}

function sortHidden(hidden: string[]): string[] {
  return [...hidden].sort((a, b) => a.localeCompare(b));
}
