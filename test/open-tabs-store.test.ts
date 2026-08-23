import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  addOpenTab,
  configureOpenTabsPath,
  openTabsFile,
  readOpenTabs,
  writeOpenTabs,
} from "./helpers/mixcode.js";

test("open_tabs rejects corrupt state without overwriting it", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-tabs-corrupt-"));
  const filePath = openTabsFile(dir);
  const corrupt = '{"version":1,"sessionIds":[';
  try {
    assert.deepEqual(readOpenTabs(filePath), [], "a missing file starts with no open tabs");
    fs.writeFileSync(filePath, corrupt, "utf8");

    assert.throws(() => addOpenTab(filePath, "must-not-be-written"), SyntaxError);
    assert.equal(fs.readFileSync(filePath, "utf8"), corrupt);

    const incomplete = '{"version":1,"sessionIds":["existing"]}';
    fs.writeFileSync(filePath, incomplete, "utf8");
    assert.throws(() => addOpenTab(filePath, "must-not-be-written"), /Invalid open tabs snapshot/);
    assert.equal(fs.readFileSync(filePath, "utf8"), incomplete);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs lock wait yields CPU under contention", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-tabs-lock-"));
  const filePath = openTabsFile(dir);
  const readyPath = path.join(dir, "waiter-ready");
  const goPath = path.join(dir, "waiter-go");
  let worker: Worker | undefined;
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    writeOpenTabs(filePath, []);
    configureOpenTabsPath(filePath);

    const moduleUrl = new URL("../src/core/open-tabs-store.ts", import.meta.url).href;
    child = Bun.spawn(
      [
        process.execPath,
        "--eval",
        `
        const api = await import(${JSON.stringify(moduleUrl)});
        const filePath = process.env.MIXCODE_TEST_OPEN_TABS_FILE;
        const readyPath = process.env.MIXCODE_TEST_READY_FILE;
        const goPath = process.env.MIXCODE_TEST_GO_FILE;
        await Bun.write(readyPath, "ready");
        while (!(await Bun.file(goPath).exists())) await Bun.sleep(5);
        api.configureOpenTabsPath(filePath);
        const cpu0 = process.cpuUsage();
        const t0 = Date.now();
        api.noteTabOpened("session-after-wait");
        const wallMs = Date.now() - t0;
        const cpu = process.cpuUsage(cpu0);
        const cpuMs = (cpu.user + cpu.system) / 1000;
        process.stdout.write(JSON.stringify({ wallMs, cpuMs }));
        `,
      ],
      {
        env: {
          ...process.env,
          MIXCODE_TEST_OPEN_TABS_FILE: filePath,
          MIXCODE_TEST_READY_FILE: readyPath,
          MIXCODE_TEST_GO_FILE: goPath,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    while (!(await Bun.file(readyPath).exists())) {
      if (child.exitCode !== null) throw new Error(await stderr);
      await Bun.sleep(5);
    }

    worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { openSync, writeSync, closeSync, rmSync } = require("node:fs");
      const lockPath = workerData.lockPath;
      const fd = openSync(lockPath, "wx");
      writeSync(fd, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }) + String.fromCharCode(10));
      parentPort.postMessage("held");
      setTimeout(() => {
        closeSync(fd);
        rmSync(lockPath, { force: true });
        parentPort.postMessage("released");
        parentPort.close();
      }, workerData.holdMs);
      `,
      { eval: true, workerData: { lockPath: `${filePath}.lock`, holdMs: 200 } },
    );
    const workerExited = new Promise<void>((resolve, reject) => {
      worker!.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`worker exit ${code}`))));
      worker!.once("error", reject);
    });

    await new Promise<void>((resolve, reject) => {
      worker!.once("message", (msg) => (msg === "held" ? resolve() : reject(new Error(String(msg)))));
      worker!.once("error", reject);
    });
    const released = new Promise<void>((resolve) => {
      worker!.once("message", () => resolve());
    });
    await Bun.write(goPath, "go");

    const exitCode = await child.exited;
    const errorText = await stderr;
    assert.equal(exitCode, 0, errorText);
    const { wallMs, cpuMs } = JSON.parse(await stdout) as { wallMs: number; cpuMs: number };

    await released;
    await workerExited;
    worker = undefined;

    assert.ok(wallMs >= 150, `expected ~200ms block, got ${wallMs}ms`);
    assert.deepEqual(readOpenTabs(filePath), ["session-after-wait"]);
    assert.ok(
      cpuMs < wallMs * 0.5,
      `lock wait burned too much CPU: cpu=${cpuMs.toFixed(1)}ms wall=${wallMs}ms`,
    );
  } finally {
    child?.kill();
    worker?.unref();
    void worker?.terminate();
    configureOpenTabsPath(undefined);
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs does not drop concurrent updates when a live holder outlives 5s", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-tabs-no-steal-"));
  const filePath = openTabsFile(dir);
  try {
    writeOpenTabs(filePath, ["s1"]);

    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const fs = require("node:fs");
      const { randomUUID } = require("node:crypto");
      const filePath = workerData.filePath;
      const lockPath = filePath + ".lock";
      const fd = fs.openSync(lockPath, "wx");
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }) + String.fromCharCode(10));
      parentPort.postMessage("held");
      let ids = [];
      try {
        ids = JSON.parse(fs.readFileSync(filePath, "utf8")).sessionIds || [];
      } catch {}
      setTimeout(() => {
        ids = Array.from(new Set(ids.concat(["slow-A"])));
        const temp = filePath + "." + process.pid + "." + randomUUID() + ".tmp";
        fs.writeFileSync(temp, JSON.stringify({
          version: 1,
          sessionIds: ids,
          updatedAt: new Date().toISOString(),
        }, null, 2) + String.fromCharCode(10));
        fs.renameSync(temp, filePath);
        fs.closeSync(fd);
        fs.rmSync(lockPath, { force: true });
        parentPort.postMessage({ wrote: ids });
      }, workerData.holdMs);
      `,
      { eval: true, workerData: { filePath, holdMs: 5500 } },
    );

    await new Promise<void>((resolve, reject) => {
      worker.once("message", (msg) => (msg === "held" ? resolve() : reject(new Error(String(msg)))));
      worker.once("error", reject);
    });

    const t0 = Date.now();
    const afterAdd = addOpenTab(filePath, "fast-B");
    const waitedMs = Date.now() - t0;
    const workerResult = await new Promise<{ wrote: string[] }>((resolve, reject) => {
      worker.once("message", (msg) => resolve(msg as { wrote: string[] }));
      worker.once("error", reject);
    });
    await worker.terminate();

    assert.ok(waitedMs >= 5000, `waiter must block for live holder, waited ${waitedMs}ms`);
    assert.ok(afterAdd.includes("s1"));
    assert.ok(afterAdd.includes("slow-A"), `missing slow-A: ${JSON.stringify(afterAdd)}`);
    assert.ok(afterAdd.includes("fast-B"), `missing fast-B: ${JSON.stringify(afterAdd)}`);
    assert.deepEqual(readOpenTabs(filePath).sort(), afterAdd.slice().sort());
    assert.ok(workerResult.wrote.includes("slow-A"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs reclaims a lock left by a dead pid", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-tabs-stale-"));
  const filePath = openTabsFile(dir);
  try {
    writeOpenTabs(filePath, ["keep"]);
    const lockPath = `${filePath}.lock`;
    fs.writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_646,
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );

    const t0 = Date.now();
    addOpenTab(filePath, "after-reclaim");
    assert.ok(Date.now() - t0 < 1000, "stale lock must be reclaimed promptly");
    assert.deepEqual(readOpenTabs(filePath), ["keep", "after-reclaim"]);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs concurrent mutators never lose updates", async () => {
  const dir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "mixcode-open-tabs-race-"));
  const filePath = openTabsFile(dir);
  try {
    writeOpenTabs(filePath, ["seed"]);
    const { spawn } = await import("node:child_process");
    const { writeFile } = await import("node:fs/promises");
    const workerPath = path.join(dir, "worker.mjs");
    await writeFile(
      workerPath,
      `
import { mutateOpenTabs } from ${JSON.stringify(new URL("../src/core/open-tabs-store.ts", import.meta.url).pathname)};
const filePath = process.argv[2];
const myId = "w" + process.pid;
const endAt = Date.now() + 1500;
let ops = 0;
while (Date.now() < endAt) {
  mutateOpenTabs(filePath, (ids) => {
    ids.add(myId);
    const n = [...ids].filter((x) => x.startsWith("n:")).map((x) => Number(x.slice(2)));
    const next = (n.length ? Math.max(...n) : 0) + 1;
    for (const x of [...ids]) if (x.startsWith("n:")) ids.delete(x);
    ids.add("n:" + next);
  });
  ops++;
}
process.stdout.write(String(ops));
`,
    );
    const kids = Array.from({ length: 6 }, () =>
      spawn(process.execPath, [workerPath, filePath], { stdio: ["ignore", "pipe", "inherit"] }),
    );
    const opsList = await Promise.all(
      kids.map(
        (c) =>
          new Promise<number>((resolve, reject) => {
            let out = "";
            c.stdout?.on("data", (buf) => {
              out += String(buf);
            });
            c.on("exit", (code) => {
              if (code !== 0) reject(new Error(`worker exit ${code}`));
              else resolve(Number(out) || 0);
            });
            c.on("error", reject);
          }),
      ),
    );
    const totalOps = opsList.reduce((a, b) => a + b, 0);
    const final = readOpenTabs(filePath);
    const counter = final.find((id) => id.startsWith("n:"));
    assert.ok(counter, `missing counter in ${JSON.stringify(final)}`);
    assert.equal(
      Number(counter.slice(2)),
      totalOps,
      `lost updates: counter=${counter.slice(2)} totalOps=${totalOps}`,
    );
    assert.ok(final.includes("seed"));
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
