import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";

import {
  isStatusCliArgs,
  resolveMixcodeAgentDir,
  resolveMixcodeStateDir,
} from "../src/cli/status.js";
import { writeInstanceSnapshot } from "../src/core/instance-registry.js";

test("isStatusCliArgs detects status subcommand accurately", () => {
  assert.equal(isStatusCliArgs(["status"]), true);
  assert.equal(isStatusCliArgs(["status", "--json"]), true);
  assert.equal(isStatusCliArgs(["status", "--workdir", "/tmp"]), true);
  assert.equal(isStatusCliArgs(["status", "--help"]), true);
  assert.equal(isStatusCliArgs(["--help"]), false);
  assert.equal(isStatusCliArgs(["--batch", "x.lua"]), false);
  assert.equal(isStatusCliArgs([]), false);
  assert.equal(isStatusCliArgs(["--workdir", "/tmp", "status"]), false);
});

test("resolveMixcodeAgentDir respects PI_CODING_AGENT_DIR precedence and tilde expansion", () => {
  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent/dir";
    assert.equal(resolveMixcodeAgentDir(), "/custom/agent/dir");

    process.env.PI_CODING_AGENT_DIR = "~/my-agent";
    assert.equal(resolveMixcodeAgentDir(), path.join(os.homedir(), "my-agent"));

    process.env.PI_CODING_AGENT_DIR = "~";
    assert.equal(resolveMixcodeAgentDir(), os.homedir());

    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(resolveMixcodeAgentDir(), path.join(os.homedir(), ".pi", "agent"));

    process.env.PI_CODING_AGENT_DIR = "";
    assert.equal(resolveMixcodeAgentDir(), path.join(os.homedir(), ".pi", "agent"));
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});

test("resolveMixcodeStateDir appends mixcode-pi to effective agent dir", () => {
  const oldEnv = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = "/custom/agent";
    assert.equal(resolveMixcodeStateDir(), "/custom/agent/mixcode-pi");

    delete process.env.PI_CODING_AGENT_DIR;
    assert.equal(resolveMixcodeStateDir(), path.join(os.homedir(), ".pi", "agent", "mixcode-pi"));
  } finally {
    if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldEnv;
  }
});

test("cli entry via bun on status outputs valid json", async () => {
  const tmpAgent = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-status-test-"));
  const stateDir = path.join(tmpAgent, "mixcode-pi");
  try {
    // Write a dummy snapshot
    await writeInstanceSnapshot(stateDir, {
      version: 1,
      pid: process.pid,
      processVerification: "pid-only",
      workdir: "/test-workdir",
      activeTabId: "s1",
      updatedAt: new Date().toISOString(),
      tabs: [
        {
          index: 1,
          sessionId: "session-12345678",
          title: "TestTab",
          workdir: "/test-workdir",
          status: "idle",
          unreadDone: false,
          pendingDialogCount: 0,
          waitingForInputCount: 0,
        },
      ],
    });

    const env = { ...process.env, PI_CODING_AGENT_DIR: tmpAgent };
    const child = Bun.spawn(["bun", "src/cli/main.ts", "status", "--json"], {
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(child.stdout).text();
    const stderr = await new Response(child.stderr).text();
    const exitCode = await child.exited;

    assert.equal(exitCode, 0, `stderr: ${stderr}`);
    const report = JSON.parse(stdout);
    assert.equal(Array.isArray(report.instances), true);
    assert.equal(report.instances.length, 1);
    assert.equal(report.instances[0].pid, process.pid);
    assert.equal(report.instances[0].workdir, "/test-workdir");
  } finally {
    await fsPromises.rm(tmpAgent, { recursive: true, force: true });
  }
});
