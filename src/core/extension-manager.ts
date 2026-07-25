import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoadExtensionsResult, SourceInfo } from "@earendil-works/pi-coding-agent";

export const EXTENSION_MANAGER_FILE = "extension_manager.json";

export interface ExtensionManagerConfig {
  version: 1;
  disabledExtensionKeys: string[];
}

export interface ExtensionManagerEntry {
  key: string;
  enabled: boolean;
  path: string;
  resolvedPath: string;
  source: string;
  scope: string;
  origin: string;
  baseDir?: string;
  toolCount: number;
  commandCount: number;
  /** Sorted tool names provided by this extension (empty for failed loads). */
  toolNames: string[];
  /** Sorted command names provided by this extension (empty for failed loads). */
  commandNames: string[];
  error?: string;
}

export interface ExtensionReloadResult {
  sessionId: string;
  title: string;
  status: "reloaded" | "skipped" | "error";
  reason?: string;
}

export function extensionManagerFile(stateDir: string): string {
  return join(stateDir, EXTENSION_MANAGER_FILE);
}

export async function loadExtensionManagerConfig(
  filePath: string,
): Promise<ExtensionManagerConfig> {
  try {
    const raw = await readFile(filePath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return normalizeExtensionManagerConfig(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultExtensionManagerConfig();
    throw error;
  }
}

export async function saveExtensionManagerConfig(
  filePath: string,
  config: ExtensionManagerConfig,
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const normalized = normalizeExtensionManagerConfig(config);
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  await rename(temp, filePath);
}

export function defaultExtensionManagerConfig(): ExtensionManagerConfig {
  return { version: 1, disabledExtensionKeys: [] };
}

export function normalizeExtensionManagerConfig(value: unknown): ExtensionManagerConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultExtensionManagerConfig();
  }
  const data = value as Record<string, unknown>;
  const disabledExtensionKeys = Array.isArray(data.disabledExtensionKeys)
    ? [...new Set(data.disabledExtensionKeys.map(String).filter((key) => key.trim()))].sort()
    : [];
  return { version: 1, disabledExtensionKeys };
}

export function extensionKeyFromSourceInfo(sourceInfo: SourceInfo): string {
  return [
    sourceInfo.scope || "unknown",
    sourceInfo.source || "unknown",
    sourceInfo.origin || "unknown",
    sourceInfo.path || "unknown",
  ].join(":");
}

export function filterDisabledExtensions(
  result: LoadExtensionsResult,
  disabledKeys: ReadonlySet<string>,
): LoadExtensionsResult {
  if (disabledKeys.size === 0) return result;
  result.extensions = result.extensions.filter(
    (extension) => !disabledKeys.has(extensionKeyFromSourceInfo(extension.sourceInfo)),
  );
  return result;
}

/**
 * Copy post-apply sourceInfo onto entries captured inside extensionsOverride.
 *
 * Pi's DefaultResourceLoader calls extensionsOverride before
 * applyExtensionSourceInfo, so entries built in the override still have the
 * synthetic loader defaults (source=local, scope=temporary). The live result
 * from getExtensions() already has package metadata (npm:/git:). Update display
 * fields from that result, but leave `key` alone so disable persistence still
 * matches the pre-apply keys used by filterDisabledExtensions.
 */
export function syncExtensionManagerEntrySources(
  entries: ExtensionManagerEntry[],
  liveResult: LoadExtensionsResult,
): void {
  if (entries.length === 0) return;
  const byPath = new Map(
    liveResult.extensions.map((extension) => [extension.path, extension.sourceInfo] as const),
  );
  for (const entry of entries) {
    const sourceInfo = byPath.get(entry.path);
    if (!sourceInfo) continue;
    entry.source = sourceInfo.source;
    entry.scope = sourceInfo.scope;
    entry.origin = sourceInfo.origin;
    entry.baseDir = sourceInfo.baseDir;
  }
}

export function extensionManagerEntriesFromResult(
  result: LoadExtensionsResult,
  disabledKeys: ReadonlySet<string>,
): ExtensionManagerEntry[] {
  const entries = result.extensions.map((extension): ExtensionManagerEntry => {
    const key = extensionKeyFromSourceInfo(extension.sourceInfo);
    return {
      key,
      enabled: !disabledKeys.has(key),
      path: extension.path,
      resolvedPath: extension.resolvedPath,
      source: extension.sourceInfo.source,
      scope: extension.sourceInfo.scope,
      origin: extension.sourceInfo.origin,
      baseDir: extension.sourceInfo.baseDir,
      toolCount: extension.tools.size,
      commandCount: extension.commands.size,
      // Map keys are the registered tool/command names; sort for stable display.
      toolNames: [...extension.tools.keys()].sort((a, b) => a.localeCompare(b)),
      commandNames: [...extension.commands.keys()].sort((a, b) => a.localeCompare(b)),
    };
  });
  const loadedKeys = new Set(entries.map((entry) => entry.key));
  for (const error of result.errors) {
    const existing = entries.find(
      (entry) => entry.path === error.path || entry.resolvedPath === error.path,
    );
    if (existing) {
      existing.error = error.error;
      continue;
    }
    const key = `error:unknown:top-level:${error.path}`;
    if (loadedKeys.has(key)) continue;
    entries.push({
      key,
      enabled: !disabledKeys.has(key),
      path: error.path,
      resolvedPath: error.path,
      source: "unknown",
      scope: "unknown",
      origin: "top-level",
      toolCount: 0,
      commandCount: 0,
      toolNames: [],
      commandNames: [],
      error: error.error,
    });
    loadedKeys.add(key);
  }
  return entries.sort((left, right) =>
    extensionEntrySortKey(left).localeCompare(extensionEntrySortKey(right)),
  );
}

function extensionEntrySortKey(entry: ExtensionManagerEntry): string {
  return `${entry.source}\0${entry.path}\0${entry.key}`;
}
