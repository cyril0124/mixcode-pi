import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);

/**
 * Packages that extensions may import after being copied under
 * `<agentDir>/extensions/`. Native dynamic `import()` (e.g. mpi-goal lazy wire)
 * resolves from the extension file path, not the app node_modules — so these
 * must be visible when walking up from `~/.pi/agent/extensions/...`.
 * Mirrors packages Pi exposes via jiti aliases / binary virtualModules.
 */
const AGENT_EXTENSION_RUNTIME_PACKAGES = [
  "typebox",
  "@earendil-works/pi-tui",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
] as const;

/**
 * Ensure all packages under `<repoRoot>/pi-packages/` (dev/build output) or
 * `<repoRoot>/packages/` (compiled binary runtime) that declare a `pi` field in
 * their package.json are installed into the effective Pi extensions directory
 * (`<agentDir>/extensions/`, default `~/.pi/agent/extensions/`).
 *
 * `agentDir` must match the effective agent directory Pi's ResourceLoader uses
 * (see Pi getAgentDir()); otherwise built-in packages install
 * under one root while discovery scans another and never loads them.
 *
 * `copy: true` copies package files; the startup path uses this in both source
 * and compiled runtimes. The default symlink mode remains available to direct
 * callers that explicitly want live package files.
 *
 * Safe to call multiple times — existing correct installs are left untouched.
 */
export function ensurePackageExtensions(
  repoRoot: string,
  options?: { copy?: boolean; agentDir?: string },
): string[] {
  // Sync install at startup: keep node:fs sync APIs (no Bun dir/symlink tree API).
  const packageDirs = [path.join(repoRoot, "pi-packages"), path.join(repoRoot, "packages")].filter(
    (dir) => fs.existsSync(dir),
  );
  if (packageDirs.length === 0) return [];

  const agentDir = options?.agentDir ?? path.join((process.env.HOME || os.homedir()), ".pi", "agent");
  const extensionsDir = path.join(agentDir, "extensions");
  const installedExtensionPaths = new Set<string>();
  fs.mkdirSync(extensionsDir, { recursive: true });
  ensureAgentExtensionRuntimePackages(agentDir);
  const shouldCopy = options?.copy ?? false;

  for (const packagesDir of packageDirs) {
    for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const pkgDir = path.join(packagesDir, entry.name);
      const pkgJsonPath = path.join(pkgDir, "package.json");
      if (!fs.existsSync(pkgJsonPath)) continue;

      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, "utf8"));
        if (!pkg.pi) continue;
      } catch {
        continue;
      }

      const destDir = path.join(extensionsDir, entry.name);
      const target = path.resolve(pkgDir);

      if (shouldCopy) {
        // Copy mode: write files directly into ~/.pi/agent/extensions/<name>/,
        // recursing into subdirectories. Multi-file packages (nested modules
        // under state/, tool/, view/, etc.) would otherwise lose paths and fail.
        copyTreeSync(pkgDir, destDir);
      } else {
        // Symlink mode: skip if already a symlink pointing to the correct target
        try {
          const stat = fs.lstatSync(destDir);
          if (stat.isSymbolicLink() && path.resolve(fs.readlinkSync(destDir)) === target) {
            installedExtensionPaths.add(destDir);
            continue;
          }
          // Exists but wrong target or not a symlink — remove and recreate
          fs.unlinkSync(destDir);
        } catch {
          // ENOENT: path doesn't exist — proceed to create symlink
        }
        fs.symlinkSync(target, destDir);
      }
      installedExtensionPaths.add(destDir);
    }
  }
  return [...installedExtensionPaths].sort();
}

/** Recursively copy a directory tree (files + nested subdirectories). */
function copyTreeSync(srcDir: string, destDir: string): void {
  fs.mkdirSync(destDir, { recursive: true });
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);
    if (entry.isDirectory()) copyTreeSync(srcPath, destPath);
    else fs.copyFileSync(srcPath, destPath);
  }
}

/**
 * Symlink host-resolved packages into `<agentDir>/node_modules` so extensions
 * loaded from `<agentDir>/extensions/**` can resolve them via Node/Bun package
 * walk-up (needed for lazy dynamic import outside jiti aliases).
 */
export function ensureAgentExtensionRuntimePackages(agentDir: string): void {
  const nodeModules = path.join(agentDir, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  for (const name of AGENT_EXTENSION_RUNTIME_PACKAGES) {
    linkPackageIntoDir(nodeModules, name);
  }
}

function linkPackageIntoDir(nodeModulesDir: string, packageName: string): void {
  let resolvedEntry: string;
  try {
    // Prefer package.json so we link the package root, not a deep ESM file.
    resolvedEntry = require.resolve(`${packageName}/package.json`);
  } catch {
    try {
      resolvedEntry = require.resolve(packageName);
    } catch {
      return;
    }
  }
  const packageRoot = packageRootFromEntry(resolvedEntry, packageName);
  if (!packageRoot) return;
  const dest = path.join(nodeModulesDir, ...packageName.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    const st = fs.lstatSync(dest);
    if (st.isSymbolicLink() && path.resolve(fs.readlinkSync(dest)) === packageRoot) return;
    fs.rmSync(dest, { recursive: true, force: true });
  } catch {
    // missing — create
  }
  fs.symlinkSync(packageRoot, dest);
}

function packageRootFromEntry(entryFile: string, packageName: string): string | undefined {
  let dir = path.dirname(entryFile);
  const needle = `${path.sep}node_modules${path.sep}${packageName}`;
  while (true) {
    if (dir.endsWith(needle) || dir.endsWith(`${path.sep}node_modules${path.sep}${packageName.replaceAll("/", path.sep)}`)) {
      return dir;
    }
    const pkgJson = path.join(dir, "package.json");
    if (fs.existsSync(pkgJson)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgJson, "utf8")) as { name?: string };
        if (pkg.name === packageName) return dir;
      } catch {
        // continue walk
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
