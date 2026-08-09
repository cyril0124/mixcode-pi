#!/usr/bin/env bun
/**
 * Install recommended third-party Pi packages (settings.json packages).
 *
 * Built-in packages under pi-packages/ are loaded by the app itself — do not
 * list them here or tools/widgets can double-register.
 *
 * Usage:
 *   bun run scripts/install-pi-extensions.ts              # clack UI if TTY
 *   bun run scripts/install-pi-extensions.ts --yes        # install missing, no UI
 *   bun run scripts/install-pi-extensions.ts --postinstall
 *     From package postinstall: skip when all installed / CI / non-TTY;
 *     never fails the parent install.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { styleText } from "node:util";
import * as p from "@clack/prompts";

const pc = {
  green: (s: string) => styleText("green", s),
  red: (s: string) => styleText("red", s),
  yellow: (s: string) => styleText("yellow", s),
  dim: (s: string) => styleText("dim", s),
  bgCyan: (s: string) => styleText("bgCyan", s),
  black: (s: string) => styleText("black", s),
};

type Mode = "interactive" | "yes" | "postinstall";

type RecommendedExtension = {
  /** Exact source string written by `pi install` into settings.packages. */
  source: string;
  /** Short display name in the multiselect. */
  label: string;
  /** Dim hint next to the label. */
  hint: string;
};

// Keep in sync with docs / install-pi-extensions.sh wrapper comments.
const RECOMMENDED: RecommendedExtension[] = [
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
    source: "npm:pi-tool-display",
    label: "pi-tool-display",
    hint: "richer tool call rendering",
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
];

function parseMode(argv: string[]): Mode {
  if (argv.includes("--postinstall")) return "postinstall";
  if (argv.includes("--yes") || argv.includes("-y")) return "yes";
  return "interactive";
}

function agentDir(): string {
  // Match MixCode product resolution: MIXCODE → PI → default.
  return (
    process.env.MIXCODE_CODING_AGENT_DIR ||
    process.env.PI_CODING_AGENT_DIR ||
    path.join(os.homedir(), ".pi", "agent")
  );
}

/** Env so `pi install` writes into the same agentDir MixCode uses. */
function piInstallEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PI_CODING_AGENT_DIR: agentDir() };
}

function readInstalledSources(): Set<string> {
  const settingsPath = path.join(agentDir(), "settings.json");
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as { packages?: string[] };
    return new Set(data.packages ?? []);
  } catch {
    return new Set();
  }
}

function missingExtensions(): RecommendedExtension[] {
  const installed = readInstalledSources();
  return RECOMMENDED.filter((ext) => !installed.has(ext.source));
}

function isCi(): boolean {
  return Boolean(process.env.CI || process.env.CONTINUOUS_INTEGRATION);
}

function hasTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

function whichPi(): string | undefined {
  const result = spawnSync("sh", ["-c", "command -v pi"], { encoding: "utf8" });
  const out = result.stdout?.trim();
  return out || undefined;
}

function installOne(source: string): { ok: boolean; error?: string } {
  const pi = whichPi();
  if (!pi) return { ok: false, error: "pi CLI not found on PATH" };
  const result = spawnSync(pi, ["install", source], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: piInstallEnv(),
  });
  if (result.status === 0) return { ok: true };
  const err = (result.stderr || result.stdout || `exit ${result.status}`).trim();
  return { ok: false, error: err || `exit ${result.status}` };
}

async function installSelected(sources: string[], showSpinner: boolean): Promise<{ ok: string[]; failed: Array<{ source: string; error: string }> }> {
  const ok: string[] = [];
  const failed: Array<{ source: string; error: string }> = [];

  if (showSpinner) {
    const spin = p.spinner();
    for (const source of sources) {
      spin.start(`Installing ${source}`);
      const result = installOne(source);
      if (result.ok) {
        ok.push(source);
        spin.stop(pc.green(`Installed ${source}`));
      } else {
        failed.push({ source, error: result.error ?? "unknown error" });
        spin.stop(pc.red(`Failed ${source}`));
      }
    }
  } else {
    for (const source of sources) {
      console.log(`Installing ${source} ...`);
      const result = installOne(source);
      if (result.ok) {
        ok.push(source);
        console.log(`  ok`);
      } else {
        failed.push({ source, error: result.error ?? "unknown error" });
        console.error(`  fail: ${result.error}`);
      }
    }
  }

  return { ok, failed };
}

function printHelp(): void {
  console.log(`Usage:
  bun run scripts/install-pi-extensions.ts
  bun run scripts/install-pi-extensions.ts --yes
  bun run scripts/install-pi-extensions.ts --postinstall

Installs recommended third-party Pi packages via \`pi install\`.
Skips packages already listed in <agentDir>/settings.json packages.`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const mode = parseMode(argv);
  const missing = missingExtensions();

  // Quiet success when everything is already present.
  if (missing.length === 0) {
    if (mode === "postinstall") return;
    if (mode === "yes") {
      console.log(`All ${RECOMMENDED.length} recommended pi extensions are already installed.`);
      return;
    }
    p.intro(pc.bgCyan(pc.black(" mixcode-pi ")));
    p.outro(pc.green("All recommended pi extensions are already installed.") + pc.dim("  Nothing to do."));
    return;
  }

  if (mode === "postinstall") {
    if (isCi() || !hasTty()) {
      console.error(
        `mixcode-pi: ${missing.length} recommended pi extension(s) not installed. Run: bun run install:extensions`,
      );
      return;
    }
  }

  if (mode === "yes") {
    if (!whichPi()) {
      console.error("Error: 'pi' CLI not found. Install @earendil-works/pi-coding-agent, then re-run.");
      if (mode === "yes") process.exitCode = 1;
      return;
    }
    const { ok, failed } = await installSelected(
      missing.map((m) => m.source),
      false,
    );
    console.log(`Done. Installed ${ok.length}, failed ${failed.length}.`);
    if (failed.length > 0) process.exitCode = 1;
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

  if (!whichPi()) {
    p.log.error(
      `'pi' CLI not found on PATH. Install with: npm i -g @earendil-works/pi-coding-agent`,
    );
    p.outro(pc.yellow("Install pi first, then re-run: bun run install:extensions"));
    return;
  }

  const { ok, failed } = await installSelected(selected, true);

  if (ok.length > 0) {
    p.note(ok.map((s) => pc.green(`✓ ${s}`)).join("\n"), "Installed");
  }
  if (failed.length > 0) {
    p.note(failed.map((f) => pc.red(`✗ ${f.source}\n  ${f.error}`)).join("\n"), "Failed");
  }

  if (failed.length === 0) {
    p.outro(pc.green("Done!") + pc.dim("  Restart pi/mpi to load new extensions."));
  } else {
    p.outro(pc.yellow(`Finished with ${failed.length} failure(s).`) + pc.dim("  Re-run: bun run install:extensions"));
    // postinstall must not fail the parent install
    if (mode !== "postinstall") process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  // Never break bun install / install.sh
  if (process.argv.includes("--postinstall")) return;
  process.exitCode = 1;
});
