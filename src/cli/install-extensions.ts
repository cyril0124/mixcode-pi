// Recommended third-party Pi extension install flow, shared by:
//   - scripts/install-pi-extensions.ts (repo postinstall / manual script)
//   - `mpi install-extensions` CLI subcommand (compiled binary ships no repo scripts)
//   - the compiled binary's one-time first-run offer (maybeOfferFirstRunInstall)
//
// Installs run in-process through pi-coding-agent's public DefaultPackageManager
// (the same code path as `pi install`), so no external `pi` CLI is required.
// pi-coding-agent is imported lazily: it eagerly reads PI_PACKAGE_DIR at import
// time, which the binary's status/ctl fast paths must never trigger.
//
// Built-in packages under pi-packages/ are loaded by the app itself — do not
// list them here or tools/widgets can double-register.
import { styleText } from "node:util";
import * as p from "@clack/prompts";
import { resolveMixcodeAgentDir, resolveMixcodeStateDir } from "../core/paths.js";
import * as path from "node:path";

const pc = {
  green: (s: string) => styleText("green", s),
  red: (s: string) => styleText("red", s),
  yellow: (s: string) => styleText("yellow", s),
  dim: (s: string) => styleText("dim", s),
  bgCyan: (s: string) => styleText("bgCyan", s),
  black: (s: string) => styleText("black", s),
};

export type InstallExtensionsMode = "interactive" | "yes" | "postinstall";

export interface RecommendedExtension {
  /** Exact source string written by `pi install` into settings.packages. */
  source: string;
  /** Short display name in the multiselect. */
  label: string;
  /** Dim hint next to the label. */
  hint: string;
}

export const RECOMMENDED: RecommendedExtension[] = [
  {
    source: "npm:@juicesharp/rpiv-ask-user-question",
    label: "ask-user-question",
    hint: "structured multi-choice questions",
  },
  {
    source: "npm:@narumitw/pi-btw",
    label: "pi-btw",
    hint: "side comments while the agent works",
  },
  {
    source: "npm:pi-schedule-prompt",
    label: "pi-schedule-prompt",
    hint: "cron / delayed prompts",
  },
  {
    source: "npm:@tintinweb/pi-subagents",
    label: "pi-subagents",
    hint: "spawn and manage subagents",
  },
  {
    source: "npm:@tintinweb/pi-tasks",
    label: "pi-tasks",
    hint: "task list for multi-step work",
  },
  {
    source: "npm:pi-invisible-continue",
    label: "pi-invisible-continue",
    hint: "quiet auto-continue hooks",
  },
  {
    source: "npm:@monotykamary/pi-tps",
    label: "pi-tps",
    hint: "tokens-per-second footer",
  },
  {
    source: "npm:@ogulcancelik/pi-session-recall",
    label: "pi-session-recall",
    hint: "search and recall past sessions",
  },
];

/** `mpi install-extensions ...` argv detection, mirroring status/ctl routing. */
export function isInstallExtensionsCliArgs(args: string[]): boolean {
  return args[0] === "install-extensions";
}

