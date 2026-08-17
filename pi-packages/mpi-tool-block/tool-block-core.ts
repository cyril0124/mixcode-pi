// +---------------------------------------------------------------------------+
// |  tool-block core                                                          |
// |  Parse <agentDir>/tool-block.json, match hidden tools, plan active set.   |
// +---------------------------------------------------------------------------+
import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_BLOCK_CONFIG_FILENAME = "tool-block.json";

export type ToolBlockHidden = {
  tool: string;
  plugin?: string;
};

export type ToolBlockConfig = {
  enabled: boolean;
  hidden: ToolBlockHidden[];
};

export type ToolRef = {
  name: string;
  plugin: string;
};

export type SourceLike = {
  source?: string;
  path?: string;
};

export type ToolBlockRow =
  | { kind: "enabled" }
  | { kind: "header"; plugin: string }
  | { kind: "tool"; name: string; plugin: string; hidden: boolean; orphan?: boolean };

export type ConfigLoadResult =
  | { ok: true; config: ToolBlockConfig; path: string; missing?: false }
  | { ok: true; config: null; path: string; missing: true }
  | { ok: false; path: string; error: string };

const ALLOWED_ROOT_KEYS = new Set(["enabled", "hidden"]);
const ALLOWED_HIDDEN_KEYS = new Set(["tool", "plugin"]);

/** Config lives at `<agentDir>/tool-block.json`. */
export function toolBlockConfigPath(agentDir: string): string {
  return path.join(agentDir, TOOL_BLOCK_CONFIG_FILENAME);
}

/** Missing config or `enabled !== false` means rules apply. */
export function isToolBlockEnabled(config: ToolBlockConfig | null | undefined): boolean {
  if (!config) return true;
  return config.enabled !== false;
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

/** Parse and validate tool-block.json body. Unknown keys fail loud. */
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
  if (root.hidden !== undefined && !Array.isArray(root.hidden)) {
    return { ok: false, error: "config.hidden must be an array when set" };
  }

  const hidden: ToolBlockHidden[] = [];
  const seen = new Set<string>();
  const hiddenRaw = (root.hidden ?? []) as unknown[];
  for (let i = 0; i < hiddenRaw.length; i++) {
    const item = hiddenRaw[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `hidden[${i}] must be an object` };
    }
    const rec = item as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (!ALLOWED_HIDDEN_KEYS.has(key)) {
        return { ok: false, error: `hidden[${i}] unknown key: ${key}` };
      }
    }
    if (typeof rec.tool !== "string" || !rec.tool.trim()) {
      return { ok: false, error: `hidden[${i}].tool must be a non-empty string` };
    }
    if (rec.plugin !== undefined && (typeof rec.plugin !== "string" || !rec.plugin.trim())) {
      return { ok: false, error: `hidden[${i}].plugin must be a non-empty string when set` };
    }
    const tool = rec.tool.trim();
    if (seen.has(tool)) {
      return { ok: false, error: `duplicate hidden tool: ${tool}` };
    }
    seen.add(tool);
    const plugin = typeof rec.plugin === "string" ? rec.plugin.trim() : "";
    hidden.push(plugin ? { tool, plugin } : { tool });
  }

  return {
    ok: true,
    config: {
      enabled: root.enabled !== false,
      hidden: sortHidden(hidden),
    },
  };
}

export function loadToolBlockConfig(agentDir: string): ConfigLoadResult {
  const filePath = toolBlockConfigPath(agentDir);
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
  agentDir: string,
  config: ToolBlockConfig,
): { ok: true; path: string; config: ToolBlockConfig } | { ok: false; path: string; error: string } {
  const filePath = toolBlockConfigPath(agentDir);
  const normalized: ToolBlockConfig = {
    enabled: config.enabled !== false,
    hidden: sortHidden(config.hidden),
  };
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
    return { ok: true, path: filePath, config: normalized };
  } catch (err) {
    return { ok: false, path: filePath, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hidden tool names when rules apply; empty when disabled or missing. */
export function deniedToolNames(config: ToolBlockConfig | null | undefined): string[] {
  if (!isToolBlockEnabled(config) || !config) return [];
  return config.hidden.map((item) => item.tool);
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

/** Overlay rows: enabled, then tools grouped by plugin, then orphan hidden names. */
export function buildToolBlockRows(
  tools: readonly ToolRef[],
  config: ToolBlockConfig,
): ToolBlockRow[] {
  const hiddenByName = new Set(config.hidden.map((item) => item.tool));
  const rows: ToolBlockRow[] = [{ kind: "enabled" }];
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
    rows.push({
      kind: "tool",
      name: tool.name,
      plugin: "",
      hidden: hiddenByName.has(tool.name),
    });
  }
  for (const [plugin, pluginTools] of grouped) {
    rows.push({ kind: "header", plugin });
    for (const tool of pluginTools) {
      rows.push({
        kind: "tool",
        name: tool.name,
        plugin: tool.plugin,
        hidden: hiddenByName.has(tool.name),
      });
    }
  }
  const orphans = config.hidden
    .filter((item) => !seen.has(item.tool))
    .sort((a, b) => pluginKey(a).localeCompare(pluginKey(b)) || a.tool.localeCompare(b.tool));
  let orphanPlugin: string | undefined;
  for (const item of orphans) {
    const plugin = item.plugin ?? "";
    if (plugin && plugin !== orphanPlugin) {
      orphanPlugin = plugin;
      rows.push({ kind: "header", plugin });
    }
    rows.push({ kind: "tool", name: item.tool, plugin, hidden: true, orphan: true });
  }
  return rows;
}

/** Keep matching tools and their plugin headers. Empty query returns all rows. */
export function filterToolBlockRows(rows: readonly ToolBlockRow[], query: string): ToolBlockRow[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...rows];
  const out: ToolBlockRow[] = [];
  let header: Extract<ToolBlockRow, { kind: "header" }> | undefined;
  for (const row of rows) {
    if (row.kind === "enabled") {
      if ("enabled".includes(q)) out.push(row);
      header = undefined;
      continue;
    }
    if (row.kind === "header") {
      header = row;
      continue;
    }
    if (row.name.toLowerCase().includes(q) || row.plugin.toLowerCase().includes(q)) {
      if (header) {
        out.push(header);
        header = undefined;
      }
      out.push(row);
    }
  }
  return out;
}

/** Flip enabled or one tool's hidden flag. `tools` supplies plugin tags when hiding. */
export function toggleToolBlockRow(
  config: ToolBlockConfig,
  tools: readonly ToolRef[],
  row: Extract<ToolBlockRow, { kind: "enabled" | "tool" }>,
): ToolBlockConfig {
  if (row.kind === "enabled") {
    return { enabled: !config.enabled, hidden: [...config.hidden] };
  }
  if (config.hidden.some((item) => item.tool === row.name)) {
    return { enabled: config.enabled, hidden: config.hidden.filter((item) => item.tool !== row.name) };
  }
  const plugin =
    tools.find((item) => item.name === row.name)?.plugin ??
    config.hidden.find((item) => item.tool === row.name)?.plugin ??
    row.plugin ??
    "";
  return {
    enabled: config.enabled,
    hidden: sortHidden([...config.hidden, plugin ? { tool: row.name, plugin } : { tool: row.name }]),
  };
}

function pluginKey(item: { plugin?: string }): string {
  return item.plugin ?? "";
}

function sortHidden(hidden: ToolBlockHidden[]): ToolBlockHidden[] {
  return [...hidden].sort((a, b) => pluginKey(a).localeCompare(pluginKey(b)) || a.tool.localeCompare(b.tool));
}
