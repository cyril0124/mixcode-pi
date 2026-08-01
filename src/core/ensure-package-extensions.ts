import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Ensure all packages under `<repoRoot>/pi-packages/` (dev/build output) or
 * `<repoRoot>/packages/` (compiled binary runtime) that declare a `pi` field in
 * their package.json are installed into the effective Pi extensions directory
 * (`<agentDir>/extensions/`, default `~/.pi/agent/extensions/`).
 *
 * `agentDir` must match the effective agent directory Pi's ResourceLoader uses
 * (see bootstrap's defaultMixCodeAgentDir); otherwise built-in packages install
 * under one root while discovery scans another and never loads them.
 *
 * - Dev mode (stable repoRoot): creates symlinks for live-reload.
 * - Binary mode (ephemeral runtimeDir): copies files so they persist after exit.
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
