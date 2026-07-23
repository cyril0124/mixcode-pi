import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

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
): void {
  const packageDirs = [join(repoRoot, "pi-packages"), join(repoRoot, "packages")].filter(
    existsSync,
  );
  if (packageDirs.length === 0) return;

  const agentDir = options?.agentDir ?? join(homedir(), ".pi", "agent");
  const extensionsDir = join(agentDir, "extensions");
  mkdirSync(extensionsDir, { recursive: true });
  const shouldCopy = options?.copy ?? false;

  const hasDiffViewer = packageDirs.some((packagesDir) => {
    const manifest = join(packagesDir, "mpi-diff-viewer", "package.json");
    if (!existsSync(manifest)) return false;
    try {
      return Boolean(JSON.parse(readFileSync(manifest, "utf8")).pi);
    } catch {
      return false;
    }
  });
  // The viewer owns /diff; remove prior package names so Pi does not namespace duplicates.
  if (hasDiffViewer) {
    for (const legacyName of ["mpi-diff-tracker", "mpi-diff-tracker-v2"]) {
      rmSync(join(extensionsDir, legacyName), { recursive: true, force: true });
    }
  }

  for (const packagesDir of packageDirs) {
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
        // Copy mode: write files directly into ~/.pi/agent/extensions/<name>/,
        // recursing into subdirectories. Multi-file packages (e.g. rpiv-todo with
        // state/, tool/, view/, vendor/, locales/) would otherwise lose their
        // nested modules and fail to load.
        copyTreeSync(pkgDir, destDir);
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
}

/** Recursively copy a directory tree (files + nested subdirectories). */
function copyTreeSync(srcDir: string, destDir: string): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    if (entry.isDirectory()) copyTreeSync(srcPath, destPath);
    else copyFileSync(srcPath, destPath);
  }
}
