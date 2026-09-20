import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { createDetachingBashOperations, type DetachedRun, killTree, stopBashJob } from "./exec.js";

const unixOnly = { skip: process.platform === "win32" };
const cleanupCommand =
  'trap \'printf "CLEANUP_DONE\\n"; exit 0\' TERM; printf "READY\\n"; while :; do sleep 0.1; done';
const childCleanupCommand = [
  "trap 'echo PARENT_CLEANUP; exit 0' TERM",
  "(trap 'sleep 0.4; echo CHILD_CLEANUP; exit 0' TERM; echo CHILD_READY; while :; do sleep 0.1; done) &",
  "wait",
].join("\n");

for (const foregroundSeconds of [0, 0.2]) {
  test(
    `abort runs TERM cleanup without detaching at window ${foregroundSeconds}`,
    unixOnly,
    async () => {
      const controller = new AbortController();
      let output = "";
      let detached = false;
      const operations = createDetachingBashOperations({
        shellPath: "/bin/bash",
        foregroundSeconds,
        onDetached: () => {
          detached = true;
        },
        onDetachedExit: () => {},
      });
      // Cleanup crosses the foreground deadline; cancellation must still reject.
      const command = cleanupCommand.replace(
        'printf "CLEANUP_DONE',
        'sleep 0.4; printf "CLEANUP_DONE',
      );
      await assert.rejects(
        operations.exec(command, process.cwd(), {
          env: process.env,
          signal: controller.signal,
          timeout: 5,
          onData: (data) => {
            output += data.toString();
            if (output.includes("READY")) controller.abort();
          },
        }),
        /^Error: aborted$/,
      );
      assert.match(output, /^CLEANUP_DONE$/m);
      assert.equal(detached, false);
    },
  );
}

test("foreground timeout preserves cleanup output and the timeout error", unixOnly, async () => {
  let output = "";
  const operations = createDetachingBashOperations({
    shellPath: "/bin/bash",
    foregroundSeconds: 0,
    onDetachedExit: () => {},
  });
  await assert.rejects(
    operations.exec(cleanupCommand, process.cwd(), {
      env: process.env,
      timeout: 0.5,
      onData: (data) => {
        output += data.toString();
      },
    }),
    /^Error: timeout:0.5$/,
  );
  assert.match(output, /^CLEANUP_DONE$/m);
});

test("background timeout flushes TERM cleanup before its completion notice", unixOnly, async () => {
  const finished = Promise.withResolvers<DetachedRun>();
  const operations = createDetachingBashOperations({
    shellPath: "/bin/bash",
    foregroundSeconds: 0.1,
    onDetachedExit: finished.resolve,
  });
  await operations.exec(cleanupCommand, process.cwd(), {
    env: process.env,
    timeout: 0.5,
    onData: () => {},
  });
  const run = await finished.promise;
  try {
    assert.equal(run.timedOut, true);
    assert.match(run.tail, /^CLEANUP_DONE$/m);
    assert.match(await fs.readFile(run.logPath, "utf8"), /^CLEANUP_DONE$/m);
  } finally {
    await fs.rm(run.logPath, { force: true });
  }
});

test("manual stop runs cleanup once even when requested repeatedly", unixOnly, async () => {
  const finished = Promise.withResolvers<DetachedRun>();
  let start: { id: number; logPath: string } | undefined;
  const operations = createDetachingBashOperations({
    shellPath: "/bin/bash",
    foregroundSeconds: 0.1,
    onDetached: (run) => {
      start = run;
    },
    onDetachedExit: finished.resolve,
  });
  try {
    await operations.exec(cleanupCommand, process.cwd(), {
      env: process.env,
      timeout: 5,
      onData: () => {},
    });
    assert.ok(start);
    stopBashJob(start.id);
    stopBashJob(start.id);
    const run = await finished.promise;
    assert.equal(run.timedOut, false);
    assert.match(run.tail, /^CLEANUP_DONE$/m);
    assert.equal(run.tail.match(/CLEANUP_DONE/g)?.length, 1);
  } finally {
    if (start) {
      killTree(start.id);
      await finished.promise;
      await fs.rm(start.logPath, { force: true });
    }
  }
});

test("abort gives a TERM-ignoring shell three seconds before escalation", unixOnly, async () => {
  const controller = new AbortController();
  let requestedAt = 0;
  let output = "";
  const operations = createDetachingBashOperations({
    shellPath: "/bin/bash",
    foregroundSeconds: 0,
    onDetachedExit: () => {},
  });
  await assert.rejects(
    operations.exec('trap "" TERM; printf "READY\\n"; while :; do sleep 0.1; done', process.cwd(), {
      env: process.env,
      signal: controller.signal,
      timeout: 8,
      onData: (data) => {
        output += data.toString();
        if (!requestedAt && output.includes("READY")) {
          requestedAt = Date.now();
          controller.abort();
        }
      },
    }),
    /^Error: aborted$/,
  );
  assert.ok(Date.now() - requestedAt >= 2900, "TERM must have its three-second cleanup window");
});

