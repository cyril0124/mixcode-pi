#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import {
  applyBatchRequests,
  contextFromState,
  loadBatchRequests,
  validateBatchRequests,
} from "../core/batch-lua.js";
import { findModelRef } from "../core/models.js";
import {
  cleanupInstanceRegistry,
  formatInstanceStatusTable,
  loadLiveInstanceStatus,
  removeInstanceSnapshotSync,
  writeCurrentInstanceSnapshot,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
} from "../core/instance-registry.js";
import { saveStateFile } from "../core/state-store.js";
import { createMixCodeTui } from "../ui/app.js";
import { createBatchExecutorHost } from "./batch-host.js";
import { bootstrapMixCode, defaultMixCodeAgentDir, defaultStateDir } from "./bootstrap.js";
import { ensurePackageExtensions } from "../core/ensure-package-extensions.js";
import { installConsoleTuiBridge, wireConsoleSink } from "./console-tui-bridge.js";
import { showNoticeTextOverlay } from "../ui/app-overlays.js";
import { configureHttpDispatcher } from "../core/http-dispatcher.js";

export async function main(): Promise<void> {
  // Configure undici's global dispatcher before provider SDKs issue requests.
  // Runtime settings are applied once SettingsManager has loaded global/project settings.
  configureHttpDispatcher();
  exposeLocalPiCli();
  const repoDir = process.env.PI_PACKAGE_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const rawArgs = process.argv.slice(2);
  if (shouldDelegateToRealPiCli(rawArgs, Boolean(process.stdin.isTTY))) {
    process.exitCode = await delegateToRealPiCli(rawArgs);
    return;
  }
  const args = parseMainArgs(rawArgs, cwd());
  if (args.command === "status") {
    await runStatusCommand(args);
    return;
  }
  // Relocate console.{log,warn,error,...} onto the TUI before any extension can
  // log. Installed after the status early-return so plain CLI subcommands keep
  // printing to the real stdout; the sink is wired once the TUI exists below.
  installConsoleTuiBridge();
  // Install built-in packages under the same effective agent dir Pi's
  // ResourceLoader scans, so discovery and installation share one root.
  ensurePackageExtensions(repoDir, { copy: true, agentDir: defaultMixCodeAgentDir() });
  const {
    state,
    runtime,
    stateFile,
    workspaceFile,
    rootStateDir,
    completionSources,
    packageUpdateCheck,
    tabsReady,
    historyReady,
  } = await bootstrapMixCode({
    workdir: args.workdir,
  });
  const batchRequests = args.batch
    ? await loadBatchRequests(args.batch, contextFromState(state))
    : undefined;
  if (batchRequests) {
    validateBatchRequests(
      batchRequests,
      (query) => findModelRef(state.availableModels, query),
      (request) =>
        request.mode === "delete"
          ? state.model
          : (state.tabs.find((tab) => tab.title === request.name)?.model ?? state.model),
    );
  }
  const stateRoot = defaultStateDir();
  let registryWriteErrorReported = false;
  const reportRegistryWriteError = (error: unknown) => {
    if (registryWriteErrorReported) return;
    registryWriteErrorReported = true;
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`mixcode-pi instance registry update failed: ${message}\n`);
  };
  const writeRegistrySnapshot = async () => {
    try {
      await writeCurrentInstanceSnapshot(stateRoot, state);
    } catch (error) {
      reportRegistryWriteError(error);
    }
  };
  const heartbeat = setInterval(writeRegistrySnapshot, INSTANCE_HEARTBEAT_INTERVAL_MS);
  heartbeat.unref?.();
  let scheduledRegistrySnapshot: NodeJS.Timeout | undefined;
  const scheduleRegistrySnapshot = () => {
    if (scheduledRegistrySnapshot) return;
    scheduledRegistrySnapshot = setTimeout(() => {
      scheduledRegistrySnapshot = undefined;
      void writeRegistrySnapshot();
    }, 1_000);
    scheduledRegistrySnapshot.unref?.();
  };
  const removeRegistrySnapshot = () => {
    clearInterval(heartbeat);
    if (scheduledRegistrySnapshot) clearTimeout(scheduledRegistrySnapshot);
    removeInstanceSnapshotSync(stateRoot);
  };
  process.once("exit", (code) => {
    if (code === 0 || code === 130 || code === 143) removeRegistrySnapshot();
  });
  process.once("SIGINT", () => {
    removeRegistrySnapshot();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    removeRegistrySnapshot();
    process.exit(143);
  });

  const tui = createMixCodeTui(state, runtime, {
    completionSources,
    workspaceFile,
    rootStateDir,
    exitProcessOnQuit: true,
    onStateChanged: async (nextState) => {
      await saveStateFile(stateFile, nextState);
      await writeRegistrySnapshot();
    },
  });
  // Wire the console bridge to the TUI now that it exists: console output renders
  // as a dismissible Notice panel (Home and agent tabs both safe) and any backlog
  // queued during extension loading flushes here. requestRender is required
  // because scheduler-style logging fires off the input loop.
  wireConsoleSink((text) => {
    showNoticeTextOverlay(tui, text);
    tui.requestRender();
  });
  const originalRequestRender = tui.requestRender.bind(tui);
  tui.requestRender = (force?: boolean) => {
    scheduleRegistrySnapshot();
    originalRequestRender(force);
  };
  const originalStop = tui.stop.bind(tui);
  tui.stop = () => {
    removeRegistrySnapshot();
    originalStop();
  };
  runtime.onChange(() => {
    void writeRegistrySnapshot();
  });
  tui.start();
  // Registry cleanup and initial snapshot are deferred to after the first frame.
  // They are cheap on their own (~10ms), but their `await` yields the event loop
  // to the deferred background extension loading (CPU-heavy jiti compilation that
  // yields via setImmediate). When awaited before tui.start(), those yields let
  // every tab finish loading before the first frame renders, so the "Not Ready"
  // spinner never shows. Firing them after tui.start() keeps them off the
  // first-frame critical path.
  void cleanupInstanceRegistry(stateRoot).catch((err: unknown) => {
    reportRegistryWriteError(err);
  });
  void writeRegistrySnapshot();
  void tabsReady
    .then(() => {
      tui.requestRender(true);
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`Extension loading failed: ${msg}\n`);
    });
  void packageUpdateCheck()
    .then((packages) => {
      state.packageUpdates = packages;
      tui.requestRender();
    })
    .catch(() => undefined);
  // Conversation history backfill / session-index rebuild scans every persisted
  // session file, so it runs in the background after the first frame. Surface
  // any warnings into the first tab once it completes.
  void historyReady
    .then(({ warnings }) => {
      if (warnings.length === 0) return;
      state.tabs[0]?.previewMessages.push({
        role: "system",
        text: `History warning: ${warnings.join("; ")}`,
      });
      tui.requestRender();
    })
    .catch((error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(`History backfill failed: ${msg}\n`);
    });

  // Execute batch script after TUI is ready
  if (args.batch) {
    const batchHost = createBatchExecutorHost({ state, runtime, tui });
    void tabsReady
      .then(() => applyBatchRequests(batchRequests ?? [], batchHost))
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Batch error: ${msg}\n`);
        process.exitCode = 1;
      })
      .finally(() => saveStateFile(stateFile, state));
  }
}

export type MainCommand = "tui" | "status";

async function runStatusCommand(args: MainArgs): Promise<void> {
  const report = await loadLiveInstanceStatus(defaultStateDir(), { workdir: args.statusWorkdir });
  const output = args.json ? JSON.stringify(report, null, 2) : formatInstanceStatusTable(report);
  process.stdout.write(`${output}\n`);
}

export interface MainArgs {
  command: MainCommand;
  workdir: string;
  batch?: string;
  json?: boolean;
  statusWorkdir?: string;
}

const HELP_TEXT = `Usage: mixcode-pi [options]
       mixcode-pi status [--json] [--workdir <path>]

Options:
  --workdir <path>   Set working directory (default: cwd)
  --batch <file>     Execute a Lua batch script after TUI startup
  --help, -h         Show this help message

Commands:
  status             Show live mixcode-pi instances and tabs
`;

export function parseMainArgs(args: string[], fallbackWorkdir: string): MainArgs {
  const baseWorkdir = resolve(fallbackWorkdir);
  if (args[0] === "status") return parseStatusArgs(args.slice(1), baseWorkdir);

  let workdir = baseWorkdir;
  let batchPath: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error("--workdir requires a path");
      workdir = resolve(baseWorkdir, value);
      continue;
    }
    if (arg?.startsWith("--workdir=")) {
      const value = arg.slice("--workdir=".length);
      if (!value) throw new Error("--workdir requires a path");
      workdir = resolve(baseWorkdir, value);
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { command: "tui", workdir, batch: batchPath ? resolve(workdir, batchPath) : undefined };
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
    if (arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error("--workdir requires a path");
      statusWorkdir = resolve(baseWorkdir, value);
      continue;
    }
    if (arg?.startsWith("--workdir=")) {
      const value = arg.slice("--workdir=".length);
      if (!value) throw new Error("--workdir requires a path");
      statusWorkdir = resolve(baseWorkdir, value);
      continue;
    }
    throw new Error(`Unknown status argument: ${arg}`);
  }
  return { command: "status", workdir: baseWorkdir, json, statusWorkdir };
}

export function exposeLocalPiCli(
  env: NodeJS.ProcessEnv = process.env,
  entryUrl = import.meta.url,
): string {
  const repoDir = resolve(dirname(fileURLToPath(entryUrl)), "..", "..");
  const binDir = resolve(repoDir, "node_modules", ".bin");
  // In bun compiled binary, import.meta.url is a virtual path; skip if dir doesn't exist.
  if (!existsSync(binDir)) return binDir;
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
 *
 * This gate is safety-critical, not just a compatibility nicety: real pi does not
 * actually require --print to run a turn to completion — given non-TTY stdin it
 * will execute a full agentic turn (default tools include write/edit/bash) and
 * exit even without --print. Delegating on "argv merely looks foreign" (e.g. any
 * argv mixcode-pi's own parser rejects) was tried and reverted after confirming it
 * lets an unattended, non-interactive invocation with no special flags at all
 * (`mixcode-pi "some instruction"`, redirected stdin) silently escalate into a
 * live, fully-tooled agent turn. Requiring the explicit --print/-p contract closes
 * that hole: without it, unrecognized argv still surfaces mixcode-pi's own
 * "Unknown argument" error instead of ever reaching a live agent.
 *
 * The isTTY check additionally ensures a human's own typo at an interactive
 * terminal still surfaces mixcode-pi's own error instead of being redirected.
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
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env });
    child.on("error", (error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(code ?? (signal ? 1 : 0));
    });
  });
}

const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");

if (isDirectCliEntry()) {
  main().catch((error) => {
    // Bypass the console bridge here: a startup crash can happen after the bridge
    // is installed but before the TUI sink is wired, which would queue this fatal
    // error into a buffer that never flushes. Write straight to the real stderr.
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}

function isDirectCliEntry(entryUrl = import.meta.url, argv1 = process.argv[1]): boolean {
  if ((globalThis as Record<symbol, unknown>)[BINARY_ENTRY_IMPORT_FLAG]) return false;
  if (!argv1) return false;
  try {
    return fileURLToPath(entryUrl) === realpathSync(argv1);
  } catch {
    return entryUrl === `file://${argv1}`;
  }
}
