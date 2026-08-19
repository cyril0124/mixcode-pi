import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");
const TSUP_CHUNK = /^chunk-[A-Z0-9]+\.js$/;

/** True when running inside the compiled binary (binary-entry.ts set the flag). */
export function isBinaryEntry(): boolean {
  return Boolean((globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG]);
}

export function isDirectCliEntry(entryUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  if ((globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG]) return false;
  if (!argv1) return false;
  try {
    const realArgv1 = fs.realpathSync(argv1);
    const entryPath = fileURLToPath(entryUrl);
    if (entryPath === realArgv1) return true;
    return isTsupSplitMainEntry(entryPath, realArgv1);
  } catch {
    return entryUrl === `file://${argv1}`;
  }
}

function isTsupSplitMainEntry(entryPath: string, realArgv1: string): boolean {
  const argvName = path.basename(realArgv1);
  if (argvName !== "main.js" && argvName !== "main.ts") return false;
  if (!TSUP_CHUNK.test(path.basename(entryPath))) return false;
  const argvDir = path.dirname(realArgv1);
  const entryDir = path.dirname(entryPath);
  return entryDir === argvDir || entryDir === path.dirname(argvDir);
}
