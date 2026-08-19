#!/usr/bin/env bun
/**
 * Install recommended third-party Pi packages (settings.json packages).
 *
 * Thin CLI wrapper around src/cli/install-extensions.ts, which owns the
 * recommended list and installs in-process via pi-coding-agent's
 * DefaultPackageManager (no external `pi` CLI needed). The compiled binary
 * exposes the same flow as `mpi install-extensions`.
 *
 * Usage:
 *   bun run scripts/install-pi-extensions.ts              # clack UI if TTY
 *   bun run scripts/install-pi-extensions.ts --yes        # install missing, no UI
 *   bun run scripts/install-pi-extensions.ts --postinstall
 *     From package postinstall: skip when all installed / CI / non-TTY;
 *     never fails the parent install.
 */

type Mode = "interactive" | "yes" | "postinstall";

function parseMode(argv: string[]): Mode {
  if (argv.includes("--postinstall")) return "postinstall";
  if (argv.includes("--yes") || argv.includes("-y")) return "yes";
  return "interactive";
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("-h") || argv.includes("--help")) {
    console.log(`Usage:
  bun run scripts/install-pi-extensions.ts
  bun run scripts/install-pi-extensions.ts --yes
  bun run scripts/install-pi-extensions.ts --postinstall

Installs recommended third-party Pi packages in-process.
Skips packages already listed in <agentDir>/settings.json packages.`);
    return;
  }
  // Lazy import keeps postinstall's failure surface inside the catch below.
  const { runInstallExtensionsFlow } = await import("../src/cli/install-extensions.js");
  await runInstallExtensionsFlow(parseMode(argv), "bun run install:extensions");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  // Never break bun install / install.sh
  if (process.argv.includes("--postinstall")) return;
  process.exitCode = 1;
});
