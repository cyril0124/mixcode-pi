import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

test("extension postinstall reports malformed settings instead of treating them as empty", async () => {
  const agentDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-install-settings-error-"));
  try {
    await fsPromises.writeFile(path.join(agentDir, "settings.json"), "{ malformed", "utf8");
    const child = Bun.spawn(
      [process.execPath, "run", "scripts/install-pi-extensions.ts", "--postinstall"],
      {
        cwd: process.cwd(),
        env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    assert.equal(exitCode, 0);
    assert.match(stderr, /settings\.json.*(?:parse|JSON)/i);
    assert.doesNotMatch(stderr, /recommended pi extension\(s\) not installed/i);
  } finally {
    await fsPromises.rm(agentDir, { recursive: true, force: true });
  }
});
