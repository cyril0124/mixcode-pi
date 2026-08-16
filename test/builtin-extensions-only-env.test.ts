import "./helpers/isolated-agent-dir.js";
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { isBuiltinExtensionsOnlyEnabled } from "../src/cli/main.js";

describe("MIXCODE_BUILTIN_EXTENSIONS_ONLY environment variable", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.MIXCODE_BUILTIN_EXTENSIONS_ONLY;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("is false when env is unset and cli flag is false", () => {
    assert.equal(isBuiltinExtensionsOnlyEnabled(false), false);
    assert.equal(isBuiltinExtensionsOnlyEnabled(undefined), false);
  });

  it("is true when cli flag is true regardless of env", () => {
    process.env.MIXCODE_BUILTIN_EXTENSIONS_ONLY = "0";
    assert.equal(isBuiltinExtensionsOnlyEnabled(true), true);
  });

  it("is true when env is '1', 'true', 'on', 'yes' (case-insensitive)", () => {
    for (const val of ["1", "true", "TRUE", "True", "on", "ON", "yes", "YES"]) {
      process.env.MIXCODE_BUILTIN_EXTENSIONS_ONLY = val;
      assert.equal(isBuiltinExtensionsOnlyEnabled(false), true, `Failed for value ${val}`);
    }
  });

  it("is false when env is '0', 'false', 'off', 'no', or empty string", () => {
    for (const val of ["0", "false", "FALSE", "off", "OFF", "no", "NO", "", "   "]) {
      process.env.MIXCODE_BUILTIN_EXTENSIONS_ONLY = val;
      assert.equal(isBuiltinExtensionsOnlyEnabled(false), false, `Failed for value ${val}`);
    }
  });
});
