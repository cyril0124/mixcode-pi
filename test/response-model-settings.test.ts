import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  loadMixCodeSettings,
  loadRawMixCodeSettings,
  writeRawMixCodeSettings,
} from "../src/core/mixcode-settings.js";

test("response model notices default on and round-trip explicit booleans without dropping sibling settings", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-response-settings-"));
  const file = path.join(dir, "mixcode_settings.json");
  try {
    assert.equal((await loadMixCodeSettings(file)).ui.showResponseModelNotices, true);
    assert.equal((await loadRawMixCodeSettings(file)).ui?.showResponseModelNotices, undefined);
    for (const value of [false, true]) {
      await Bun.write(
        file,
        JSON.stringify({
          ui: { showResponseModelNotices: value, inlineWidgets: true },
          disabledProviders: ["disabled-provider"],
        }),
      );
      const raw = await loadRawMixCodeSettings(file);
      assert.equal(raw.ui?.showResponseModelNotices, value);
      await writeRawMixCodeSettings(file, raw);
      assert.deepEqual(await Bun.file(file).json(), {
        ui: { showResponseModelNotices: value, inlineWidgets: true },
        disabledProviders: ["disabled-provider"],
      });
      assert.equal((await loadMixCodeSettings(file)).ui.showResponseModelNotices, value);
    }
    await Bun.write(file, "{}");
    assert.equal((await loadMixCodeSettings(file)).ui.showResponseModelNotices, true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("both settings loaders reject invalid response model notice values", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mixcode-invalid-response-settings-"));
  const file = path.join(dir, "mixcode_settings.json");
  try {
    for (const value of ["false", 0, null, {}]) {
      await Bun.write(file, JSON.stringify({ ui: { showResponseModelNotices: value } }));
      for (const load of [loadMixCodeSettings, loadRawMixCodeSettings]) {
        await assert.rejects(() => load(file), /ui\.showResponseModelNotices must be a boolean/);
      }
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
