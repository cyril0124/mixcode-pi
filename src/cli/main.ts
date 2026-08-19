#!/usr/bin/env bun
import * as fs from "node:fs";
import * as path from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { isBinaryEntry, isDirectCliEntry } from "./direct-cli-entry.js";
import { isCommandsCliArgs, runCommandsCommand } from "./commands-list.js";
import { isInstallExtensionsCliArgs } from "./install-extensions.js";
import { isCtlCliArgs, runCtlCommand } from "./ctl.js";
import {
  isStatusCliArgs,
  runStatusCommand as executeStatusCommand,
  takeWorkdirFlag,
} from "./status.js";

function hasMixcodePackages(dir: string): boolean {
  return fs.existsSync(path.join(dir, "pi-packages")) || fs.existsSync(path.join(dir, "packages"));
}

/** Walk up from `startDir` until a MixCode install root (`pi-packages/` or `packages/`). */
function findMixcodeInstallRoot(startDir: string): string {
  let dir = path.resolve(startDir);
  while (true) {
    if (hasMixcodePackages(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

function selfRootFromEntryUrl(entryUrl = import.meta.url): string {
  return findMixcodeInstallRoot(path.dirname(fileURLToPath(entryUrl)));
}

/**
 * Root that contains built-in packages (`pi-packages/` in dev, `packages/` in
 * binary runtime). Prefer this install's tree when it has packages; only then
 * fall back to PI_PACKAGE_DIR (binary materialize path).
 */
export function resolveMixcodePackageRoot(selfRoot: string, env = process.env): string {
  if (hasMixcodePackages(selfRoot)) return selfRoot;
  const fromEnv = env.PI_PACKAGE_DIR?.trim();
  if (fromEnv && hasMixcodePackages(fromEnv)) return fromEnv;
  return selfRoot;
}

export function isBuiltinExtensionsOnlyEnabled(
  flagValue?: boolean,
  env = process.env,
): boolean {
  if (flagValue) return true;
  const raw = env.MIXCODE_BUILTIN_EXTENSIONS_ONLY?.trim().toLowerCase();
  if (!raw) return false;
  return raw !== "0" && raw !== "false" && raw !== "off" && raw !== "no";
}

export type MainCommand = "tui" | "status";

export interface MainArgs {
  command: MainCommand;
  workdir: string;
  batch?: string;
  batchArgs?: string[];
  batchDryRun?: boolean;
  builtinExtensionsOnly?: boolean;
  json?: boolean;
  statusWorkdir?: string;
}

const HELP_TEXT = `Usage: mpi [options] [-- <script-args...>]
       mpi status [--json] [--workdir <path>]
       mpi ctl [--pid <n> | --workdir <path>] [--tab <title> | --session <id> | --focus-tab <title> | --focus-session <id>] <command>
       mpi commands [--json] [--workdir <path>]

Options:
  --workdir <path>           Set working directory (default: cwd)
  --batch <file>             Execute a Lua batch script after TUI startup
  --batch-dry-run            Load/validate batch script and print plan (no TUI, no session writes)
  --builtin-extensions-only  Load MixCode built-in extensions without discovering third-party extensions
  --help, -h                 Show this help message

  Arguments after -- are passed to the batch script as mixcode.args().

Commands:
  status             Show live mpi instances and tabs
  ctl                Control a live instance (--tab/--session or --focus-*; last-message, wait, send-prompt, send-keys, …)
  commands           List slash commands (local, extension, prompt)
`;

export function parseMainArgs(args: string[], fallbackWorkdir: string): MainArgs {
  const baseWorkdir = path.resolve(fallbackWorkdir);
  if (args[0] === "status") return parseStatusArgs(args.slice(1), baseWorkdir);

  let workdir = baseWorkdir;
  let batchPath: string | undefined;
  let batchDryRun = false;
  let builtinExtensionsOnly = false;
  let batchArgs: string[] | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (arg === "--") {
      batchArgs = args.slice(index + 1);
      break;
    }
    const parsedWorkdir = takeWorkdirFlag(arg, () => args[++index], baseWorkdir);
    if (parsedWorkdir !== undefined) {
      workdir = parsedWorkdir;
      continue;
    }
    if (arg === "--batch") {
      const value = args[++index];
      if (!value) throw new Error("--batch requires a file path");
      batchPath = value;
      continue;
    }
    if (arg?.startsWith("--batch=")) {
      const value = arg.slice("--batch=".length);
      if (!value) throw new Error("--batch requires a file path");
      batchPath = value;
      continue;
    }
    if (arg === "--batch-dry-run") {
      batchDryRun = true;
      continue;
    }
    if (arg === "--builtin-extensions-only") {
      builtinExtensionsOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (batchDryRun && !batchPath) {
    throw new Error("--batch-dry-run requires --batch <file>");
  }
  return {
    command: "tui",
    workdir,
    batch: batchPath ? path.resolve(workdir, batchPath) : undefined,
    batchArgs,
    batchDryRun: batchDryRun || undefined,
    builtinExtensionsOnly: builtinExtensionsOnly || undefined,
  };
}

function parseStatusArgs(args: string[], baseWorkdir: string): MainArgs {
  let json = false;
  let statusWorkdir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    const parsedWorkdir = takeWorkdirFlag(arg, () => args[++index], baseWorkdir);
    if (parsedWorkdir !== undefined) {
      statusWorkdir = parsedWorkdir;
      continue;
    }
    throw new Error(`Unknown status argument: ${arg}`);
  }
  return { command: "status", workdir: baseWorkdir, json, statusWorkdir };
}

export async function runStatusCommand(args: MainArgs): Promise<void> {
  await executeStatusCommand({
    json: args.json,
    workdir: args.statusWorkdir,
  });
}

export function exposeLocalPiCli(
  env: NodeJS.ProcessEnv = process.env,
  entryUrl = import.meta.url,
): string {
  const repoDir = selfRootFromEntryUrl(entryUrl);
  const binDir = path.resolve(repoDir, "node_modules", ".bin");
  // In bun compiled binary, import.meta.url is a virtual path; skip if dir doesn't exist.
  if (!fs.existsSync(binDir)) return binDir;
  const delimiter = process.platform === "win32" ? ";" : ":";
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!parts.includes(binDir)) {
    env.PATH = [binDir, ...parts].join(delimiter);
  }
  return binDir;
}

/**
 * True when argv explicitly requests pi-coding-agent's own public non-interactive
 * contract: --print/-p, documented as "process prompt and exit" (see `pi --help`).
 * mixcode-pi has no equivalent flag, so this is the one stable, upstream-owned
 * signal that an argv was built for pi's headless contract rather than a human
 * typo or mixcode-pi's own grammar — not a private convention of any one caller.
 */
export function shouldDelegateToRealPiCli(args: string[], isTTY: boolean): boolean {
  if (isTTY) return false;
  return args.includes("--print") || args.includes("-p");
}

/**
 * Runs the real pi-coding-agent CLI with the given argv, inheriting stdio so the
 * caller sees the same output/exit-code semantics as spawning upstream `pi`
 * directly. `options.command` defaults to "pi" (resolved via PATH); it is
 * overridable for testing without a real pi installation.
 */
export async function delegateToRealPiCli(
  args: string[],
  options: { command?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number> {
  const { command = "pi", env = process.env } = options;
  // Binary materialize sets PI_PACKAGE_DIR for in-process Pi assets. Real `pi`
  // must use its own package root so help/identity stay upstream (not mixcode).
  const childEnv = { ...env };
  delete childEnv.PI_PACKAGE_DIR;
  try {
    const child = Bun.spawn([command, ...args], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      env: childEnv,
    });
    return await child.exited;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

export async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Fast path for worker sub-process
  if (rawArgs.length === 1 && rawArgs[0] === "--mixcode-session-catalog-worker") {
    const { runSessionCatalogWorkerCommand } = await import("../core/session-catalog.js");
    if (await runSessionCatalogWorkerCommand(rawArgs)) return;
  }

  // Fast path for status command — bypasses Pi SDK, HTTP dispatcher, and TUI loading
  if (isStatusCliArgs(rawArgs)) {
    process.env.MIXCODE ??= "1";
    const args = parseMainArgs(rawArgs, cwd());
    await runStatusCommand(args);
    return;
  }
  if (isCtlCliArgs(rawArgs)) {
    process.env.MIXCODE ??= "1";
    try {
      await runCtlCommand(rawArgs.slice(1));
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (isCommandsCliArgs(rawArgs)) {
    process.env.MIXCODE ??= "1";
    const selfRoot = selfRootFromEntryUrl();
    try {
      await runCommandsCommand(rawArgs.slice(1), {
        packageRoot: resolveMixcodePackageRoot(selfRoot),
      });
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
    return;
  }

  if (isInstallExtensionsCliArgs(rawArgs)) {
    process.env.MIXCODE ??= "1";
    // Dynamic import: the flow lazily loads pi-coding-agent, which must not be
    // pulled in by the status/ctl fast paths above.
    const { runInstallExtensionsCommand } = await import("./install-extensions.js");
    await runInstallExtensionsCommand(rawArgs.slice(1));
    return;
  }

  // Configure undici's global dispatcher before provider SDKs issue requests.
  // Runtime settings are applied once SettingsManager has loaded global/project settings.
  const { configureHttpDispatcher } = await import("@earendil-works/pi-coding-agent");
  configureHttpDispatcher();
  exposeLocalPiCli();

  // Built-in package install root is MixCode's own tree (pi-packages/ or packages/),
  // not Pi's PI_PACKAGE_DIR.
  const selfRoot = selfRootFromEntryUrl();

  if (shouldDelegateToRealPiCli(rawArgs, Boolean(process.stdin.isTTY))) {
    process.exitCode = await delegateToRealPiCli(rawArgs);
    return;
  }

  process.env.MIXCODE ??= "1";
  const args = parseMainArgs(rawArgs, cwd());

  // Compiled binary only: source installs get the same offer from postinstall.
  if (isBinaryEntry()) {
    const { maybeOfferFirstRunInstall } = await import("./install-extensions.js");
    await maybeOfferFirstRunInstall();
  }

  const { runInteractiveApp } = await import("./interactive-app.js");
  await runInteractiveApp(args, selfRoot);
}

if (isDirectCliEntry(import.meta.url)) {
  main().catch((error) => {
    // Bypass the console bridge here: a startup crash can happen after the bridge
    // is installed but before the TUI sink is wired, which would queue this fatal
    // error into a buffer that never flushes. Write straight to the real stderr.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
