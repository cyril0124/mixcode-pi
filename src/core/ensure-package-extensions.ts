import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";
import { homeDir } from "./paths.js";

const require = createRequire(import.meta.url);

const PACKAGE_HASH_FILE = ".mixcode-package-hash";

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
 * Each installed package stores a content hash. Repeated calls hash the source
 * tree but skip all destination writes when the installed hash matches.
 */
export function ensurePackageExtensions(
  repoRoot: string,
  options?: { agentDir?: string },
): string[] {
  // Sync install at startup: keep node:fs sync APIs (no Bun dir/symlink tree API).
  const packageDirs = [path.join(repoRoot, "pi-packages"), path.join(repoRoot, "packages")].filter(
    (dir) => fs.existsSync(dir),
  );
  if (packageDirs.length === 0) return [];

  const agentDir = options?.agentDir ?? path.join(homeDir(), ".pi", "agent");
  const extensionsDir = path.join(agentDir, "extensions");
  const installedExtensionPaths = new Set<string>();
  fs.mkdirSync(extensionsDir, { recursive: true });
  ensureAgentExtensionRuntimePackages(agentDir);

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
      const packageHash = hashPackageTree(pkgDir);
      if (!hasPackageHash(destDir, packageHash)) {
        installPackageTree(pkgDir, destDir, packageHash);
      }
      installedExtensionPaths.add(destDir);
    }
  }
  return [...installedExtensionPaths].sort();
}

function hashPackageTree(packageDir: string): string {
  const hash = new Bun.CryptoHasher("sha256");
  updatePackageHash(hash, packageDir, "");
  return `sha256:${hash.digest("hex")}`;
}

function updatePackageHash(hash: Bun.CryptoHasher, dir: string, relativeDir: string): void {
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const sourcePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      updatePackageHash(hash, sourcePath, relativePath);
      continue;
    }
    const content = fs.readFileSync(sourcePath);
    hash.update(`file:${relativePath.length}:${relativePath}:${content.byteLength}\n`);
    hash.update(content);
  }
}

function hasPackageHash(destDir: string, expectedHash: string): boolean {
  try {
    return fs.readFileSync(path.join(destDir, PACKAGE_HASH_FILE), "utf8").trim() === expectedHash;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function installPackageTree(sourceDir: string, destDir: string, packageHash: string): void {
  fs.rmSync(destDir, { recursive: true, force: true });
  copyTreeSync(sourceDir, destDir);
  fs.writeFileSync(path.join(destDir, PACKAGE_HASH_FILE), `${packageHash}\n`);
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
function ensureAgentExtensionRuntimePackages(agentDir: string): void {
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
