import assert from "node:assert/strict";
import test from "node:test";
import { checkPiPackageUpdates } from "../src/core/package-updates.js";

test("checkPiPackageUpdates returns [] when options.env.PI_OFFLINE is truthy", async () => {
  const result = await checkPiPackageUpdates({
    workdir: process.cwd(),
    env: { PI_OFFLINE: "1" },
  });
  assert.deepEqual(result, []);
});

test("checkPiPackageUpdates returns [] when process.env.PI_OFFLINE is set", async () => {
  const previous = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const result = await checkPiPackageUpdates({ workdir: process.cwd() });
    assert.deepEqual(result, []);
  } finally {
    if (previous === undefined) {
      delete process.env.PI_OFFLINE;
    } else {
      process.env.PI_OFFLINE = previous;
    }
  }
});
