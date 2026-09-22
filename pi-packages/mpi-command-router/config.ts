import * as fs from "node:fs/promises";
import * as path from "node:path";

export const CONFIG_FILENAME = "mpi-command-router.json";
const COMMAND_NAME_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.+-]*$/;

// `$$` is a literal dollar; `$NAME` and `${NAME}` read the environment. The trailing
// `\{` alternative catches a `$` that opens a braced reference and never closes it.
const ENVIRONMENT_REFERENCE = /\$(\$|\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*)|\{)/g;

interface RouterConfig {
  enabled: boolean;
  routes: Record<string, [string, ...string[]]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Expand `$NAME` and `${NAME}` from `env`. An unset name is a configuration error
 * rather than an empty string, so a typo cannot silently produce a broken target.
 * A malformed `${` reference is rejected for the same reason.
 */
function expandEnvironmentVariables(
  value: string,
  env: Record<string, string | undefined>,
  describe: string,
): string {
  return value.replace(
    ENVIRONMENT_REFERENCE,
    (reference: string, _group: string, braced?: string, bare?: string) => {
      if (reference === "$$") return "$";
      const name = braced ?? bare;
      if (name === undefined)
        throw new Error(`${describe}: invalid environment reference ${reference}`);
      const resolved = env[name];
      if (resolved === undefined) {
        throw new Error(`${describe}: undefined environment variable $${name}`);
      }
      return resolved;
    },
  );
}

/** Validate the complete JSON boundary, including disabled routes; never coerce invalid settings. */
function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): RouterConfig {
  if (!isRecord(raw)) throw new Error("expected an object");
  for (const key of Object.keys(raw)) {
    if (!["$schema", "enabled", "routes"].includes(key)) {
      throw new Error(`unknown setting: ${key}`);
    }
  }
  if (raw.$schema !== undefined && typeof raw.$schema !== "string") {
    throw new Error("$schema must be a string");
  }
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("enabled must be a boolean");
  }
  if (!isRecord(raw.routes)) throw new Error("routes must be an object");

  const routes: RouterConfig["routes"] = Object.create(null);
  for (const [name, target] of Object.entries(raw.routes)) {
    if (!COMMAND_NAME_PATTERN.test(name)) throw new Error(`invalid command name: ${name}`);
    if (
      !Array.isArray(target) ||
      target.length === 0 ||
      target.some((arg) => typeof arg !== "string")
    ) {
      throw new Error(`routes.${name} must be a nonempty string array`);
    }
    const expanded = target.map((arg, index) =>
      expandEnvironmentVariables(arg, env, `routes.${name}[${index}]`),
    );
    const [executable = "", ...args] = expanded;
    if (executable.length === 0 || expanded.some((arg) => arg.includes("\0"))) {
      throw new Error(`routes.${name} must have a nonempty executable and no NUL bytes`);
    }
    routes[name] = [executable, ...args];
  }
  return { enabled: raw.enabled ?? true, routes };
}

/** Absolute path of the user-wide layer: `<agentDir>/mpi-command-router.json`. */
export function configPath(agentDir: string): string {
  return path.join(agentDir, CONFIG_FILENAME);
}

/** Project config lives at `<cwd>/<configDirName>/mpi-command-router.json` (e.g. `.pi`). */
export function projectConfigPath(cwd: string, configDirName: string): string {
  return path.join(cwd, configDirName, CONFIG_FILENAME);
}

/** Returns null when the file does not exist, so an absent layer contributes no routes. */
export async function loadConfigFile(filename: string): Promise<RouterConfig | null> {
  let text: string;
  try {
    text = await fs.readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(
      `Error: ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    return parseConfig(JSON.parse(text));
  } catch (error) {
    throw new Error(
      `Error: ${filename}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Result of toggling one layer's `enabled` flag. */
interface EnabledChange {
  /** True when the file did not exist and was created with an empty route map. */
  created: boolean;
}

/**
 * Set one layer's `enabled` flag and leave the rest of the file meaning unchanged: `$schema` and
 * the raw route definitions survive, so a write never bakes expanded environment values in.
 * An unreadable or invalid file is refused instead of overwritten, because overwriting it would
 * silently discard the user's intent. A missing file is created with an empty route map so the
 * flag can be set without hand-writing JSON.
 */
export async function setConfigEnabled(filename: string, enabled: boolean): Promise<EnabledChange> {
  let text: string | undefined;
  try {
    text = await fs.readFile(filename, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error(
        `Error: ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let document: Record<string, unknown> = {};
  if (text !== undefined) {
    try {
      const raw: unknown = JSON.parse(text);
      if (!isRecord(raw)) throw new Error("expected an object");
      parseConfig(raw);
      document = raw;
    } catch (error) {
      throw new Error(
        `Error: ${filename}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  document.enabled = enabled;
  if (!isRecord(document.routes)) document.routes = {};
  await fs.mkdir(path.dirname(filename), { recursive: true });
  await fs.writeFile(filename, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  return { created: text === undefined };
}
