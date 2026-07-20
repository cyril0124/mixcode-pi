import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveMixcodePackageRoot } from "../src/cli/main.js";

test("resolveMixcodePackageRoot prefers local pi-packages over stale PI_PACKAGE_DIR", () => {
  const self = process.cwd();
  const root = resolveMixcodePackageRoot(self, {
    PI_PACKAGE_DIR: "/tmp/mixcode-pi-stale-runtime-that-must-not-win",
  } as NodeJS.ProcessEnv);
  assert.equal(root, self);
});

test("resolveMixcodePackageRoot falls back to PI_PACKAGE_DIR when self has no packages", () => {
  const empty = mkdtempSync(join(tmpdir(), "mixcode-self-"));
  const runtime = mkdtempSync(join(tmpdir(), "mixcode-runtime-"));
  try {
    mkdirSync(join(runtime, "packages"));
    const root = resolveMixcodePackageRoot(empty, {
      PI_PACKAGE_DIR: runtime,
    } as NodeJS.ProcessEnv);
    assert.equal(root, runtime);
  } finally {
    rmSync(empty, { recursive: true, force: true });
    rmSync(runtime, { recursive: true, force: true });
  }
});