for (const failedSignal of ["SIGTERM", "SIGKILL"] as const) {
  test(
    `a ${failedSignal} permission failure rejects execution without crashing the host`,
    unixOnly,
    async () => {
      const controller = new AbortController();
      const originalKill = process.kill;
      let groupPid: number | undefined;
      let output = "";
      const operations = createDetachingBashOperations({
        shellPath: "/bin/bash",
        foregroundSeconds: 0,
        onDetachedExit: () => {},
      });
      // Inject only the OS signalling boundary; spawn, timers and exit are real.
      process.kill = (pid, signal) => {
        if (pid === -(groupPid ?? 0) && signal === failedSignal) {
          throw Object.assign(new Error(`denied ${failedSignal}`), { code: "EPERM" });
        }
        return originalKill(pid, signal);
      };
      try {
        await assert.rejects(
          operations.exec(
            'trap "" TERM; printf "READY:%s\\n" "$$"; while :; do sleep 0.1; done',
            process.cwd(),
            {
              env: process.env,
              signal: controller.signal,
              timeout: 8,
              onData: (data) => {
                output += data.toString();
                const match = /READY:(\d+)/.exec(output);
                if (match) {
                  groupPid = Number(match[1]);
                  controller.abort();
                }
              },
            },
          ),
          { message: `denied ${failedSignal}`, code: "EPERM" },
        );
      } finally {
        process.kill = originalKill;
        if (groupPid) killTree(groupPid);
      }
    },
  );
}

test("abort retains child cleanup output after the parent shell exits", unixOnly, async () => {
  const controller = new AbortController();
  let output = "";
  const operations = createDetachingBashOperations({
    shellPath: "/bin/bash",
    foregroundSeconds: 0,
    onDetachedExit: () => {},
  });
  await assert.rejects(
    operations.exec(childCleanupCommand, process.cwd(), {
      env: process.env,
      signal: controller.signal,
      timeout: 8,
      onData: (data) => {
        output += data.toString();
        if (output.includes("CHILD_READY")) controller.abort();
      },
    }),
    /^Error: aborted$/,
  );
  assert.match(output, /^PARENT_CLEANUP$/m);
  assert.match(output, /^CHILD_CLEANUP$/m);
});

test("background timeout retains delayed descendant cleanup in its log", unixOnly, async () => {
  const finished = Promise.withResolvers<DetachedRun>();
  const operations = createDetachingBashOperations({
    shellPath: "/bin/bash",
    foregroundSeconds: 0.1,
    onDetachedExit: finished.resolve,
  });
  await operations.exec(childCleanupCommand, process.cwd(), {
    env: process.env,
    timeout: 0.5,
    onData: () => {},
  });
  const run = await finished.promise;
  try {
    assert.equal(run.timedOut, true);
    assert.match(run.tail, /^CHILD_CLEANUP$/m);
    assert.match(await fs.readFile(run.logPath, "utf8"), /^CHILD_CLEANUP$/m);
  } finally {
    await fs.rm(run.logPath, { force: true });
  }
});

test(
  "abort escalates after the shell exits while a descendant ignores TERM",
  unixOnly,
  async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mpi-bash-grace-"));
    const readyPath = path.join(dir, "ready");
    const survivedPath = path.join(dir, "survived");
    const controller = new AbortController();
    let output = "";
    let groupPid: number | undefined;
    const operations = createDetachingBashOperations({
      shellPath: "/bin/bash",
      foregroundSeconds: 0,
      onDetachedExit: () => {},
    });
    // The child closes stdio, so shell exit cannot stand in for group exit.
    const command = [
      "trap 'printf \"SHELL_CLEANUP\\n\"; exit 0' TERM",
      '(trap "" TERM; : > "$READY_PATH"; sleep 4; : > "$SURVIVED_PATH") >/dev/null 2>&1 &',
      'while [ ! -f "$READY_PATH" ]; do sleep 0.01; done',
      'printf "READY:%s\\n" "$$"',
      "wait",
    ].join("\n");
    try {
      await assert.rejects(
        operations.exec(command, process.cwd(), {
          env: { ...process.env, READY_PATH: readyPath, SURVIVED_PATH: survivedPath },
          timeout: 8,
          signal: controller.signal,
          onData: (data) => {
            output += data.toString();
            const match = /READY:(\d+)/.exec(output);
            if (match) {
              groupPid = Number(match[1]);
              controller.abort();
            }
          },
        }),
        /^Error: aborted$/,
      );
      assert.match(output, /^SHELL_CLEANUP$/m);
      // Wait past the child's scheduled side effect, including scheduler slack.
      await new Promise((resolve) => setTimeout(resolve, 4500));
      await assert.rejects(fs.access(survivedPath), { code: "ENOENT" });
    } finally {
      if (groupPid) killTree(groupPid);
      await fs.rm(dir, { recursive: true, force: true });
    }
  },
);
