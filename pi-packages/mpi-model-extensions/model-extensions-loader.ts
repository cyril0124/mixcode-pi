// +---------------------------------------------------------------------------+
// |  model-extensions loader                                                  |
// |  Dynamically import extension factories and invoke with host ExtensionAPI.|
// |                                                                           |
// |  No jiti dependency: this package is itself loaded by Pi's jiti, so       |
// |  `import(pathToFileURL(absPath).href)` can load sibling .ts factories.    |
// |  Bare `import "jiti"` / require.resolve(package.json) break under         |
// |  ~/.pi/agent/extensions (sparse node_modules + package exports).          |
// +---------------------------------------------------------------------------+
import { pathToFileURL } from "node:url";
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type LoadAttempt =
  | { path: string; ok: true }
  | { path: string; ok: false; error: string };

export type DynamicLoader = {
  /** Paths successfully loaded in this session (absolute). */
  loadedPaths: ReadonlySet<string>;
  /** Load any paths not yet loaded. Returns per-path results. */
  loadPaths: (paths: readonly string[], pi: ExtensionAPI) => Promise<LoadAttempt[]>;
};

function isFactory(value: unknown): value is ExtensionFactory {
  return typeof value === "function";
}

function extractFactory(mod: unknown): ExtensionFactory | undefined {
  if (isFactory(mod)) return mod;
  if (mod && typeof mod === "object" && "default" in mod) {
    const d = (mod as { default: unknown }).default;
    if (isFactory(d)) return d;
  }
  return undefined;
}

/**
 * Create a session-scoped loader. Same absolute path is only factory-invoked once.
 */
export function createDynamicExtensionLoader(): DynamicLoader {
  const loaded = new Set<string>();

  return {
    get loadedPaths() {
      return loaded;
    },
    async loadPaths(paths, pi) {
      const results: LoadAttempt[] = [];
      for (const entryPath of paths) {
        if (loaded.has(entryPath)) {
          results.push({ path: entryPath, ok: true });
          continue;
        }
        try {
          // Cache-bust so /reload + new loader instance can pick up file edits.
          const href = `${pathToFileURL(entryPath).href}?mpi-model-ext=${Date.now()}`;
          const mod: unknown = await import(href);
          const factory = extractFactory(mod);
          if (!factory) {
            results.push({
              path: entryPath,
              ok: false,
              error: "module default export is not an extension factory function",
            });
            continue;
          }
          await factory(pi);
          loaded.add(entryPath);
          results.push({ path: entryPath, ok: true });
        } catch (err) {
          results.push({
            path: entryPath,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return results;
    },
  };
}
