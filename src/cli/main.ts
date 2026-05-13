#!/usr/bin/env node
import { dirname, resolve } from "node:path";
import { cwd } from "node:process";
import { fileURLToPath } from "node:url";
import { saveStateFile } from "../core/state-store.js";
import { createMixCodeTui } from "../ui/app.js";
import { bootstrapMixCode, DEFAULT_STATE_PORT } from "./bootstrap.js";

export async function main(): Promise<void> {
  exposeLocalPiCli();
  const args = parseMainArgs(process.argv.slice(2), cwd());
  const { state, runtime, stateFile, workspaceFile, completionSources, packageUpdateCheck } =
    await bootstrapMixCode({
      workdir: args.workdir,
    });
  const tui = createMixCodeTui(state, runtime, {
    completionSources,
    workspaceFile,
    onStateChanged: async (nextState) => saveStateFile(stateFile, nextState, DEFAULT_STATE_PORT),
  });
  tui.start();
  void packageUpdateCheck()
    .then((packages) => {
      state.packageUpdates = packages;
      tui.requestRender();
    })
    .catch(() => undefined);
}

export function parseMainArgs(args: string[], fallbackWorkdir: string): { workdir: string } {
  const baseWorkdir = resolve(fallbackWorkdir);
  let workdir = baseWorkdir;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
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
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { workdir };
}

export function exposeLocalPiCli(
  env: NodeJS.ProcessEnv = process.env,
  entryUrl = import.meta.url,
): string {
  const repoDir = resolve(dirname(fileURLToPath(entryUrl)), "..", "..");
  const binDir = resolve(repoDir, "node_modules", ".bin");
  const delimiter = process.platform === "win32" ? ";" : ":";
  const parts = (env.PATH ?? "").split(delimiter).filter(Boolean);
  if (!parts.includes(binDir)) {
    env.PATH = [binDir, ...parts].join(delimiter);
  }
  return binDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
