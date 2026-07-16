import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { closeSync, openSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import {
  configureOpenTabsPath,
  noteTabOpened,
  openTabsFile,
  readOpenTabs,
  writeOpenTabs,
} from "../src/index.js";

test("open_tabs lock wait yields CPU under contention", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mixcode-open-tabs-lock-"));
  const filePath = openTabsFile(dir);
  const lockPath = `${filePath}.lock`;
  try {
    writeOpenTabs(filePath, []);
    configureOpenTabsPath(filePath);

    const hold = openSync(lockPath, "wx");
    const releaseAt = Date.now() + 200;
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { closeSync, unlinkSync } = require("node:fs");
      const wait = workerData.releaseAt - Date.now();
      setTimeout(() => {
        try { closeSync(workerData.fd); } catch {}
        try { unlinkSync(workerData.lockPath); } catch {}
        parentPort.postMessage("released");
      }, Math.max(0, wait));
      `,
      { eval: true, workerData: { fd: hold, lockPath, releaseAt } },
    );
    const released = new Promise<void>((resolve) => {
      worker.once("message", () => resolve());
    });

    const cpu0 = process.cpuUsage();
    const t0 = Date.now();
    noteTabOpened("session-after-wait");
    const wallMs = Date.now() - t0;
    const cpu = process.cpuUsage(cpu0);
    const cpuMs = (cpu.user + cpu.system) / 1000;

    await released;
    await worker.terminate();

    assert.ok(wallMs >= 150, `expected ~200ms block, got ${wallMs}ms`);
    assert.deepEqual(readOpenTabs(filePath), ["session-after-wait"]);
    // Busy-spin would burn ~wallMs of CPU. A yielding wait stays well below half.
    assert.ok(
      cpuMs < wallMs * 0.5,
      `lock wait burned too much CPU: cpu=${cpuMs.toFixed(1)}ms wall=${wallMs}ms`,
    );
  } finally {
    configureOpenTabsPath(undefined);
    try {
      unlinkSync(lockPath);
    } catch {
      // already released
    }
    await rm(dir, { recursive: true, force: true });
  }
});
