// The flag mpi-bash reads from mpi-tool-display decides whether bash demands a `description`.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { compactBashCallRowEnabled, TOOL_DISPLAY_CONFIG_FILENAME } from "./tool-display-config.js";

function withAgentDir(config: string | undefined, run: (agentDir: string) => void): void {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mpi-bash-compact-flag-"));
  try {
    if (config !== undefined) {
      fs.writeFileSync(path.join(agentDir, TOOL_DISPLAY_CONFIG_FILENAME), config);
    }
    run(agentDir);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
}

test("an absent display config keeps the compact row's label requirement on", () => {
  withAgentDir(undefined, (agentDir) => {
    assert.equal(compactBashCallRowEnabled(agentDir), true);
  });
});

test("the display config decides the requirement", () => {
  withAgentDir('{"compactBashCallRow": false}\n', (agentDir) => {
    assert.equal(compactBashCallRowEnabled(agentDir), false, "an explicit off drops the label");
  });
  withAgentDir('{"showRawToolArguments": true, "compactBashCallRow": true}\n', (agentDir) => {
    assert.equal(compactBashCallRowEnabled(agentDir), true);
  });
  withAgentDir('{"showRawToolArguments": true}\n', (agentDir) => {
    assert.equal(
      compactBashCallRowEnabled(agentDir),
      true,
      "a missing key uses the owner's default",
    );
  });
});

test("an unreadable or malformed display config leaves the requirement off", () => {
  // The owner rejects unknown keys, so it renders no compact row and bash asks for no label.
  withAgentDir('{"compactBashCallRow": true, "bogus": 1}', (agentDir) => {
    assert.equal(compactBashCallRowEnabled(agentDir), false);
  });
  for (const config of ["", "{", '["compactBashCallRow"]', '{"compactBashCallRow": "yes"}']) {
    withAgentDir(config, (agentDir) => {
      assert.equal(
        compactBashCallRowEnabled(agentDir),
        false,
        `unusable config ${JSON.stringify(config)} must not demand a label`,
      );
    });
  }
  // A directory in the config's place fails the read with EISDIR, not ENOENT.
  withAgentDir(undefined, (agentDir) => {
    fs.mkdirSync(path.join(agentDir, TOOL_DISPLAY_CONFIG_FILENAME));
    assert.equal(compactBashCallRowEnabled(agentDir), false);
  });
});
