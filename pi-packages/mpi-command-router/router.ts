import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { configPath, loadConfigFile, projectConfigPath } from "./config.js";

/** Session facts a project config layer depends on. */
export interface PrepareScope {
  /** Session working directory; the project config lives under `<cwd>/<configDirName>`. */
  cwd: string;
  /** Untrusted projects contribute no routes. */
  projectTrusted: boolean;
}

interface RouteSource {
  name: string;
  target: [string, ...string[]];
  /** Relative targets resolve here: the directory holding the config that defined the route. */
  baseDir: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

// Search external executables without changing PATH or using `command -v`, which
// can return shell builtins. Relative PATH entries follow the invoking shell cwd.
const RESOLVE_EXECUTABLE = `mpi_router_resolve() {
  case "$1" in
    */*)
      if [ -f "$1" ] && [ -x "$1" ]; then
        case "$1" in
          /*) printf '%s\\n' "$1" ;;
          *) printf '%s/%s\\n' "$PWD" "$1" ;;
        esac
        return 0
      fi
      return 1
      ;;
  esac
  mpi_router_remaining=$MPI_COMMAND_ROUTER_BASE_PATH
  while :; do
    mpi_router_dir=\${mpi_router_remaining%%:*}
    mpi_router_candidate=\${mpi_router_dir:-.}/$1
    if [ -f "$mpi_router_candidate" ] && [ -x "$mpi_router_candidate" ]; then
      case "$mpi_router_candidate" in
        /*) printf '%s\\n' "$mpi_router_candidate" ;;
        *) printf '%s/%s\\n' "$PWD" "$mpi_router_candidate" ;;
      esac
      return 0
    fi
    case "$mpi_router_remaining" in
      *:*) mpi_router_remaining=\${mpi_router_remaining#*:} ;;
      *) return 1 ;;
    esac
  done
}`;

/** A crashed prepare can leave a staging directory behind; keep it briefly so a slow sibling can finish. */
const STAGING_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Remove abandoned staging directories. Published hash directories are never removed:
 * prepared commands and detached children keep their wrapper paths, so age alone is not a
 * reason to drop them.
 */
async function pruneCache(cache: string): Promise<void> {
  let entries: string[];
  try {
    entries = await fs.readdir(cache);
  } catch (error) {
    // The cache directory is created just before publish, so ENOENT is the only expected failure.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.startsWith(".prepare-"))
      .map(async (entry) => {
        const target = path.join(cache, entry);
        let stats: Awaited<ReturnType<typeof fs.stat>>;
        try {
          stats = await fs.stat(target);
        } catch (error) {
          // Another instance pruned the entry between readdir and stat.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return;
        }
        if (now - stats.mtimeMs < STAGING_MAX_AGE_MS) return;
        await fs.rm(target, { recursive: true, force: true });
      }),
  );
}

/** Whether a published wrapper directory is still on disk; it can be removed outside this process. */
async function isPublishedDirectory(target: string): Promise<boolean> {
  try {
    return (await fs.stat(target)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function wrapper(name: string, target: [string, ...string[]], baseDir: string): string {
  const [executable, ...args] = target;
  // Paths in config are stable across `cd`; bare names use the shell's original PATH.
  const targetExecutable = executable.includes("/")
    ? path.resolve(baseDir, executable)
    : executable;
  const quotedName = shellQuote(name);
  return `#!/bin/sh
${RESOLVE_EXECUTABLE}
case ":\${MPI_COMMAND_ROUTER_ACTIVE-}:" in
  *:${name}:*)
    printf '%s\\n' ${shellQuote(`Error: recursive command route ${name}; call "$MPI_COMMAND_ROUTER_ORIGINAL" to use the original executable.`)} >&2
    exit 126
    ;;
esac
MPI_COMMAND_ROUTER_COMMAND=${quotedName}
MPI_COMMAND_ROUTER_ORIGINAL=$(mpi_router_resolve ${quotedName}) || MPI_COMMAND_ROUTER_ORIGINAL=''
mpi_router_target=$(mpi_router_resolve ${shellQuote(targetExecutable)}) || {
  printf '%s\\n' ${shellQuote(`Error: command route ${name}: executable not found or not executable: ${targetExecutable}`)} >&2
  exit 127
}
MPI_COMMAND_ROUTER_ACTIVE="\${MPI_COMMAND_ROUTER_ACTIVE-}:${name}"
export MPI_COMMAND_ROUTER_COMMAND MPI_COMMAND_ROUTER_ORIGINAL MPI_COMMAND_ROUTER_ACTIVE
exec "$mpi_router_target" ${args.map(shellQuote).join(" ")} "$@"
`;
}

/**
 * Prepare per-call PATH injection without mutating the agent process environment.
 * Each call reads both config layers. Immutable wrapper directories are shared across
 * instances and retained across reload/shutdown so detached children keep their paths.
 */
export class CommandRouter {
  private preparedDirectory: string | undefined;
  private preparedHash: string | undefined;

  constructor(
    private readonly agentDir: string,
    private readonly configDirName: string,
  ) {}

  async prepare(command: string, scope?: PrepareScope): Promise<string> {
    const sources = await this.collectRoutes(scope);
    if (sources.length === 0) return command;
    if (process.platform === "win32") {
      throw new Error("Error: mpi-command-router requires a POSIX host with /bin/sh");
    }
    if (this.agentDir.includes(":")) {
      throw new Error(
        "Error: mpi-command-router agent directory cannot contain ':' because PATH uses it as a separator",
      );
    }

    const files = sources.map(
      (source) => [source.name, wrapper(source.name, source.target, source.baseDir)] as const,
    );
    const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
    let directory = this.preparedDirectory;
    // Re-check the published directory: a sibling instance's prune can remove it.
    if (!directory || hash !== this.preparedHash || !(await isPublishedDirectory(directory))) {
      directory = await this.materialize(hash, files);
      this.preparedDirectory = directory;
      this.preparedHash = hash;
    }

    // Inject into this shell only. Keep the user's text intact so pipes, redirects,
    // heredocs, and child shells retain their native parsing and execution semantics.
    return `export MPI_COMMAND_ROUTER_BASE_PATH="$PATH"\nexport PATH=${shellQuote(directory)}:"$PATH"\n${command}`;
  }

  /**
   * Merge the global and project layers: project routes replace global routes per
   * command name, and routing runs only when every present layer is enabled.
   */
  private async collectRoutes(scope?: PrepareScope): Promise<RouteSource[]> {
    const sources = new Map<string, RouteSource>();
    let enabled = true;

    const globalConfig = await loadConfigFile(configPath(this.agentDir));
    if (globalConfig) {
      enabled = globalConfig.enabled;
      for (const [name, target] of Object.entries(globalConfig.routes)) {
        sources.set(name, { name, target, baseDir: this.agentDir });
      }
    }

    if (scope?.projectTrusted) {
      const projectConfig = await loadConfigFile(projectConfigPath(scope.cwd, this.configDirName));
      if (projectConfig) {
        enabled = enabled && projectConfig.enabled;
        const baseDir = path.join(scope.cwd, this.configDirName);
        for (const [name, target] of Object.entries(projectConfig.routes)) {
          sources.set(name, { name, target, baseDir });
        }
      }
    }

    if (!enabled) return [];
    return [...sources.values()].sort((left, right) => left.name.localeCompare(right.name));
  }

  private async materialize(
    hash: string,
    files: ReadonlyArray<readonly [string, string]>,
  ): Promise<string> {
    const cache = path.join(this.agentDir, "cache", "mpi-command-router");
    await pruneCache(cache);
    const directory = path.join(cache, hash);
    try {
      const existing = await fs.stat(directory);
      if (!existing.isDirectory())
        throw new Error(`Error: command router cache is not a directory: ${directory}`);
      return directory;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(cache, { recursive: true, mode: 0o700 });
    const staging = await fs.mkdtemp(path.join(cache, ".prepare-"));
    try {
      await Promise.all(
        files.map(([name, content]) =>
          fs.writeFile(path.join(staging, name), content, { mode: 0o700 }),
        ),
      );
      try {
        // Publish only complete directories. Another tab may publish the same hash first.
        await fs.rename(staging, directory);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;
      }
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
    return directory;
  }
}
