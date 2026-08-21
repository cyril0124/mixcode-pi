import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as nodePath from "node:path";
import { test } from "node:test";
import { formatBytes, parseByteSize, writeMaxBytes } from "./config-ui.js";
import { CONFIG_FILENAME, DEFAULT_HISTORY_MAX_BYTES, readHistoryMaxBytes } from "./history-store.js";

const MB = 1024 * 1024;

test("parseByteSize accepts plain bytes and unit suffixes, rejects the rest", () => {
  assert.equal(parseByteSize("1048576"), MB);
  assert.equal(parseByteSize("20mb"), 20 * MB);
  assert.equal(parseByteSize("512 KB"), 512 * 1024);
  assert.equal(parseByteSize(" 1gb "), 1024 * MB);
  assert.equal(parseByteSize("2048b"), 2048);
  // 0.5mb is a whole number of bytes; 0.5b is not.
  assert.equal(parseByteSize("0.5mb"), MB / 2);

  for (const bad of ["0", "-5", "", "mb", "abc", "5tb", "1e6", "0.5b", "5 mb extra"]) {
    assert.equal(parseByteSize(bad), undefined, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("formatBytes renders the largest whole unit", () => {
  assert.equal(formatBytes(DEFAULT_HISTORY_MAX_BYTES), "15 MB");
  assert.equal(formatBytes(512 * 1024), "512 KB");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024 * MB), "1 GB");
  assert.equal(formatBytes(1536 * 1024), "1.5 MB");
});

test("writeMaxBytes round-trips through the config reader and preserves $schema", async () => {
  const dir = await fsPromises.mkdtemp(nodePath.join(os.tmpdir(), "mpi-prompt-history-write-"));
  const configFile = nodePath.join(dir, CONFIG_FILENAME);
  try {
    await writeMaxBytes(configFile, 4096);
    assert.equal(await readHistoryMaxBytes(configFile), 4096);

    await fsPromises.writeFile(
      configFile,
      JSON.stringify({ $schema: "./mpi-prompt-history.schema.json", maxBytes: 4096 }),
      "utf8",
    );
    await writeMaxBytes(configFile, 8192);
    const kept = JSON.parse(await fsPromises.readFile(configFile, "utf8")) as Record<string, unknown>;
    assert.equal(kept.$schema, "./mpi-prompt-history.schema.json");
    assert.equal(kept.maxBytes, 8192);

    // Clearing the only setting leaves no file, so the default applies again.
    await fsPromises.writeFile(configFile, JSON.stringify({ maxBytes: 8192 }), "utf8");
    assert.equal(await writeMaxBytes(configFile, undefined), undefined);
    await assert.rejects(fsPromises.stat(configFile), /ENOENT/);
    assert.equal(await readHistoryMaxBytes(configFile), DEFAULT_HISTORY_MAX_BYTES);

    // Clearing with a $schema present keeps the file so the editor hint survives.
    await fsPromises.writeFile(configFile, JSON.stringify({ $schema: "./s.json", maxBytes: 1 }), "utf8");
    assert.equal(await writeMaxBytes(configFile, undefined), configFile);
    assert.equal(await readHistoryMaxBytes(configFile), DEFAULT_HISTORY_MAX_BYTES);
  } finally {
    await fsPromises.rm(dir, { recursive: true, force: true });
  }
});
