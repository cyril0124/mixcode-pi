import * as fs from "node:fs";
import * as path from "node:path";

/** One normalize pass per agentDir per process — createRuntimeServices can run per tab. */
const normalizedAgentDirs = new Set<string>();

type PiPackageJson = {
  pi?: {
    extensions?: string[];
  };
};

/**
 * Prefer prebuilt dist extension entries when a package still points at src.
 * Helps avoid jiti compiling TypeBox-heavy src under some loaders.
 * Idempotent and process-memoized (NFS-friendly: do not rescan every tab).
 */
export function preferDistExtensionEntries(agentDir: string): { rewritten: string[] } {
  const resolvedAgentDir = path.resolve(agentDir);
  if (normalizedAgentDirs.has(resolvedAgentDir)) {
    return { rewritten: [] };
  }
  normalizedAgentDirs.add(resolvedAgentDir);

  const root = path.join(resolvedAgentDir, "npm", "node_modules");
  const rewritten: string[] = [];
  if (!fs.existsSync(root)) return { rewritten };

  for (const pkgDir of listPackageDirs(root)) {
    if (rewritePackageManifest(pkgDir)) rewritten.push(pkgDir);
  }

  return { rewritten };
}

function listPackageDirs(nodeModules: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(nodeModules)) {
    if (name === ".bin" || name.startsWith(".")) continue;
    const full = path.join(nodeModules, name);
    let st: fs.Stats;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (name.startsWith("@")) {
      for (const scoped of fs.readdirSync(full)) {
        const scopedDir = path.join(full, scoped);
        try {
          if (fs.statSync(scopedDir).isDirectory()) out.push(scopedDir);
        } catch {
          // ignore broken entries
        }
      }
      continue;
    }
    out.push(full);
  }
  return out;
}

function rewritePackageManifest(pkgDir: string): boolean {
  const manifestPath = path.join(pkgDir, "package.json");
  let raw: string;
  try {
    raw = fs.readFileSync(manifestPath, "utf8");
  } catch {
    return false;
  }

  // Fast path: most deps have no pi.extensions — skip JSON parse when absent.
  if (!raw.includes('"pi"') || !raw.includes("extensions")) return false;

  let data: PiPackageJson;
  try {
    data = JSON.parse(raw) as PiPackageJson;
  } catch {
    return false;
  }

  const entries = data.pi?.extensions;
  if (!entries?.length) return false;

  let changed = false;
  const next = entries.map((entry) => {
    const preferred = preferDistPath(pkgDir, entry);
    if (preferred !== entry) {
      changed = true;
      return preferred;
    }
    return entry;
  });

  if (!changed || !data.pi) return false;
  data.pi.extensions = next;
  fs.writeFileSync(manifestPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return true;
}

/** ./src/index.ts + dist/index.js → ./dist/index.js */
function preferDistPath(pkgDir: string, entry: string): string {
  const normalized = entry.replace(/\\/g, "/");
  const m = normalized.match(/^\.\/src\/(.+)\.tsx?$/);
  if (!m) return entry;
  const distRel = `./dist/${m[1]}.js`;
  if (fs.existsSync(path.join(pkgDir, distRel))) return distRel;
  return entry;
}
