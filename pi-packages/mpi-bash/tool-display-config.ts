/**
 * Reads the compact-call-row flag that `mpi-tool-display` owns, because that flag decides whether a
 * bash call must carry a `description` label. Pure Node: this package also runs under upstream Pi.
 *
 * The file belongs to another package, so only the one boolean is read here, and its name, its key,
 * its allowlist and its default all mirror that package's config module. An unreadable or malformed
 * file leaves the requirement off: `mpi-tool-display` validates its own configuration and reports its
 * own errors, so a file it would reject must not make bash demand a label.
 */

import * as fs from "node:fs";
import * as path from "node:path";

export const TOOL_DISPLAY_CONFIG_FILENAME = "mpi-tool-display.json";

const COMPACT_BASH_CALL_ROW_KEY = "compactBashCallRow";

/**
 * Mirrors the owner's key allowlist: a file it rejects must not make bash demand a label. The last
 * key has no setting; the owner accepts it, so a file carrying it stays valid.
 */
const KNOWN_KEYS = new Set([
  "showRawToolArguments",
  COMPACT_BASH_CALL_ROW_KEY,
  "compactBashCommandHint",
]);

/**
 * Whether `mpi-tool-display` renders a finished bash call as one compact row. An absent file means
 * nothing has customized the display yet, so that package's own default (on) applies. A file that
 * exists but cannot be read or parsed may mean its owner is not running at all, so the requirement
 * stays off rather than demanding a label nothing renders.
 */
export function compactBashCallRowEnabled(agentDir: string): boolean {
  const filePath = path.join(agentDir, TOOL_DISPLAY_CONFIG_FILENAME);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    // An absent file is the normal state before any display setting is written.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    return false;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    // Malformed JSON belongs to mpi-tool-display, which fails its own load and says so.
    return false;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  const record = parsed as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!KNOWN_KEYS.has(key)) return false;
  }
  const value = record[COMPACT_BASH_CALL_ROW_KEY];
  if (value === undefined) return true;
  return value === true;
}
