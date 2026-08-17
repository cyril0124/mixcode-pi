import { cwd } from "node:process";
import * as path from "node:path";
import {
  createAgentSessionFromServices,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createRuntimeServices } from "../agent/runtime-lifecycle.js";
import { LOCAL_COMMANDS } from "../core/commands.js";
import { ensurePackageExtensions } from "../core/ensure-package-extensions.js";
import { expandTilde } from "./status.js";

export type CommandListSource = "local" | "extension" | "prompt";

export interface CommandListEntry {
  name: string;
  usage: string;
  description: string;
  source: CommandListSource;
  /** Extension or prompt file/directory from Pi sourceInfo.path. */
  path?: string;
}

export interface CommandsCliArgs {
  json?: boolean;
  workdir?: string;
  help?: boolean;
}

export function isCommandsCliArgs(args: string[]): boolean {
  return args[0] === "commands";
}

export function parseCommandsArgs(args: string[], fallbackWorkdir: string): CommandsCliArgs {
  const baseWorkdir = path.resolve(fallbackWorkdir);
  let json = false;
  let workdir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--workdir") {
      const value = args[++index];
      if (!value) throw new Error("--workdir requires a path");
      workdir = path.resolve(baseWorkdir, expandTilde(value));
      continue;
    }
    if (arg?.startsWith("--workdir=")) {
      const value = arg.slice("--workdir=".length);
      if (!value) throw new Error("--workdir requires a path");
      workdir = path.resolve(baseWorkdir, expandTilde(value));
      continue;
    }
    if (arg?.startsWith("-")) throw new Error(`Unknown commands argument: ${arg}`);
    throw new Error(`Unexpected argument: ${arg}`);
  }
  return { json, workdir };
}

export function formatCommandUsage(name: string, argumentHint?: string): string {
  const hint = argumentHint?.trim();
  return hint ? `/${name} ${hint}` : `/${name}`;
}

export function mergeCommandCatalog(parts: {
  local?: Array<{ name: string; description: string; argumentHint?: string }>;
  extension?: Array<{ name: string; description?: string; path?: string }>;
  prompt?: Array<{ name: string; description?: string; argumentHint?: string; path?: string }>;
}): CommandListEntry[] {
  const map = new Map<string, CommandListEntry>();
  for (const command of parts.local ?? []) {
    map.set(command.name, {
      name: command.name,
      usage: formatCommandUsage(command.name, command.argumentHint),
      description: command.description,
      source: "local",
    });
  }
  const add = (
    name: string,
    source: Exclude<CommandListSource, "local">,
    description?: string,
    argumentHint?: string,
    filePath?: string,
  ) => {
    if (map.has(name)) return;
    map.set(name, {
      name,
      usage: formatCommandUsage(name, argumentHint),
      description: description ?? "",
      source,
      ...(filePath ? { path: filePath } : {}),
    });
  };
  for (const command of parts.extension ?? []) {
    add(command.name, "extension", command.description, undefined, command.path);
  }
  for (const command of parts.prompt ?? []) {
    add(command.name, "prompt", command.description, command.argumentHint, command.path);
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function formatCommandCatalog(entries: CommandListEntry[]): string {
  return entries.map((entry) => `${entry.usage}\n  ${entry.description}`).join("\n\n");
}

export async function loadCommandCatalog(options: {
  workdir: string;
  agentDir?: string;
  packageRoot?: string;
  additionalExtensionPaths?: string[];
}): Promise<CommandListEntry[]> {
  const agentDir = options.agentDir ?? getAgentDir();
  if (options.packageRoot) {
    ensurePackageExtensions(options.packageRoot, { copy: true, agentDir });
  }
  const services = await createRuntimeServices({
    workdir: options.workdir,
    agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
  });
  const { session } = await createAgentSessionFromServices({
    services,
    sessionManager: SessionManager.inMemory(options.workdir),
  });
  const extension = session.extensionRunner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description,
    path: command.sourceInfo.path,
  }));
  const prompt = services.resourceLoader.getPrompts().prompts.map((template) => ({
    name: template.name,
    description: template.description,
    argumentHint: template.argumentHint,
    path: template.sourceInfo.path ?? template.filePath,
  }));
  return mergeCommandCatalog({
    local: LOCAL_COMMANDS,
    extension,
    prompt,
  });
}

export const COMMANDS_HELP = `Usage: mpi commands [--json] [--workdir <path>]

List slash commands available for this workdir (local, extension, prompt).
`;

export async function runCommandsCommand(
  rawArgs: string[],
  options: { fallbackWorkdir?: string; packageRoot?: string; agentDir?: string } = {},
): Promise<void> {
  const parsed = parseCommandsArgs(rawArgs, options.fallbackWorkdir ?? cwd());
  if (parsed.help) {
    process.stdout.write(`${COMMANDS_HELP}\n`);
    return;
  }
  const workdir = parsed.workdir ?? path.resolve(options.fallbackWorkdir ?? cwd());
  const catalog = await loadCommandCatalog({
    workdir,
    agentDir: options.agentDir,
    packageRoot: options.packageRoot,
  });
  if (parsed.json) {
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }
  process.stdout.write(catalog.length === 0 ? "" : `${formatCommandCatalog(catalog)}\n`);
}
