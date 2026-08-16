import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { isDirectCliEntry } from "../src/cli/direct-cli-entry.js";

const FLAG = Symbol.for("mixcode-pi.binary-entry-import");

async function withTree(
  files: string[],
  run: (root: string) => void | Promise<void>,
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-direct-cli-"));
  try {
    for (const relative of files) {
      const full = path.join(root, relative);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, "");
    }
    await run(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("same file path is a direct CLI entry", async () => {
  await withTree(["src/cli/main.ts"], (root) => {
    const file = path.join(root, "src/cli/main.ts");
    assert.equal(isDirectCliEntry(pathToFileURL(file).href, file), true);
  });
});

test("tsup chunk next to dist/cli/main.js is a direct CLI entry", async () => {
  await withTree(["dist/cli/main.js", "dist/chunk-YG4GO4JN.js"], (root) => {
    assert.equal(
      isDirectCliEntry(
        pathToFileURL(path.join(root, "dist/chunk-YG4GO4JN.js")).href,
        path.join(root, "dist/cli/main.js"),
      ),
      true,
    );
  });
});

test("another main.ts that imports MixCode CLI is not a direct entry", async () => {
  await withTree(["wrapper/main.ts", "src/cli/main.ts"], (root) => {
    assert.equal(
      isDirectCliEntry(
        pathToFileURL(path.join(root, "src/cli/main.ts")).href,
        path.join(root, "wrapper/main.ts"),
      ),
      false,
    );
  });
});

test("path containing chunk- but not a tsup chunk basename is not a direct entry", async () => {
  await withTree(["dist/cli/main.js", "dist/chunk-hidden/helper.js"], (root) => {
    assert.equal(
      isDirectCliEntry(
        pathToFileURL(path.join(root, "dist/chunk-hidden/helper.js")).href,
        path.join(root, "dist/cli/main.js"),
      ),
      false,
    );
  });
});

test("binary-entry import flag blocks auto-start", async () => {
  await withTree(["src/cli/main.ts"], (root) => {
    const file = path.join(root, "src/cli/main.ts");
    const previous = (globalThis as Record<symbol, unknown>)[FLAG];
    (globalThis as Record<symbol, unknown>)[FLAG] = true;
    try {
      assert.equal(isDirectCliEntry(pathToFileURL(file).href, file), false);
    } finally {
      if (previous === undefined) delete (globalThis as Record<symbol, unknown>)[FLAG];
      else (globalThis as Record<symbol, unknown>)[FLAG] = previous;
    }
  });
});
