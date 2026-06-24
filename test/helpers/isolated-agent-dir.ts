import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after } from "node:test";

// Isolate the Pi agent directory for tests that construct a MixCodeRuntime
// without an explicit agentDir. Without this, runtime services fall back to the
// developer's global `~/.pi/agent`, which loads whatever extensions/skills are
// installed there (e.g. a `ponytail` extension) and leaks "Extension ... loaded"
// system messages / status widgets into runtimes the test expected to be empty.
//
// Importing this module sets PI_CODING_AGENT_DIR to a fresh empty temp dir as a
// side effect. getAgentDir() reads that env var as its default, while tests that
// pass an explicit `agentDir` option still win, so this only affects the
// otherwise-global default. Idempotent: only the first import creates the dir.
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

process.env[ENV_AGENT_DIR] = mkdtempSync(join(tmpdir(), "mixcode-test-agent-"));

export const isolatedAgentDir = process.env[ENV_AGENT_DIR]!;

after(() => {
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});
