import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after } from "node:test";

// Isolate the Pi agent directory for tests that construct a MixCodeRuntime
// without an explicit agentDir. Without this, runtime services fall back to the
// developer's global `~/.pi/agent`, which loads whatever extensions/skills are
// installed there and leaks "Extension ... loaded" system messages / status
// widgets into runtimes the test expected to be empty.
//
// Importing this module sets PI_CODING_AGENT_DIR to a fresh empty temp dir as a
// side effect. Clear PI_PACKAGE_DIR so unit tests use the published coding-agent
// package identity. Tests that pass an explicit `agentDir` option still win.
// Idempotent: only the first import creates the dir.

// Prevent a leftover binary runtime dir from rebranding APP_NAME to "mixcode"
// and making PI_CODING_AGENT_DIR isolation ineffective.
delete process.env.PI_PACKAGE_DIR;

const isolatedAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-test-agent-"));
process.env.PI_CODING_AGENT_DIR = isolatedAgentDir;
// Unit tests must not depend on provider catalog network availability.
process.env.PI_OFFLINE = "1";

export { isolatedAgentDir };

after(() => {
  fs.rmSync(isolatedAgentDir, { recursive: true, force: true });
});
