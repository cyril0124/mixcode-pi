import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { exposeLocalPiCli, resolveMixcodePackageRoot } from "../src/cli/main.js";

test("resolveMixcodePackageRoot prefers local pi-packages over stale PI_PACKAGE_DIR", () => {
  const self = process.cwd();
  const root = resolveMixcodePackageRoot(self, {
    PI_PACKAGE_DIR: "/tmp/mixcode-pi-stale-runtime-that-must-not-win",
  } as NodeJS.ProcessEnv);
  assert.equal(root, self);
});

test("exposeLocalPiCli walks up from dist/chunk-*.js to the repo bin dir", () => {
  const entryUrl = pathToFileURL(path.join(process.cwd(), "dist", "chunk-FAKE.js")).href;
  const binDir = exposeLocalPiCli({ ...process.env, PATH: "" }, entryUrl);
  assert.equal(binDir, path.join(process.cwd(), "node_modules", ".bin"));
});

test("resolveMixcodePackageRoot falls back to PI_PACKAGE_DIR when self has no packages", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-self-"));
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), "mixcode-runtime-"));
  try {
    fs.mkdirSync(path.join(runtime, "packages"));
    const root = resolveMixcodePackageRoot(empty, {
      PI_PACKAGE_DIR: runtime,
    } as NodeJS.ProcessEnv);
    assert.equal(root, runtime);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
    fs.rmSync(runtime, { recursive: true, force: true });
  }
});
