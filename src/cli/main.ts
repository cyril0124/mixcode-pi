#!/usr/bin/env node
import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import {
  applyBatchRequests,
  contextFromState,
  loadBatchRequests,
  validateBatchRequests,
  type BatchExecutorHost,
} from "../core/batch-lua.js";
import { disposeChatRenderers } from "../agent/runtime-chat.js";
import { parseInput } from "../core/commands.js";
import { createSessionId, createTab } from "../core/defaults.js";
import { findModelRef } from "../core/models.js";
import { buildModelPrompt } from "../core/prompt-build.js";
import {
  cleanupInstanceRegistry,
  formatInstanceStatusTable,
  loadLiveInstanceStatus,
  removeInstanceSnapshotSync,
  writeCurrentInstanceSnapshot,
  INSTANCE_HEARTBEAT_INTERVAL_MS,
} from "../core/instance-registry.js";
import { saveStateFile } from "../core/state-store.js";
import { MIXCODE_SYSTEM_PROMPT } from "../core/system-prompt.js";
import { activateTab } from "../core/tabs.js";
import { createMixCodeTui } from "../ui/app.js";
import { applyModelSelection, applyThinkingLevel } from "../ui/app-actions.js";
import { clearConversationCache } from "../ui/rendering.js";
import { bootstrapMixCode, DEFAULT_STATE_PORT, defaultStateDir } from "./bootstrap.js";
import { ensurePackageExtensions } from "../core/ensure-package-extensions.js";

export async function main(): Promise<void> {
  exposeLocalPiCli();
  const repoDir = process.env.PI_PACKAGE_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const args = parseMainArgs(process.argv.slice(2), cwd());
  if (args.command === "status") {
    await runStatusCommand(args);
    return;
  }
  ensurePackageExtensions(repoDir, { copy: true });
  const { state, runtime, stateFile, workspaceFile, completionSources, packageUpdateCheck } =
    await bootstrapMixCode({
      workdir: args.workdir,
    });
  const batchRequests = args.batch
    ? await loadBatchRequests(args.batch, contextFromState(state))
    : undefined;
  if (batchRequests) validateBatchRequests(batchRequests, (query) => findModelRef(state.availableModels, query));
  const stateRoot = defaultStateDir();
  await cleanupInstanceRegistry(stateRoot);
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
  await writeCurrentInstanceSnapshot(stateRoot, state);
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
    exitProcessOnQuit: true,
    onStateChanged: async (nextState) => {
      await saveStateFile(stateFile, nextState, DEFAULT_STATE_PORT);
      await writeRegistrySnapshot();
    },
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
  void packageUpdateCheck()
    .then((packages) => {
      state.packageUpdates = packages;
      tui.requestRender();
    })
    .catch(() => undefined);

  // Execute batch script after TUI is ready
  if (args.batch) {
    const batchHost: BatchExecutorHost = {
      state,
      findTabByTitle(title) {
        const tab = state.tabs.find((t) => t.title === title);
        return tab ? { sessionId: tab.sessionId } : undefined;
      },
      async createNewTab(request) {
        const sessionId = createSessionId();
        const model = request.model ? findModelRef(state.availableModels, request.model) : state.model;
        const thinking = (request.thinking as any) ?? state.thinkingLevel;
        const workdir = request.workdir ?? state.workdir;
        const tab = createTab(state.tabs.length + 1, sessionId, workdir, {
          title: request.name,
          model: { ...model },
          contextLimit: model.contextWindow,
          thinkingLevel: thinking,
        });
        state.tabs.push(tab);
        activateTab(state, sessionId);
        await runtime.createTab(tab, {
          systemPrompt: MIXCODE_SYSTEM_PROMPT,
          thinkingLevel: thinking,
          workdir,
          model: runtime.resolveModel(model.provider, model.modelId),
        });
        // Persist the tab name so bootstrap restores it correctly
        runtime.renameSession(sessionId, request.name);
        return sessionId;
      },
      async configureTab(sessionId, options) {
        const tab = state.tabs.find((t) => t.sessionId === sessionId);
        if (!tab) throw new Error(`Cannot configure unknown tab: ${sessionId}`);
        if (options.model) applyModelSelection(state, tab, options.model, runtime);
        if (options.thinking) applyThinkingLevel(state, tab, options.thinking, runtime);
      },
      async clearTab(sessionId) {
        const tab = state.tabs.find((t) => t.sessionId === sessionId);
        if (!tab) throw new Error(`Cannot clear unknown tab: ${sessionId}`);
        const runtimeTab = runtime.getTab(sessionId);
        if (runtimeTab) {
          disposeChatRenderers(runtimeTab.chat);
          runtimeTab.chat = [];
          runtimeTab.reasoning = [];
        }
        tab.previewMessages = [];
        tab.previewIndex = 0;
        tab.chatScrollOffset = 0;
        tab.status = "idle";
        tab.workingStartedAt = undefined;
        tab.lastWorkedDurationSeconds = undefined;
        clearConversationCache(sessionId);
        tui.requestRender();
        const originalTitle = tab.title;
        const cleared = await runtime.clearTab!(sessionId, {
          systemPrompt: MIXCODE_SYSTEM_PROMPT,
          thinkingLevel: tab.thinkingLevel,
          workdir: tab.workdir,
        });
        runtime.renameSession(cleared.tab.sessionId, originalTitle);
        activateTab(state, cleared.tab.sessionId);
        clearConversationCache(cleared.tab.sessionId);
        tui.requestRender();
        return cleared.tab.sessionId;
      },
      async submitInput(sessionId, input) {
        const parsed = parseInput(input);
        if (parsed.kind === "prompt") {
          const runtimeTab = runtime.getTab(sessionId);
          const knownSkills = runtimeTab?.services?.resourceLoader
            ?.getSkills()
            .skills.map((s: any) => ({ name: s.name, filePath: s.filePath, baseDir: s.baseDir }))
            ?? undefined;
          const promptTemplates = runtimeTab?.services?.resourceLoader
            ?.getPrompts()
            .prompts.map((p: any) => ({
              name: p.name, description: p.description, argumentHint: p.argumentHint,
              content: p.content, filePath: p.filePath,
              sourceInfo: p.sourceInfo ? { scope: p.sourceInfo.scope, source: p.sourceInfo.source } : undefined,
            }))
            ?? undefined;
          const tab = state.tabs.find((t) => t.sessionId === sessionId);
          const workdir = tab?.workdir ?? state.workdir;
          const built = await buildModelPrompt(parsed.args, workdir, { knownSkills, promptTemplates });
          // Fire-and-forget: don't await agent completion
          void runtime.prompt(sessionId, built);
        } else if (parsed.kind === "shell") {
          void runtime.executeShellCommand(sessionId, parsed.args, {
            excludeFromContext: parsed.excludeFromContext === true,
          });
        } else {
          void runtime.prompt(sessionId, input);
        }
      },
      resolveModel(query) {
        return findModelRef(state.availableModels, query);
      },
    };
    void applyBatchRequests(batchRequests ?? [], batchHost)
      .then(() => saveStateFile(stateFile, state, DEFAULT_STATE_PORT))
      .catch((error: unknown) => {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`Batch error: ${msg}\n`);
        process.exitCode = 1;
      });
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

const BINARY_ENTRY_IMPORT_FLAG = Symbol.for("mixcode-pi.binary-entry-import");

if (isDirectCliEntry()) {
  main().catch((error) => {
    console.error(error);
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
