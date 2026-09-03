import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  DEFAULT_STUCK_GUARD_CONFIG,
  loadStuckGuardConfig,
  parseStuckGuardConfig,
  stuckGuardConfigPath,
} from "./config.js";

test("config: empty object yields provider watchdog defaults", () => {
  const result = parseStuckGuardConfig({});
  assert.ok(result.ok);
  assert.deepEqual(result.config, DEFAULT_STUCK_GUARD_CONFIG);
});

test("config: removed configuration keys fail as unknown", () => {
  assert.ok(!parseStuckGuardConfig({ toolLoopEnabled: true }).ok);
  assert.ok(!parseStuckGuardConfig({ identicalRunThreshold: 3 }).ok);
});

test("config: invalid provider watchdog values fail loudly", () => {
  assert.ok(!parseStuckGuardConfig({ streamWatchdogEnabled: "yes" }).ok);
  assert.ok(!parseStuckGuardConfig({ streamStartTimeoutSeconds: -1 }).ok);
  assert.ok(!parseStuckGuardConfig({ streamIdleTimeoutSeconds: 1.5 }).ok);
  assert.ok(!parseStuckGuardConfig({ providerIds: ["", 1] }).ok);
});

test("config: valid provider watchdog values override defaults", () => {
  const result = parseStuckGuardConfig({
    streamWatchdogEnabled: false,
    providerIds: ["openai"],
    streamStartTimeoutSeconds: 0,
    streamIdleTimeoutSeconds: 7,
    streamRetryStartTimeoutSeconds: 3,
    knownTimeoutCooldownSeconds: 9,
  });
  assert.ok(result.ok);
  assert.deepEqual(result.config, {
    streamWatchdogEnabled: false,
    providerIds: ["openai"],
    streamStartTimeoutSeconds: 0,
    streamIdleTimeoutSeconds: 7,
    streamRetryStartTimeoutSeconds: 3,
    knownTimeoutCooldownSeconds: 9,
  });
});

test("config: missing file uses defaults and invalid JSON fails", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "stuck-guard-config-"));
  const missing = loadStuckGuardConfig(dir);
  assert.ok(missing.ok && missing.missing);
  assert.deepEqual(missing.config, DEFAULT_STUCK_GUARD_CONFIG);

  fs.writeFileSync(stuckGuardConfigPath(dir), "{ not json");
  const invalid = loadStuckGuardConfig(dir);
  assert.ok(!invalid.ok);
  fs.rmSync(dir, { recursive: true, force: true });
});
