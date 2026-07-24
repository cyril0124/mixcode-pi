import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  addOpenTab,
  configureOpenTabsPath,
  noteTabOpened,
  openTabsFile,
  readOpenTabs,
  writeOpenTabs,
} from "../src/index.js";

test("open_tabs lock wait yields CPU under contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-open-tabs-lock-"));
  const filePath = openTabsFile(dir);
  try {
    writeOpenTabs(filePath, []);
    configureOpenTabsPath(filePath);

    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { openSync, writeSync, closeSync, rmSync, readFileSync } = require("node:fs");
      const lockPath = workerData.lockPath;
      const fd = openSync(lockPath, "wx");
      let startTime;
      try {
        const stat = readFileSync("/proc/" + process.pid + "/stat", "utf8");
        const closeParen = stat.lastIndexOf(")");
        startTime = closeParen >= 0 ? stat.slice(closeParen + 2).split(" ")[19] : undefined;
      } catch {}
      writeSync(fd, JSON.stringify({
        pid: process.pid,
        processStartTime: startTime,
        processVerification: startTime ? "linux-start-time" : "pid-only",
        acquiredAt: new Date().toISOString(),
      }) + String.fromCharCode(10));
      parentPort.postMessage("held");
      setTimeout(() => {
        closeSync(fd);
        rmSync(lockPath, { force: true });
        parentPort.postMessage("released");
      }, workerData.holdMs);
      `,
      { eval: true, workerData: { lockPath: `${filePath}.lock`, holdMs: 200 } },
    );

    await new Promise<void>((resolve, reject) => {
      worker.once("message", (msg) => (msg === "held" ? resolve() : reject(new Error(String(msg)))));
      worker.once("error", reject);
    });

    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    noteTabOpened("session-after-wait");
    const wallMs = Date.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;

    await new Promise<void>((resolve) => {
      worker.once("message", () => resolve());
    });
    await worker.terminate();

    assert.ok(wallMs >= 150, `expected ~200ms block, got ${wallMs}ms`);
    assert.deepEqual(readOpenTabs(filePath), ["session-after-wait"]);
    assert.ok(
      cpuMs < wallMs * 0.5,
      `lock wait burned too much CPU: cpu=${cpuMs.toFixed(1)}ms wall=${wallMs}ms`,
    );
  } finally {
    configureOpenTabsPath(undefined);
    await rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs does not drop concurrent updates when a live holder outlives 5s", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-open-tabs-no-steal-"));
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
      let startTime;
      try {
        const stat = fs.readFileSync("/proc/" + process.pid + "/stat", "utf8");
        const closeParen = stat.lastIndexOf(")");
        startTime = closeParen >= 0 ? stat.slice(closeParen + 2).split(" ")[19] : undefined;
      } catch {}
      fs.writeSync(fd, JSON.stringify({
        pid: process.pid,
        processStartTime: startTime,
        processVerification: startTime ? "linux-start-time" : "pid-only",
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
    await rm(dir, { recursive: true, force: true });
  }
});

test("open_tabs reclaims a lock left by a dead pid", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-open-tabs-stale-"));
  const filePath = openTabsFile(dir);
  try {
    writeOpenTabs(filePath, ["keep"]);
    const lockPath = `${filePath}.lock`;
    writeFileSync(
      lockPath,
      `${JSON.stringify({
        pid: 2_147_483_646,
        processVerification: "pid-only",
        acquiredAt: new Date().toISOString(),
      })}\n`,
    );

    const t0 = Date.now();
    addOpenTab(filePath, "after-reclaim");
    assert.ok(Date.now() - t0 < 1000, "stale lock must be reclaimed promptly");
    assert.deepEqual(readOpenTabs(filePath), ["keep", "after-reclaim"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
