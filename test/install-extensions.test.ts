import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  RECOMMENDED,
  firstRunMarkerPath,
  hasAskedFirstRun,
  isInstallExtensionsCliArgs,
  maybeOfferFirstRunInstall,
  missingExtensions,
  runInstallExtensionsCommand,
  writeFirstRunMarker,
} from "../src/cli/install-extensions.js";

async function withAgentDir<T>(run: (env: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
  const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-install-ext-"));
  try {
    return await run({ PI_CODING_AGENT_DIR: agentDir } as NodeJS.ProcessEnv);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
}

test("missingExtensions reports all recommended when settings.json is absent", async () => {
  await withAgentDir(async (env) => {
    const missing = await missingExtensions(env);
    assert.deepEqual(
      missing.map((m) => m.source),
      RECOMMENDED.map((r) => r.source),
    );
  });
});

test("missingExtensions skips sources already present in settings.packages", async () => {
  await withAgentDir(async (env) => {
    const installed = [RECOMMENDED[0].source, RECOMMENDED[2].source];
    await fsPromises.writeFile(
      path.join(env.PI_CODING_AGENT_DIR as string, "settings.json"),
      JSON.stringify({ packages: installed }),
      "utf8",
    );
    const missing = await missingExtensions(env);
    assert.equal(missing.length, RECOMMENDED.length - installed.length);
    for (const source of installed) {
      assert.ok(!missing.some((m) => m.source === source));
    }
  });
});

test("first-run marker round-trip lives under <agentDir>/mixcode-pi", async () => {
  await withAgentDir(async (env) => {
    assert.equal(await hasAskedFirstRun(env), false);
    await writeFirstRunMarker(env);
    assert.equal(await hasAskedFirstRun(env), true);
    assert.equal(
      firstRunMarkerPath(env),
      path.join(env.PI_CODING_AGENT_DIR as string, "mixcode-pi", "extensions-prompt-asked"),
    );
  });
});

// Guards the tmux/CI contract: a non-TTY start must neither block on a prompt
// nor consume the one-time offer.
test("maybeOfferFirstRunInstall is a no-op without a TTY", async () => {
  await withAgentDir(async (env) => {
    assert.ok(!(process.stdin.isTTY && process.stdout.isTTY));
    await maybeOfferFirstRunInstall(env);
    assert.equal(await hasAskedFirstRun(env), false);
  });
});

test("install-extensions subcommand rejects unknown arguments with exit code 1", async () => {
  const previousExitCode = process.exitCode;
  try {
    assert.ok(isInstallExtensionsCliArgs(["install-extensions"]));
    assert.ok(!isInstallExtensionsCliArgs(["status"]));
    await runInstallExtensionsCommand(["--bogus"]);
    assert.equal(process.exitCode, 1);
  } finally {
    // Bun latches a nonzero exitCode when restored to undefined; force 0.
    process.exitCode = previousExitCode ?? 0;
  }
});
