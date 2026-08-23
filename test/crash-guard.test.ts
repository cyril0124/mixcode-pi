import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const SCENARIO = path.join(import.meta.dir, "helpers", "crash-guard-scenario.ts");

function runScenario(mode: "uncaught" | "rejection") {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-crash-guard-"));
  const marker = path.join(agentDir, "teardown-ran");
  const result = Bun.spawnSync([process.execPath, SCENARIO, mode, marker], {
    env: { ...process.env, PI_CODING_AGENT_DIR: agentDir },
  });
  // Path is the documented contract (docs/cli-and-flags.md): <agentDir>/mixcode-pi/crash.log.
  const logPath = path.join(agentDir, "mixcode-pi", "crash.log");
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    tornDown: fs.existsSync(marker),
    log: fs.existsSync(logPath) ? fs.readFileSync(logPath, "utf8") : "",
  };
}

test("uncaught exception runs teardown, logs the stack, exits 1", () => {
  const result = runScenario("uncaught");
  assert.equal(result.exitCode, 1);
  assert.ok(result.tornDown, "teardown must run before the process dies");
  assert.match(result.stderr, /mpi crashed — uncaughtException: .*scenario-uncaught-boom/s);
  assert.match(result.log, /uncaughtException: Error: scenario-uncaught-boom/);
  assert.match(result.log, /crash-guard-scenario\.ts/, "crash log must keep the stack");
});

test("unhandled rejection runs teardown, logs the stack, exits 1", () => {
  const result = runScenario("rejection");
  assert.equal(result.exitCode, 1);
  assert.ok(result.tornDown, "teardown must run before the process dies");
  assert.match(result.log, /unhandledRejection: Error: scenario-rejection-boom/);
});