async function readInstalledSources(env: NodeJS.ProcessEnv): Promise<Set<string>> {
  const settingsPath = path.join(resolveMixcodeAgentDir(env), "settings.json");
  try {
    const data = (await Bun.file(settingsPath).json()) as { packages?: string[] };
    return new Set(data.packages ?? []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read ${settingsPath}: ${message}`, { cause: error });
  }
}

/** Recommended extensions absent from global settings.packages. Throws on malformed settings.json. */
export async function missingExtensions(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RecommendedExtension[]> {
  const installed = await readInstalledSources(env);
  return RECOMMENDED.filter((ext) => !installed.has(ext.source));
}

/**
 * First-run offer marker. Existence means the binary already asked once;
 * the offer never repeats regardless of the answer.
 */
export function firstRunMarkerPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(resolveMixcodeStateDir(env), "extensions-prompt-asked");
}

export async function hasAskedFirstRun(env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
  return await Bun.file(firstRunMarkerPath(env)).exists();
}

export async function writeFirstRunMarker(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  await Bun.write(firstRunMarkerPath(env), `${new Date().toISOString()}\n`);
}

interface InstallResult {
  ok: string[];
  failed: Array<{ source: string; error: string }>;
}

type PackageManagerLike = { installAndPersist(source: string): Promise<void> };

async function createPackageManager(env: NodeJS.ProcessEnv): Promise<PackageManagerLike> {
  const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const cwd = process.cwd();
  const agentDir = resolveMixcodeAgentDir(env);
  const settingsManager = SettingsManager.create(cwd, agentDir);
  return new DefaultPackageManager({ cwd, agentDir, settingsManager });
}

// The package manager inherits stdio for npm output, so no spinner: it would
// garble the raw npm progress lines interleaved with ours.
async function installSelected(sources: string[], env: NodeJS.ProcessEnv): Promise<InstallResult> {
  const pm = await createPackageManager(env);
  const ok: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];
  for (const source of sources) {
    console.log(`Installing ${source} ...`);
    try {
      await pm.installAndPersist(source);
      ok.push(source);
      console.log("  ok");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failed.push({ source, error: message });
      console.error(`  fail: ${message}`);
    }
  }
  return { ok, failed };
}

function reportResults({ ok, failed }: InstallResult, retryHint: string): void {
  if (ok.length > 0) {
    p.note(ok.map((s) => pc.green(`✓ ${s}`)).join("\n"), "Installed");
  }
  if (failed.length > 0) {
    p.note(failed.map((f) => pc.red(`✗ ${f.source}\n  ${f.error}`)).join("\n"), "Failed");
  }
  if (failed.length === 0) {
    p.outro(pc.green("Done!") + pc.dim("  Restart pi/mpi to load new extensions."));
  } else {
    p.outro(pc.yellow(`Finished with ${failed.length} failure(s).`) + pc.dim(`  Re-run: ${retryHint}`));
  }
}

/**
 * Shared install flow. `retryHint` is the caller-appropriate re-run command
 * (`bun run install:extensions` from the repo script, `mpi install-extensions`
 * from the binary subcommand). Sets process.exitCode = 1 on failures except in
 * postinstall mode, which must never fail the parent install.
 */
export async function runInstallExtensionsFlow(
  mode: InstallExtensionsMode,
  retryHint: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const missing = await missingExtensions(env);

  // Quiet success when everything is already present.
  if (missing.length === 0) {
    if (mode === "postinstall") return;
    if (mode === "yes") {
      console.log(`All ${RECOMMENDED.length} recommended pi extensions are already installed.`);
      return;
    }
    p.intro(pc.bgCyan(pc.black(" mixcode-pi ")));
    p.outro(
      pc.green("All recommended pi extensions are already installed.") + pc.dim("  Nothing to do."),
    );
    return;
  }

  if (mode === "postinstall") {
    const ci = Boolean(env.CI || env.CONTINUOUS_INTEGRATION);
    const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (ci || !tty) {
      console.error(
        `mixcode-pi: ${missing.length} recommended pi extension(s) not installed. Run: ${retryHint}`,
      );
      return;
    }
  }

  if (mode === "yes") {
    const result = await installSelected(
      missing.map((m) => m.source),
      env,
    );
    console.log(`Done. Installed ${result.ok.length}, failed ${result.failed.length}.`);
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }

  // Interactive clack UI (skills-style).
  p.intro(pc.bgCyan(pc.black(" mixcode-pi ")));
  p.log.message(
    pc.dim(`${missing.length} of ${RECOMMENDED.length} recommended Pi extensions are not installed yet.`),
  );

  const selected = await p.multiselect({
    message: "Select extensions to install",
    options: missing.map((ext) => ({
      value: ext.source,
      label: ext.label,
      hint: ext.hint,
    })),
    initialValues: missing.map((ext) => ext.source),
    required: false,
  });

  if (p.isCancel(selected)) {
    p.cancel("Skipped extension install.");
    return;
  }

  if (selected.length === 0) {
    p.outro(pc.dim("No extensions selected."));
    return;
  }

  p.note(selected.map((s) => `• ${s}`).join("\n"), "Installation summary");

  const confirmed = await p.confirm({
    message: "Proceed with installation?",
    initialValue: true,
  });

  if (p.isCancel(confirmed) || !confirmed) {
    p.cancel("Skipped extension install.");
    return;
  }

  const result = await installSelected(selected, env);
  reportResults(result, retryHint);
  if (result.failed.length > 0 && mode !== "postinstall") process.exitCode = 1;
}

const SUBCOMMAND_USAGE = `Usage: mpi install-extensions [--yes]

Install recommended third-party Pi extensions (multi-select UI).

Options:
  --yes, -y   Install all missing extensions without prompting
  -h, --help  Show this help`;

/** `mpi install-extensions` entry. Fails loud (exit 1) on unknown arguments. */
export async function runInstallExtensionsCommand(argv: string[]): Promise<void> {
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(SUBCOMMAND_USAGE);
    return;
  }
  const unknown = argv.filter((arg) => arg !== "--yes" && arg !== "-y");
  if (unknown.length > 0) {
    console.error(`Unknown argument: ${unknown[0]}\n${SUBCOMMAND_USAGE}`);
    process.exitCode = 1;
    return;
  }
  const mode: InstallExtensionsMode = argv.length > 0 ? "yes" : "interactive";
  await runInstallExtensionsFlow(mode, "mpi install-extensions");
}

/**
 * One-time first-run offer for the compiled binary (source installs get the
 * same offer from postinstall). Asks a single y/n and installs all missing
 * recommended extensions on yes. The marker is written before prompting so an
 * interrupted prompt still never nags twice; `mpi install-extensions` remains
 * available afterwards. No-op when: not a TTY, PI_OFFLINE, already asked, or
 * nothing missing.
 */
export async function maybeOfferFirstRunInstall(
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;
  if (env.PI_OFFLINE) return;
  if (await hasAskedFirstRun(env)) return;
  const missing = await missingExtensions(env);
  await writeFirstRunMarker(env);
  if (missing.length === 0) return;

  p.intro(pc.bgCyan(pc.black(" mixcode-pi ")));
  p.log.message(
    pc.dim(`First run: ${missing.length} of ${RECOMMENDED.length} recommended Pi extensions are not installed.`),
  );
  const confirmed = await p.confirm({
    message: `Install ${missing.length} recommended Pi extension(s) now?`,
    initialValue: true,
  });
  if (p.isCancel(confirmed) || !confirmed) {
    p.outro(pc.dim("Skipped. Run `mpi install-extensions` anytime."));
    return;
  }
  const result = await installSelected(
    missing.map((m) => m.source),
    env,
  );
  reportResults(result, "mpi install-extensions");
}
