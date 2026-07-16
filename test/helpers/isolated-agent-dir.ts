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
// Importing this module sets the agent-dir env vars to a fresh empty temp dir as
// a side effect. getAgentDir() reads ENV_AGENT_DIR derived from package
// piConfig.name: plain pi package → PI_CODING_AGENT_DIR; mixcode binary package
// (PI_PACKAGE_DIR) → MIXCODE_CODING_AGENT_DIR. Set both, and clear PI_PACKAGE_DIR
// so unit tests use the published coding-agent package identity.
//
// Tests that pass an explicit `agentDir` option still win. Idempotent: only the
// first import creates the dir.
const ENV_AGENT_DIRS = ["PI_CODING_AGENT_DIR", "MIXCODE_CODING_AGENT_DIR"] as const;

// Prevent a leftover binary runtime dir from rebranding APP_NAME to "mixcode"
// and making PI_CODING_AGENT_DIR isolation ineffective.
delete process.env.PI_PACKAGE_DIR;

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "mixcode-test-agent-"));
for (const key of ENV_AGENT_DIRS) {
  process.env[key] = isolatedAgentDir;
}

export { isolatedAgentDir };

after(() => {
  rmSync(isolatedAgentDir, { recursive: true, force: true });
});
