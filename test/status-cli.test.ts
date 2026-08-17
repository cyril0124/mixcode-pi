import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { test } from "node:test";

import { parseMainArgs } from "../src/cli/main.js";
import {
  expandTilde,
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

test("parseMainArgs resolves status --workdir as absolute, relative, and ~", () => {
  const home = os.homedir();
  const abs = parseMainArgs(["status", "--workdir", "/abs/project"], "/caller");
  assert.equal(abs.statusWorkdir, "/abs/project");

  const rel = parseMainArgs(["status", "--workdir", "./rel"], "/caller");
  assert.equal(rel.statusWorkdir, path.resolve("/caller", "./rel"));

  const equals = parseMainArgs(["status", "--workdir=~/proj"], "/caller");
  assert.equal(equals.statusWorkdir, path.join(home, "proj"));

  const tilde = parseMainArgs(["status", "--workdir", "~/proj"], "/caller");
  assert.equal(tilde.statusWorkdir, path.join(home, "proj"));
  assert.equal(expandTilde("~"), home);

  assert.throws(() => parseMainArgs(["status", "--workdir"], "/caller"), /--workdir requires a path/);
  assert.throws(() => parseMainArgs(["status", "--workdir="], "/caller"), /--workdir requires a path/);

  const all = parseMainArgs(["status"], "/caller");
  assert.equal(all.statusWorkdir, undefined);
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

test("cli entry via bun on status outputs valid json and supports workdir filtering", async () => {
  const tmpAgent = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mpi-status-test-"));
  const stateDir = path.join(tmpAgent, "mixcode-pi");
  try {
    // Write two dummy snapshots with different workdirs
    await writeInstanceSnapshot(stateDir, {
      version: 1,
      pid: process.pid,
      workdir: "/test-workdir-a",
      activeTabId: "s1",
      updatedAt: new Date().toISOString(),
      tabs: [
        {
          index: 1,
          sessionId: "session-12345678",
          title: "TestTabA",
          workdir: "/test-workdir-a",
          status: "idle",
          unreadDone: false,
          waitingForInputCount: 0,
        },
      ],
    });

    const env = { ...process.env, PI_CODING_AGENT_DIR: tmpAgent };

    // 1. Unfiltered --json
    {
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
      assert.equal(report.instances[0].workdir, "/test-workdir-a");
      assert.equal(report.instances[0].activeTabTitle, undefined);
      assert.equal(report.instances[0].tabs[0].tabTitle, "TestTabA");
      assert.equal(report.instances[0].tabs[0].active, undefined);
      assert.equal(report.instances[0].tabs[0].state, "idle");
      assert.equal(report.instances[0].tabs[0].status, "idle");
      assert.equal(report.instances[0].tabs[0].sessionId, "session-12345678");
      // Verify internal implementation leaks are omitted
      assert.equal(report.instances[0].tabs[0].pendingDialogCount, undefined);
      assert.equal(report.instances[0].processStartTime, undefined);
    }

    // 2. Matching workdir
    {
      const child = Bun.spawn(
        ["bun", "src/cli/main.ts", "status", "--json", "--workdir", "/test-workdir-a"],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      assert.equal(exitCode, 0);
      const report = JSON.parse(stdout);
      assert.equal(report.instances.length, 1);
    }

    // 3. Non-matching workdir
    {
      const child = Bun.spawn(
        ["bun", "src/cli/main.ts", "status", "--json", "--workdir", "/non-existent"],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(child.stdout).text();
      const exitCode = await child.exited;
      assert.equal(exitCode, 0);
      const report = JSON.parse(stdout);
      assert.equal(report.instances.length, 0);
    }

    // 4. Tilde workdir matches a snapshot under $HOME (reuse this process pid so it is live)
    const homeWorkdir = path.join(os.homedir(), "mpi-status-tilde-filter");
    await writeInstanceSnapshot(stateDir, {
      version: 1,
      pid: process.pid,
      workdir: homeWorkdir,
      activeTabId: "s2",
      updatedAt: new Date().toISOString(),
      tabs: [
        {
          index: 1,
          sessionId: "session-tilde",
          title: "HomeTab",
          workdir: homeWorkdir,
          status: "idle",
          unreadDone: false,
          waitingForInputCount: 0,
        },
      ],
    });
    {
      const child = Bun.spawn(
        ["bun", "src/cli/main.ts", "status", "--json", "--workdir", "~/mpi-status-tilde-filter"],
        {
          env,
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const stdout = await new Response(child.stdout).text();
      const stderr = await new Response(child.stderr).text();
      const exitCode = await child.exited;
      assert.equal(exitCode, 0, `stderr: ${stderr}`);
      const report = JSON.parse(stdout);
      assert.equal(report.instances.length, 1);
      assert.equal(report.instances[0].tabs[0].tabTitle, "HomeTab");
    }
  } finally {
    await fsPromises.rm(tmpAgent, { recursive: true, force: true });
  }
});
