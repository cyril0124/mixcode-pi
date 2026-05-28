import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Ensure all packages under `<repoRoot>/packages/` that declare a `pi` field
 * in their package.json are installed into the global Pi extensions directory
 * (`~/.pi/agent/extensions/`).
 *
 * - Dev mode (stable repoRoot): creates symlinks for live-reload.
 * - Binary mode (ephemeral runtimeDir): copies files so they persist after exit.
 *
 * Safe to call multiple times — existing correct installs are left untouched.
 */
export function ensurePackageExtensions(repoRoot: string, options?: { copy?: boolean }): void {
  const packagesDir = join(repoRoot, "packages");
  if (!existsSync(packagesDir)) return;

  const extensionsDir = join(homedir(), ".pi", "agent", "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  const shouldCopy = options?.copy ?? false;

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const pkgDir = join(packagesDir, entry.name);
    const pkgJsonPath = join(pkgDir, "package.json");
    if (!existsSync(pkgJsonPath)) continue;

    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (!pkg.pi) continue;
    } catch {
      continue;
    }

    const destDir = join(extensionsDir, entry.name);
    const target = resolve(pkgDir);

    if (shouldCopy) {
      // Copy mode: write files directly into ~/.pi/agent/extensions/<name>/
      mkdirSync(destDir, { recursive: true });
      for (const file of readdirSync(pkgDir)) {
        copyFileSync(join(pkgDir, file), join(destDir, file));
      }
    } else {
      // Symlink mode: skip if already a symlink pointing to the correct target
      try {
        const stat = lstatSync(destDir);
        if (stat.isSymbolicLink() && resolve(readlinkSync(destDir)) === target) continue;
        // Exists but wrong target or not a symlink — remove and recreate
        unlinkSync(destDir);
      } catch {
        // ENOENT: path doesn't exist — proceed to create symlink
      }
      symlinkSync(target, destDir);
    }
  }
}
